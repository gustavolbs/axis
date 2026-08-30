import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LocalCoderConfig } from './config.js';
import type {
  RemoteExpectedFile,
  RemoteFileChange,
  RemoteWorkspaceSnapshot
} from './remote-protocol.js';
import {
  readWorkspaceFile,
  resolveWorkspace,
  resolveWorkspacePath,
  restoreWorkspaceFile,
  writeWorkspaceFile,
  type WorkspaceFileSnapshot
} from './workspace.js';

interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

function sha256(content: string | null): string | null {
  if (content === null) return null;
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function opaqueIsolationKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function toProtocolPath(value: string): string {
  return value.split(path.sep).join('/');
}

function fromProtocolPath(value: string): string {
  return value.split('/').join(path.sep);
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; input?: Buffer; timeoutMs?: number }
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
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
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? 60_000}ms.`));
    }, options.timeoutMs ?? 60_000);

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

async function runGit(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  const result = await runCommand('git', args, { cwd, input });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.toString('utf8').trim()}`
    );
  }
  return result.stdout;
}

async function findRepoRoot(workspace: string): Promise<string> {
  const output = await runGit(workspace, ['rev-parse', '--show-toplevel']);
  return await fs.realpath(output.toString('utf8').trim());
}

async function findGitCommonDir(repoRoot: string): Promise<string> {
  const raw = (await runGit(repoRoot, ['rev-parse', '--git-common-dir'])).toString('utf8').trim();
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  return await fs.realpath(absolute);
}

function isAllowedTransportPath(repoRoot: string, relativePath: string): boolean {
  try {
    resolveWorkspacePath(repoRoot, fromProtocolPath(relativePath));
    return true;
  } catch {
    return false;
  }
}

async function trackedDirtyPatch(repoRoot: string): Promise<Buffer> {
  const namesRaw = await runGit(repoRoot, ['diff', '--name-only', '-z', 'HEAD']);
  const names = namesRaw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((file) => isAllowedTransportPath(repoRoot, file));

  if (names.length === 0) return Buffer.alloc(0);
  if (names.length > 2_000) {
    throw new Error(`Remote workspace has ${names.length} tracked dirty files; maximum is 2000.`);
  }

  return await runGit(repoRoot, ['diff', '--binary', 'HEAD', '--', ...names]);
}

async function untrackedFiles(
  repoRoot: string,
  maxBytes: number
): Promise<{ files: RemoteWorkspaceSnapshot['untrackedFiles']; bytes: number }> {
  const raw = await runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  const names = raw.toString('utf8').split('\0').filter(Boolean);
  const files: RemoteWorkspaceSnapshot['untrackedFiles'] = [];
  let bytes = 0;

  for (const protocolPath of names) {
    if (!isAllowedTransportPath(repoRoot, protocolPath)) continue;
    const absolute = resolveWorkspacePath(repoRoot, fromProtocolPath(protocolPath));
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) continue;

    const content = await fs.readFile(absolute);
    bytes += content.byteLength;
    if (bytes > maxBytes) {
      throw new Error(
        `Remote workspace untracked payload exceeds ${maxBytes} bytes. Commit/ignore large generated files before remote execution.`
      );
    }

    files.push({ path: protocolPath, contentBase64: content.toString('base64') });
  }

  return { files, bytes };
}

async function expectedFiles(
  workspace: string,
  editableFiles: string[],
  config: LocalCoderConfig
): Promise<RemoteExpectedFile[]> {
  const output: RemoteExpectedFile[] = [];
  const seen = new Set<string>();

  for (const file of editableFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    const snapshot = await readWorkspaceFile(workspace, file, config.maxFileBytes);
    output.push({ path: file, sha256: sha256(snapshot.content) });
  }

  return output;
}

export async function prepareRemoteWorkspace(
  workspaceInput: string,
  editableFiles: string[],
  config: LocalCoderConfig
): Promise<RemoteWorkspaceSnapshot> {
  const workspace = await resolveWorkspace(workspaceInput);
  const repoRoot = await findRepoRoot(workspace);
  const gitCommonDir = await findGitCommonDir(repoRoot);
  const workspaceRelative = path.relative(repoRoot, workspace);
  if (workspaceRelative.startsWith('..') || path.isAbsolute(workspaceRelative)) {
    throw new Error('workspace is not contained by its Git repository root.');
  }

  const repositoryUrl = (await runGit(repoRoot, ['remote', 'get-url', 'origin']))
    .toString('utf8')
    .trim();
  if (!repositoryUrl) throw new Error('Git remote "origin" has no URL.');

  const baseSha = (await runGit(repoRoot, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  const patch = await trackedDirtyPatch(repoRoot);
  const untracked = await untrackedFiles(repoRoot, config.remoteMaxDeltaBytes);
  const totalDeltaBytes = patch.byteLength + untracked.bytes;
  if (totalDeltaBytes > config.remoteMaxDeltaBytes) {
    throw new Error(
      `Remote workspace delta is ${totalDeltaBytes} bytes; maximum is ${config.remoteMaxDeltaBytes}.`
    );
  }

  return {
    repositoryUrl,
    baseSha,
    workspaceRelativePath: toProtocolPath(workspaceRelative),
    dirtyPatchBase64: patch.toString('base64'),
    untrackedFiles: untracked.files,
    expectedFiles: await expectedFiles(workspace, editableFiles, config),
    // Concrete worktrees get different scheduling keys so mutable checkouts never overlap.
    isolationKey: opaqueIsolationKey(`${repoRoot}\n${workspace}`),
    // Linked worktrees share their Git common-dir, so they intentionally share learned
    // repo intelligence. A separate clone receives a different opaque key even when its
    // origin URL is identical, preventing cross-trust-context memory reuse.
    memoryScopeKey: opaqueIsolationKey(gitCommonDir)
  };
}

async function snapshotEditableFiles(
  workspace: string,
  changes: RemoteFileChange[],
  config: LocalCoderConfig
): Promise<Map<string, WorkspaceFileSnapshot>> {
  const snapshots = new Map<string, WorkspaceFileSnapshot>();
  for (const change of changes) {
    if (!snapshots.has(change.path)) {
      snapshots.set(
        change.path,
        await readWorkspaceFile(workspace, change.path, config.maxFileBytes)
      );
    }
  }
  return snapshots;
}

export async function applyRemoteChanges(
  workspaceInput: string,
  changes: RemoteFileChange[],
  config: LocalCoderConfig
): Promise<void> {
  if (changes.length === 0) return;
  const workspace = await resolveWorkspace(workspaceInput);
  const originals = await snapshotEditableFiles(workspace, changes, config);

  for (const change of changes) {
    const current = originals.get(change.path)!;
    const currentHash = sha256(current.content);
    if (currentHash !== change.beforeSha256) {
      throw new Error(
        `Remote apply conflict for ${change.path}: file changed after the remote run started. No remote changes were applied.`
      );
    }
  }

  try {
    for (const change of changes) {
      if (change.contentBase64 === null) {
        await restoreWorkspaceFile(workspace, { path: change.path, content: null });
        continue;
      }

      const content = Buffer.from(change.contentBase64, 'base64');
      if (content.byteLength > config.maxFileBytes) {
        throw new Error(`Remote result exceeds ${config.maxFileBytes} bytes: ${change.path}`);
      }
      await writeWorkspaceFile(workspace, change.path, content.toString('utf8'));
    }
  } catch (error) {
    for (const snapshot of originals.values()) {
      await restoreWorkspaceFile(workspace, snapshot);
    }
    throw error;
  }
}

export function hashWorkspaceContent(content: string | null): string | null {
  return sha256(content);
}
