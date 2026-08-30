import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import { executeLocalCodePlan } from '../src/orchestrator.js';

function config(): LocalCoderConfig {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: 'fake-model',
    requestTimeoutMs: 5_000,
    validationTimeoutMs: 10_000,
    maxFileBytes: 100_000,
    maxContextBytes: 500_000,
    allowedValidationCommands: new Set(['npm', 'pnpm', 'yarn', 'bun']),
    telemetryEnabled: false,
    telemetryPath: path.join(os.tmpdir(), 'unused-local-coder-telemetry.jsonl'),
    runStorePath: path.join(os.tmpdir(), 'unused-local-coder-runs'),
    contextIndexPath: path.join(os.tmpdir(), 'unused-local-coder-indexes')
  };
}

test('rolls all plan edits back when final integration validation fails', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-final-validation-'));

  try {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src/value.ts'), 'export const value = 1;\n');
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } })
    );

    const model = {
      async chat() {
        return {
          content: JSON.stringify({
            summary: 'Implemented the bounded TypeScript change.',
            files: [{ path: 'src/value.ts', content: 'export const value = 2;\n' }]
          }),
          model: 'fake-model',
          doneReason: 'stop',
          promptTokens: 10,
          completionTokens: 5
        };
      }
    };

    const result = await executeLocalCodePlan(model, config(), {
      workspace,
      goal: 'Implement the already-planned bounded feature.',
      tasks: [
        {
          id: 'implementation',
          task: 'Update the TypeScript component value using the known implementation.',
          editableFiles: ['src/value.ts']
        }
      ],
      finalValidation: [{ command: 'npm', args: ['test'] }],
      rollbackPlanOnFailure: true
    });

    assert.equal(result.status, 'escalated');
    assert.equal(result.phase, 'final-validation');
    assert.equal(result.finalValidation[0]?.ok, false);
    assert.equal(result.rolledBack, true);
    assert.match(result.diff, /value = 2/);
    assert.equal(
      await fs.readFile(path.join(workspace, 'src/value.ts'), 'utf8'),
      'export const value = 1;\n'
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
