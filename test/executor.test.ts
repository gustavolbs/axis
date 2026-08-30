import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import { executeAgenticCodeTask } from '../src/executor.js';
import type { OllamaGeneration } from '../src/ollama.js';

function config(overrides: Partial<LocalCoderConfig> = {}): LocalCoderConfig {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: 'fake-model',
    requestTimeoutMs: 5_000,
    validationTimeoutMs: 10_000,
    maxFileBytes: 100_000,
    maxContextBytes: 500_000,
    allowedValidationCommands: new Set(['npm', 'pnpm', 'yarn', 'bun']),
    ...overrides
  };
}

function generation(content: unknown): OllamaGeneration {
  return {
    content: JSON.stringify(content),
    model: 'fake-model',
    doneReason: 'stop',
    promptTokens: 10,
    completionTokens: 10
  };
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-executor-'));
  try {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src/value.ts'), 'export const value = 1;\n');
    await run(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test('executes a bounded edit and returns an invocation-scoped diff', async () => {
  await withWorkspace(async (workspace) => {
    const model = {
      async chat() {
        return generation({
          summary: 'Updated the value.',
          files: [{ path: 'src/value.ts', content: 'export const value = 2;\n' }]
        });
      }
    };

    const result = await executeAgenticCodeTask(model, config(), {
      workspace,
      task: 'Change value to 2.',
      editableFiles: ['src/value.ts'],
      maxAttempts: 1
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(result.changedFiles, ['src/value.ts']);
    assert.match(result.diff, /export const value = 2/);
    assert.equal(await fs.readFile(path.join(workspace, 'src/value.ts'), 'utf8'), 'export const value = 2;\n');
  });
});

test('retries locally when the first attempt produces no changes', async () => {
  await withWorkspace(async (workspace) => {
    let calls = 0;
    const model = {
      async chat() {
        calls += 1;
        return calls === 1
          ? generation({ summary: 'No-op.', files: [] })
          : generation({
              summary: 'Updated on retry.',
              files: [{ path: 'src/value.ts', content: 'export const value = 3;\n' }]
            });
      }
    };

    const result = await executeAgenticCodeTask(model, config(), {
      workspace,
      task: 'Change value to 3.',
      editableFiles: ['src/value.ts'],
      maxAttempts: 2
    });

    assert.equal(result.status, 'success');
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
  });
});

test('rolls back local edits when validation fails and execution escalates', async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } })
    );

    const model = {
      async chat() {
        return generation({
          summary: 'Changed value but validation will fail.',
          files: [{ path: 'src/value.ts', content: 'export const value = 4;\n' }]
        });
      }
    };

    const result = await executeAgenticCodeTask(model, config(), {
      workspace,
      task: 'Change value to 4.',
      editableFiles: ['src/value.ts'],
      validation: [{ command: 'npm', args: ['test'] }],
      maxAttempts: 1,
      rollbackOnFailure: true
    });

    assert.equal(result.status, 'escalated');
    assert.equal(result.rolledBack, true);
    assert.equal(result.validation[0]?.ok, false);
    assert.match(result.diff, /export const value = 4/);
    assert.equal(await fs.readFile(path.join(workspace, 'src/value.ts'), 'utf8'), 'export const value = 1;\n');
  });
});
