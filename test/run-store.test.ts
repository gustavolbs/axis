import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RunStore } from '../src/run-store.js';

test('stores a full run locally and fetches compact views lazily', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-runs-'));
  try {
    const store = new RunStore(directory);
    const result = {
      status: 'success',
      diff: '--- a\n+++ a\n+changed\n'.repeat(300),
      validation: [{ command: 'npm', args: ['test'], ok: true }]
    };
    const runId = await store.save('task', { status: 'success', changedFiles: 1 }, result);

    const summary = await store.read(runId, 'summary');
    assert.match(summary.content, /"status": "success"/);
    assert.equal(summary.truncated, false);

    const diff = await store.read(runId, 'diff', { maxChars: 1000 });
    assert.equal(diff.content.length, 1000);
    assert.equal(diff.truncated, true);
    assert.equal(diff.nextOffset, 1000);

    const validation = await store.read(runId, 'validation');
    assert.match(validation.content, /"command": "npm"/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('rejects invalid run ids', async () => {
  const store = new RunStore(path.join(os.tmpdir(), 'local-coder-runs-unused'));
  await assert.rejects(() => store.read('../escape', 'full'), /Invalid runId/);
});
