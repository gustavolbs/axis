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
import { createDirectoryLink } from './fs-test-utils.js';

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
      resolveWorkspacePath(workspace, '.env.example'),
      path.join(workspace, '.env.example')
    );
    assert.equal(
      resolveWorkspacePath(workspace, 'src/index.ts'),
      path.join(workspace, 'src/index.ts')
    );
  });
});

test('read and write reject symlinks that resolve outside the workspace', async () => {
  await withWorkspace(async (workspace) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.ts'), 'secret\n');
      await createDirectoryLink(outside, path.join(workspace, 'linked'));

      await assert.rejects(
        () => readWorkspaceFile(workspace, 'linked/secret.ts', 10_000),
        /escapes workspace/
      );
      await assert.rejects(
        () => writeWorkspaceFile(workspace, 'linked/new.ts', 'nope\n'),
        /escapes workspace/
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('allows a workspace path whose own path resolves through a symlink', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-alias-'));
  const realWorkspace = path.join(parent, 'real-workspace');
  const workspaceAlias = path.join(parent, 'workspace-alias');

  try {
    await fs.mkdir(path.join(realWorkspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(realWorkspace, 'src/a.ts'), 'before\n');
    await createDirectoryLink(realWorkspace, workspaceAlias);

    const snapshot = await readWorkspaceFile(workspaceAlias, 'src/a.ts', 10_000);
    assert.equal(snapshot.content, 'before\n');

    await writeWorkspaceFile(workspaceAlias, 'src/a.ts', 'after\n');
    assert.equal(await fs.readFile(path.join(realWorkspace, 'src/a.ts'), 'utf8'), 'after\n');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
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
