import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readWorkspaceFile,
  resolveWorkspace,
  resolveWorkspacePath,
  restoreWorkspaceFile,
  writeWorkspaceFile
} from '../src/workspace.js';

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-mcp-'));
  try {
    await run(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test('resolveWorkspace requires an absolute directory', async () => {
  await assert.rejects(() => resolveWorkspace('relative/path'), /absolute path/);
});

test('resolveWorkspacePath blocks traversal and sensitive paths', async () => {
  await withWorkspace(async (workspace) => {
    assert.throws(() => resolveWorkspacePath(workspace, '../secret.txt'), /escapes workspace/);
    assert.throws(() => resolveWorkspacePath(workspace, '.git/config'), /blocked/);
    assert.throws(() => resolveWorkspacePath(workspace, '.env.local'), /blocked/);
    assert.equal(
      resolveWorkspacePath(workspace, 'src/index.ts'),
      path.join(workspace, 'src/index.ts')
    );
  });
});

test('write and restore preserve the invocation snapshot', async () => {
  await withWorkspace(async (workspace) => {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src/a.ts'), 'before\n');

    const snapshot = await readWorkspaceFile(workspace, 'src/a.ts', 10_000);
    await writeWorkspaceFile(workspace, 'src/a.ts', 'after\n');
    assert.equal(await fs.readFile(path.join(workspace, 'src/a.ts'), 'utf8'), 'after\n');

    await restoreWorkspaceFile(workspace, snapshot);
    assert.equal(await fs.readFile(path.join(workspace, 'src/a.ts'), 'utf8'), 'before\n');
  });
});

test('restore removes files that did not exist at invocation time', async () => {
  await withWorkspace(async (workspace) => {
    const snapshot = await readWorkspaceFile(workspace, 'src/new.ts', 10_000);
    assert.equal(snapshot.content, null);

    await writeWorkspaceFile(workspace, 'src/new.ts', 'new\n');
    await restoreWorkspaceFile(workspace, snapshot);

    await assert.rejects(() => fs.stat(path.join(workspace, 'src/new.ts')), { code: 'ENOENT' });
  });
});
