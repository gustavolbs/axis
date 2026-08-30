import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, type LocalCoderConfig } from '../src/config.js';
import { hashWorkspaceContent } from '../src/remote-workspace.js';
import { withWorkerWorkspace } from '../src/worker-workspace.js';

async function run(command: string, args: string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${command} ${args.join(' ')} exited ${String(code)}: ${err}`));
    });
  });
}

function config(root: string): LocalCoderConfig {
  return {
    ...loadConfig({}),
    telemetryEnabled: false,
    telemetryPath: path.join(root, 'telemetry.jsonl'),
    runStorePath: path.join(root, 'runs'),
    contextIndexPath: path.join(root, 'indexes'),
    workerStatePath: path.join(root, 'worker-state'),
    workerAllowedGitHosts: new Set(),
    workerBootstrap: 'none',
    remoteWorkerTimeoutMs: 60_000,
    remoteMaxDeltaBytes: 1_000_000,
    maxFileBytes: 100_000
  };
}

test('worker reconstructs dirty source in disposable worktree and returns only task changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-worker-workspace-'));
  const source = path.join(root, 'source');
  try {
    await fs.mkdir(path.join(source, 'src'), { recursive: true });
    await run('git', ['init'], source);
    await run('git', ['config', 'user.email', 'test@example.com'], source);
    await run('git', ['config', 'user.name', 'Worker Test'], source);
    await fs.writeFile(path.join(source, 'src', 'value.ts'), 'export const value = 1;\n');
    await run('git', ['add', 'src/value.ts'], source);
    await run('git', ['commit', '-m', 'initial'], source);

    const baseSha = await run('git', ['rev-parse', 'HEAD'], source);
    await fs.writeFile(path.join(source, 'src', 'value.ts'), 'export const value = 2;\n');
    const dirtyPatch = await run('git', ['diff', '--binary', 'HEAD'], source);

    const snapshot = {
      repositoryUrl: source,
      baseSha,
      workspaceRelativePath: '',
      dirtyPatchBase64: Buffer.from(`${dirtyPatch}\n`, 'utf8').toString('base64'),
      untrackedFiles: [
        {
          path: 'src/untracked.ts',
          contentBase64: Buffer.from('export const localOnly = true;\n').toString('base64')
        }
      ],
      expectedFiles: [
        {
          path: 'src/value.ts',
          sha256: hashWorkspaceContent('export const value = 2;\n')
        }
      ]
    };

    const output = await withWorkerWorkspace(snapshot, config(root), async (workspace) => {
      assert.equal(
        await fs.readFile(path.join(workspace, 'src', 'value.ts'), 'utf8'),
        'export const value = 2;\n'
      );
      assert.equal(
        await fs.readFile(path.join(workspace, 'src', 'untracked.ts'), 'utf8'),
        'export const localOnly = true;\n'
      );
      await fs.writeFile(path.join(workspace, 'src', 'value.ts'), 'export const value = 3;\n');
      return { ok: true };
    });

    assert.deepEqual(output.result, { ok: true });
    assert.equal(output.changes.length, 1);
    assert.equal(output.changes[0]?.path, 'src/value.ts');
    assert.equal(
      Buffer.from(output.changes[0]!.contentBase64!, 'base64').toString('utf8'),
      'export const value = 3;\n'
    );
    assert.equal(
      await fs.readFile(path.join(source, 'src', 'value.ts'), 'utf8'),
      'export const value = 2;\n',
      'worker must never edit the source/control-plane repository directly'
    );

    const worktreesRoot = path.join(root, 'worker-state', 'worktrees');
    const worktrees = await fs.readdir(worktreesRoot).catch(() => [] as string[]);
    assert.deepEqual(worktrees, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
