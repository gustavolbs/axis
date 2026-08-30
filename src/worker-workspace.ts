import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LocalCoderConfig } from './config.js';
import type {
  RemoteFileChange,
  RemoteWorkspaceSnapshot
} from './remote-protocol.js';
import { hashWorkspaceContent } from './remote-workspace.js';
import { readWorkspaceFile, resolveWorkspacePath } from './workspace.js';

interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

function fromProtocolPath(value: string): string {
  return value.split('/').join(path.sep);
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; input?: Buffer; timeoutMs?: number }
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? 300_000}ms.`));
    }, options.timeoutMs ?? 300_000);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code ?? -1
      });
    });

    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function runChecked(
  command: string,
  args: string[],
  options: { cwd?: string; input?: Buffer; timeoutMs?: number } = {}
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0) {
    const output = result.stderr.toString('utf8').trim().slice(-6000);
    throw new Error(`${command} ${args.join(' ')} failed (${result.exitCode}): ${output}`);
  }
  return result;
}

function repositoryHost(repositoryUrl: string): string | undefined {
  try {
    const parsed = new URL(repositoryUrl);
    return parsed.hostname.toLowerCase();
  } catch {
    const scp = repositoryUrl.match(/^[^@\s]+@([^:\s]+):.+$/);
    return scp?.[1]?.toLowerCase();
  }
}

function assertRepositoryAllowed(repositoryUrl: string, allowedHosts: Set<string>): void {
  if (!repositoryUrl || repositoryUrl.startsWith('-')) {
    throw new Error('Invalid repository URL for remote worker.');
  }
  if (allowedHosts.size === 0) return;

  const host = repositoryHost(repositoryUrl);
  if (!host || !allowedHosts.has(host)) {
    throw new Error(
      `Repository host ${host ?? '[local/unknown]'} is not allowed by LOCAL_CODER_WORKER_ALLOWED_GIT_HOSTS.`
    );
  }
}

function repoCacheKey(repositoryUrl: string): string {
  return createHash('sha256').update(repositoryUrl).digest('hex').slice(0, 32);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function ensureMirror(
  repositoryUrl: string,
  mirrorPath: string,
  config: LocalCoderConfig
): Promise<void> {
  assertRepositoryAllowed(repositoryUrl, config.workerAllowedGitHosts);
  await fs.mkdir(path.dirname(mirrorPath), { recursive: true });

  if (!(await pathExists(mirrorPath))) {
    await runChecked('git', ['clone', '--mirror', repositoryUrl, mirrorPath], {
      timeoutMs: config.remoteWorkerTimeoutMs
    });
    return;
  }

  await runChecked('git', [`--git-dir=${mirrorPath}`, 'fetch', '--prune', 'origin'], {
    timeoutMs: config.remoteWorkerTimeoutMs
  });
}

async function createWorktree(
  mirrorPath: string,
  worktreePath: string,
  baseSha: string,
  timeoutMs: number
): Promise<void> {
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await runChecked(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      `--git-dir=${mirrorPath}`,
      'worktree',
      'add',
      '--detach',
      worktreePath,
      baseSha
    ],
    { timeoutMs }
  );
}

async function applyWorkspaceDelta(
  worktreePath: string,
  snapshot: RemoteWorkspaceSnapshot,
  config: LocalCoderConfig
): Promise<void> {
  if (snapshot.dirtyPatchBase64) {
    const patch = Buffer.from(snapshot.dirtyPatchBase64, 'base64');
    if (patch.byteLength > config.remoteMaxDeltaBytes) {
      throw new Error(`Tracked workspace patch exceeds ${config.remoteMaxDeltaBytes} bytes.`);
    }
    if (patch.byteLength > 0) {
      await runChecked(
        'git',
        ['-C', worktreePath, '-c', 'core.autocrlf=false', 'apply', '--binary', '--whitespace=nowarn', '-'],
        { input: patch, timeoutMs: config.remoteWorkerTimeoutMs }
      );
    }
  }

  let untrackedBytes = 0;
  for (const file of snapshot.untrackedFiles) {
    const relative = fromProtocolPath(file.path);
    const absolute = resolveWorkspacePath(worktreePath, relative);
    const content = Buffer.from(file.contentBase64, 'base64');
    untrackedBytes += content.byteLength;
    if (untrackedBytes > config.remoteMaxDeltaBytes) {
      throw new Error(`Untracked workspace payload exceeds ${config.remoteMaxDeltaBytes} bytes.`);
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
}

async function bootstrapWorkspace(worktreePath: string, config: LocalCoderConfig): Promise<void> {
  if (config.workerBootstrap === 'none') return;

  const choices: Array<{ file: string; command: string; args: string[] }> = [
    { file: 'pnpm-lock.yaml', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
    { file: 'yarn.lock', command: 'yarn', args: ['install', '--frozen-lockfile'] },
    { file: 'bun.lock', command: 'bun', args: ['install', '--frozen-lockfile'] },
    { file: 'bun.lockb', command: 'bun', args: ['install', '--frozen-lockfile'] },
    { file: 'package-lock.json', command: 'npm', args: ['ci'] }
  ];

  for (const choice of choices) {
    if (await pathExists(path.join(worktreePath, choice.file))) {
      await runChecked(choice.command, choice.args, {
        cwd: worktreePath,
        timeoutMs: config.remoteWorkerTimeoutMs
      });
      return;
    }
  }

  if (await pathExists(path.join(worktreePath, 'package.json'))) {
    await runChecked('npm', ['install'], {
      cwd: worktreePath,
      timeoutMs: config.remoteWorkerTimeoutMs
    });
  }
}

async function verifyExpectedFiles(
  workspace: string,
  snapshot: RemoteWorkspaceSnapshot,
  config: LocalCoderConfig
): Promise<void> {
  for (const expected of snapshot.expectedFiles) {
    const current = await readWorkspaceFile(workspace, expected.path, config.maxFileBytes);
    if (hashWorkspaceContent(current.content) !== expected.sha256) {
      throw new Error(
        `Remote workspace reconstruction mismatch for ${expected.path}. Refusing to execute against a different source state.`
      );
    }
  }
}

async function collectChanges(
  workspace: string,
  snapshot: RemoteWorkspaceSnapshot,
  config: LocalCoderConfig
): Promise<RemoteFileChange[]> {
  const changes: RemoteFileChange[] = [];

  for (const expected of snapshot.expectedFiles) {
    const current = await readWorkspaceFile(workspace, expected.path, config.maxFileBytes);
    const currentHash = hashWorkspaceContent(current.content);
    if (currentHash === expected.sha256) continue;

    changes.push({
      path: expected.path,
      beforeSha256: expected.sha256,
      contentBase64:
        current.content === null ? null : Buffer.from(current.content, 'utf8').toString('base64')
    });
  }

  return changes;
}

async function cleanupWorktree(mirrorPath: string, worktreePath: string): Promise<void> {
  try {
    await runProcess('git', [`--git-dir=${mirrorPath}`, 'worktree', 'remove', '--force', worktreePath], {
      timeoutMs: 60_000
    });
  } finally {
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await runProcess('git', [`--git-dir=${mirrorPath}`, 'worktree', 'prune'], {
      timeoutMs: 60_000
    }).catch(() => undefined);
  }
}

export async function withWorkerWorkspace<T>(
  snapshot: RemoteWorkspaceSnapshot,
  config: LocalCoderConfig,
  run: (workspace: string) => Promise<T>
): Promise<{ result: T; changes: RemoteFileChange[] }> {
  const repoKey = repoCacheKey(snapshot.repositoryUrl);
  const mirrorPath = path.join(config.workerStatePath, 'repos', `${repoKey}.git`);
  const runId = randomUUID();
  const worktreePath = path.join(config.workerStatePath, 'worktrees', runId);

  await ensureMirror(snapshot.repositoryUrl, mirrorPath, config);
  await createWorktree(mirrorPath, worktreePath, snapshot.baseSha, config.remoteWorkerTimeoutMs);

  try {
    await applyWorkspaceDelta(worktreePath, snapshot, config);
    const relativeWorkspace = snapshot.workspaceRelativePath
      ? fromProtocolPath(snapshot.workspaceRelativePath)
      : '';
    const workspace = relativeWorkspace
      ? resolveWorkspacePath(worktreePath, relativeWorkspace)
      : worktreePath;
    const stat = await fs.stat(workspace);
    if (!stat.isDirectory()) throw new Error(`Remote workspace is not a directory: ${workspace}`);

    await verifyExpectedFiles(workspace, snapshot, config);
    await bootstrapWorkspace(worktreePath, config);
    const result = await run(workspace);
    const changes = await collectChanges(workspace, snapshot, config);
    return { result, changes };
  } finally {
    await cleanupWorktree(mirrorPath, worktreePath);
  }
}
