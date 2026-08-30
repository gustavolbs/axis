import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import { executeLocalCodePlan } from '../src/orchestrator.js';
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
    telemetryEnabled: false,
    telemetryPath: path.join(os.tmpdir(), 'unused-local-coder-telemetry.jsonl'),
    ...overrides
  };
}

function generation(content: unknown): OllamaGeneration {
  return {
    content: JSON.stringify(content),
    model: 'fake-model',
    doneReason: 'stop',
    promptTokens: 10,
    completionTokens: 5,
    totalDurationNs: 1_000_000
  };
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-plan-'));
  try {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src/a.ts'), 'export const a = 1;\n');
    await fs.writeFile(path.join(workspace, 'src/b.ts'), 'export const b = 1;\n');
    await run(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test('executes Claude-decomposed tasks in dependency order and returns one plan diff', async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(
      path.join(workspace, 'verify.cjs'),
      [
        "const fs = require('fs');",
        "const a = fs.readFileSync('src/a.ts', 'utf8');",
        "const b = fs.readFileSync('src/b.ts', 'utf8');",
        "process.exit(a.includes('a = 2') && b.includes('b = 2') ? 0 : 1);"
      ].join('\n')
    );
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'node verify.cjs' } })
    );

    let calls = 0;
    const model = {
      async chat() {
        calls += 1;
        return calls === 1
          ? generation({
              summary: 'Updated A.',
              files: [{ path: 'src/a.ts', content: 'export const a = 2;\n' }]
            })
          : generation({
              summary: 'Updated B.',
              files: [{ path: 'src/b.ts', content: 'export const b = 2;\n' }]
            });
      }
    };

    const result = await executeLocalCodePlan(model, config(), {
      workspace,
      goal: 'Implement the planned two-part bounded feature.',
      tasks: [
        {
          id: 'b',
          task: 'Update the TypeScript component value B using the decided implementation.',
          dependsOn: ['a'],
          editableFiles: ['src/b.ts']
        },
        {
          id: 'a',
          task: 'Update the TypeScript component value A using the decided implementation.',
          editableFiles: ['src/a.ts']
        }
      ],
      finalValidation: [{ command: 'npm', args: ['test'] }]
    });

    assert.equal(result.status, 'success');
    assert.equal(result.phase, 'complete');
    assert.deepEqual(result.taskOrder, ['a', 'b']);
    assert.equal(result.taskResults.length, 2);
    assert.equal(result.finalValidation[0]?.ok, true);
    assert.deepEqual(result.changedFiles.sort(), ['src/a.ts', 'src/b.ts']);
    assert.match(result.diff, /a = 2/);
    assert.match(result.diff, /b = 2/);
    assert.equal(result.totals.completedTasks, 2);
    assert.equal(result.totals.promptTokens, 20);
    assert.equal(calls, 2);
  });
});

test('preflight escalates tasks that still require architecture without calling the local model', async () => {
  await withWorkspace(async (workspace) => {
    let calls = 0;
    const model = {
      async chat() {
        calls += 1;
        return generation({ summary: 'Should not run.', files: [] });
      }
    };

    const result = await executeLocalCodePlan(model, config(), {
      workspace,
      goal: 'Redesign authentication architecture.',
      tasks: [
        {
          id: 'architecture',
          task: 'Design and implement the authentication architecture.',
          editableFiles: ['src/a.ts'],
          routing: {
            solutionKnown: false,
            requiresArchitecture: true,
            riskTags: ['auth']
          }
        }
      ]
    });

    assert.equal(result.status, 'escalated');
    assert.equal(result.phase, 'preflight');
    assert.equal(result.taskResults.length, 0);
    assert.ok(result.blockers.some((blocker) => blocker.includes('must stay in Claude')));
    assert.equal(calls, 0);
    assert.equal(await fs.readFile(path.join(workspace, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  });
});

test('rolls the whole plan back when a later subtask escalates', async () => {
  await withWorkspace(async (workspace) => {
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } })
    );

    let calls = 0;
    const model = {
      async chat() {
        calls += 1;
        return calls === 1
          ? generation({
              summary: 'First task succeeded.',
              files: [{ path: 'src/a.ts', content: 'export const a = 2;\n' }]
            })
          : generation({
              summary: 'Second task fails validation.',
              files: [{ path: 'src/b.ts', content: 'export const b = 2;\n' }]
            });
      }
    };

    const result = await executeLocalCodePlan(model, config(), {
      workspace,
      goal: 'Implement two bounded TypeScript updates.',
      tasks: [
        {
          id: 'first',
          task: 'Update the TypeScript component A with the known implementation.',
          editableFiles: ['src/a.ts']
        },
        {
          id: 'second',
          task: 'Update the TypeScript component B with the known implementation.',
          dependsOn: ['first'],
          editableFiles: ['src/b.ts'],
          validation: [{ command: 'npm', args: ['test'] }],
          maxAttempts: 1
        }
      ],
      rollbackPlanOnFailure: true
    });

    assert.equal(result.status, 'escalated');
    assert.equal(result.phase, 'execution');
    assert.equal(result.failedTaskId, 'second');
    assert.equal(result.rolledBack, true);
    assert.equal(result.taskResults.length, 2);
    assert.match(result.diff, /a = 2/);
    assert.equal(await fs.readFile(path.join(workspace, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.equal(await fs.readFile(path.join(workspace, 'src/b.ts'), 'utf8'), 'export const b = 1;\n');
  });
});

test('rejects dependency cycles before modifying the workspace', async () => {
  await withWorkspace(async (workspace) => {
    const model = {
      async chat() {
        return generation({ summary: 'Should not run.', files: [] });
      }
    };

    await assert.rejects(
      () =>
        executeLocalCodePlan(model, config(), {
          workspace,
          goal: 'Cyclic plan.',
          tasks: [
            {
              id: 'a',
              task: 'Update TypeScript component A.',
              dependsOn: ['b'],
              editableFiles: ['src/a.ts']
            },
            {
              id: 'b',
              task: 'Update TypeScript component B.',
              dependsOn: ['a'],
              editableFiles: ['src/b.ts']
            }
          ]
        }),
      /dependency cycle/
    );
  });
});
