import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverWorkspace, searchWorkspace } from '../src/discovery.js';
import { createDirectoryLink } from './fs-test-utils.js';

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-discovery-'));
  try {
    await run(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test('discovers bounded source files and package metadata while skipping generated directories', async () => {
  await withWorkspace(async (workspace) => {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'node_modules', 'ignored'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src', 'index.ts'), 'export const marker = "needle";\n');
    await fs.writeFile(path.join(workspace, 'node_modules', 'ignored', 'index.ts'), 'needle\n');
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { test: 'vitest', typecheck: 'tsc' } })
    );
    await fs.writeFile(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const result = await discoverWorkspace(workspace, { maxDepth: 4, maxEntries: 100 });
    assert.ok(result.files.includes('src/index.ts'));
    assert.ok(result.files.includes('package.json'));
    assert.ok(!result.files.some((file) => file.includes('node_modules')));
    assert.equal(result.packageManager, 'pnpm');
    assert.deepEqual(result.packageScripts, ['test', 'typecheck']);
  });
});

test('searches text files literally and returns line previews', async () => {
  await withWorkspace(async (workspace) => {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src', 'a.ts'), 'alpha\nNeedle value\nomega\n');
    await fs.writeFile(path.join(workspace, 'src', 'b.ts'), 'nothing here\n');

    const result = await searchWorkspace(workspace, 'needle', {
      extensions: ['ts'],
      maxResults: 10,
      maxFiles: 20
    });

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].path, 'src/a.ts');
    assert.equal(result.matches[0].line, 2);
    assert.equal(result.matches[0].preview, 'Needle value');
  });
});

test('does not follow directory symlinks during discovery', async () => {
  await withWorkspace(async (workspace) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-discovery-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.ts'), 'secret needle\n');
      await createDirectoryLink(outside, path.join(workspace, 'linked'));

      const result = await discoverWorkspace(workspace, { maxDepth: 4, maxEntries: 100 });
      assert.ok(!result.files.some((file) => file.startsWith('linked')));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
