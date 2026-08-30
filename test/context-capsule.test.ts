import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import { prepareContextCapsule, RepoIndexStore } from '../src/context-capsule.js';

function config(): LocalCoderConfig {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: 'fake-model',
    requestTimeoutMs: 5_000,
    validationTimeoutMs: 5_000,
    maxFileBytes: 100_000,
    maxContextBytes: 500_000,
    allowedValidationCommands: new Set(['npm']),
    telemetryEnabled: false,
    telemetryPath: path.join(os.tmpdir(), 'unused-telemetry.jsonl'),
    runStorePath: path.join(os.tmpdir(), 'unused-local-coder-runs'),
    contextIndexPath: path.join(os.tmpdir(), 'unused-local-coder-indexes')
  };
}

test('builds ranked file:line context and reuses unchanged index entries', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-context-'));
  const indexDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-index-'));

  try {
    await fs.mkdir(path.join(workspace, 'src', 'analytics'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'src', 'analytics', 'Dashboard.tsx'),
      [
        "import { Spinner } from '../../ui/Spinner';",
        'export function Dashboard() {',
        '  const isLoading = true;',
        '  return isLoading ? <Spinner /> : <main>Analytics</main>;',
        '}'
      ].join('\n')
    );
    await fs.writeFile(
      path.join(workspace, 'src', 'analytics', 'Dashboard.test.tsx'),
      "test('shows analytics dashboard', () => {});\n"
    );
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc --noEmit' } })
    );

    const store = new RepoIndexStore(indexDirectory);
    const first = await prepareContextCapsule(store, config(), {
      workspace,
      task: 'Add a loading state to the analytics Dashboard using Spinner.',
      maxFiles: 4
    });

    assert.equal(first.packageManager, undefined);
    assert.deepEqual(first.validationCandidates, ['test', 'typecheck']);
    assert.equal(first.relevantFiles[0]?.path, path.join('src', 'analytics', 'Dashboard.tsx'));
    assert.ok(first.relevantFiles[0]?.evidence.some((item) => item.startLine >= 1));
    assert.match(first.relevantFiles[0]?.evidence[0]?.content ?? '', /Dashboard|Spinner|Loading/i);

    const second = await prepareContextCapsule(store, config(), {
      workspace,
      task: 'Add a loading state to the analytics Dashboard using Spinner.',
      maxFiles: 4
    });
    assert.ok(second.indexReusedFiles >= 2);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(indexDirectory, { recursive: true, force: true });
  }
});
