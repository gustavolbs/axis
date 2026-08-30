import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runValidationCommand } from '../src/validation.js';

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-validation-'));
  try {
    await run(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test('rejects validation executables outside the allowlist', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      () => runValidationCommand(workspace, { command: 'sh', args: ['-c', 'echo nope'] }, new Set(['npm']), 1_000),
      /not allowed/
    );
  });
});

test('rejects unsafe package-manager subcommands', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      () => runValidationCommand(workspace, { command: 'npm', args: ['install'] }, new Set(['npm']), 1_000),
      /Unsafe npm validation invocation/
    );
  });
});

test('runs allowlisted package scripts without a shell', async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "console.log(\'ok\')"' } })
    );

    const result = await runValidationCommand(
      workspace,
      { command: 'npm', args: ['test'] },
      new Set(['npm']),
      10_000
    );

    assert.equal(result.ok, true);
    assert.match(result.output, /ok/);
  });
});
