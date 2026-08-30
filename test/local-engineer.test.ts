import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import { executeLocalEngineer } from '../src/local-engineer.js';
import type { OllamaChatOptions, OllamaGeneration } from '../src/ollama.js';

function config(stateRoot: string): LocalCoderConfig {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3.6:35b-a3b-coding',
    strongModel: 'qwen3.6:35b-a3b-coding',
    adaptiveModelsEnabled: false,
    ollamaNumCtx: 16_384,
    fastModelKeepAlive: '90s',
    strongModelKeepAlive: '30s',
    requestTimeoutMs: 5_000,
    validationTimeoutMs: 5_000,
    maxFileBytes: 100_000,
    maxContextBytes: 96_000,
    allowedValidationCommands: new Set(['npm', 'pnpm', 'yarn', 'bun']),
    telemetryEnabled: false,
    telemetryPath: path.join(stateRoot, 'telemetry.jsonl'),
    runStorePath: path.join(stateRoot, 'runs'),
    contextIndexPath: path.join(stateRoot, 'indexes'),
    executionMode: 'local',
    remoteWorkerTimeoutMs: 20_000,
    remoteMaxDeltaBytes: 1_000_000,
    workerHost: '127.0.0.1',
    workerPort: 7337,
    workerStatePath: path.join(stateRoot, 'worker'),
    workerMaxBodyBytes: 2_000_000,
    workerAllowedGitHosts: new Set(['github.com']),
    workerBootstrap: 'none',
    workerMaxConcurrentJobs: 1
  };
}

function generation(content: string): OllamaGeneration {
  return {
    content,
    model: 'qwen3.6:35b-a3b-coding',
    doneReason: 'stop',
    promptTokens: 20,
    completionTokens: 10,
    totalDurationNs: 1_000_000
  };
}

class FakeModel {
  readonly calls: Array<{ system: string; runtime: OllamaChatOptions }> = [];

  constructor(private readonly responses: string[]) {}

  async chat(
    system: string,
    _user: string,
    _format?: 'json' | Record<string, unknown>,
    runtime: OllamaChatOptions = {}
  ): Promise<OllamaGeneration> {
    this.calls.push({ system, runtime });
    const content = this.responses.shift();
    if (content === undefined) throw new Error('Unexpected fake model call.');
    return generation(content);
  }
}

function investigation() {
  return JSON.stringify({
    summary: 'Inspect the exported value and its usages.',
    searchQueries: ['value'],
    fileHints: ['src/value.ts'],
    researchRequests: []
  });
}

function readyPlan() {
  return JSON.stringify({
    outcome: 'ready',
    summary: 'The change is bounded to the exported value.',
    analysis: 'Repository evidence shows the requested value is defined in src/value.ts.',
    confidence: 0.92,
    decisions: ['Update the existing export without changing its public name.'],
    unresolvedQuestions: [],
    researchRequests: [],
    riskTags: [],
    sensitiveDecisionRequired: false,
    validationScripts: [],
    tasks: [
      {
        id: 'update-value',
        task: 'Update the existing exported value from 1 to 2 without changing the export name.',
        dependsOn: [],
        editableFiles: ['src/value.ts'],
        contextFiles: ['src/value.ts'],
        constraints: []
      }
    ]
  });
}

function editProposal() {
  return JSON.stringify({
    summary: 'Updated the exported value.',
    files: [{ path: 'src/value.ts', content: 'export const value = 2;\n' }]
  });
}

function passingReview() {
  return JSON.stringify({
    verdict: 'pass',
    confidence: 0.94,
    summary: 'The diff matches the requested bounded change.',
    issues: [],
    repairTask: '',
    repairFiles: [],
    researchRequests: []
  });
}

async function withWorkspace(
  run: (workspace: string, stateRoot: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-engineer-test-'));
  const workspace = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  try {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src/value.ts'), 'export const value = 1;\n');
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ name: 'fixture', private: true }, null, 2)
    );
    await run(workspace, stateRoot);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('investigates, plans, codes and adversarially reviews a bounded goal locally', async () => {
  await withWorkspace(async (workspace, stateRoot) => {
    const model = new FakeModel([
      investigation(),
      readyPlan(),
      editProposal(),
      passingReview()
    ]);

    const output = await executeLocalEngineer(model as never, config(stateRoot), {
      workspace,
      goal: 'Change the exported value from 1 to 2.',
      maxRepairRounds: 1
    });

    assert.equal(output.result.status, 'success');
    assert.equal(output.result.phase, 'complete');
    assert.equal(output.result.plan?.tasks.length, 1);
    assert.equal(output.result.review?.verdict, 'pass');
    assert.deepEqual(output.result.changedFiles, ['src/value.ts']);
    assert.equal(output.changes.length, 1);
    assert.equal(
      await fs.readFile(path.join(workspace, 'src/value.ts'), 'utf8'),
      'export const value = 2;\n'
    );

    const reasoningCalls = model.calls.filter(
      (call) =>
        call.system.includes('investigation stage') ||
        call.system.includes('reasoning/planning stage') ||
        call.system.includes('adversarial software-engineering reviewer')
    );
    assert.equal(reasoningCalls.length, 3);
    assert.ok(reasoningCalls.every((call) => call.runtime.think === 'high'));
  });
});

test('returns a compact Claude research handoff before any mutation when planning cannot converge', async () => {
  await withWorkspace(async (workspace, stateRoot) => {
    const model = new FakeModel([
      investigation(),
      JSON.stringify({
        outcome: 'needs-claude',
        summary: 'Current external framework behavior must be confirmed.',
        analysis: 'Repository evidence alone cannot establish the current upstream contract.',
        confidence: 0.45,
        decisions: [],
        unresolvedQuestions: ['Which current upstream API contract should this repository target?'],
        researchRequests: ['Check the official upstream documentation for the current API contract.'],
        riskTags: [],
        sensitiveDecisionRequired: false,
        validationScripts: [],
        tasks: []
      })
    ]);

    const output = await executeLocalEngineer(model as never, config(stateRoot), {
      workspace,
      goal: 'Adopt the current upstream API in this module.'
    });

    assert.equal(output.result.status, 'needs-claude');
    assert.equal(output.result.phase, 'planning');
    assert.equal(output.result.escalation?.kind, 'external-research');
    assert.equal(output.changes.length, 0);
    assert.equal(
      await fs.readFile(path.join(workspace, 'src/value.ts'), 'utf8'),
      'export const value = 1;\n'
    );
  });
});

test('rolls implementation back when adversarial local review requires Claude', async () => {
  await withWorkspace(async (workspace, stateRoot) => {
    const model = new FakeModel([
      investigation(),
      readyPlan(),
      editProposal(),
      JSON.stringify({
        verdict: 'needs-claude',
        confidence: 0.4,
        summary: 'A product contract is ambiguous after implementation.',
        issues: [
          {
            severity: 'high',
            file: 'src/value.ts',
            description: 'The expected external contract is not represented in repository evidence.',
            fix: 'Resolve the expected contract before accepting the change.'
          }
        ],
        repairTask: '',
        repairFiles: [],
        researchRequests: ['Confirm the expected external contract.']
      })
    ]);

    const output = await executeLocalEngineer(model as never, config(stateRoot), {
      workspace,
      goal: 'Change the exported value from 1 to 2.',
      maxRepairRounds: 0
    });

    assert.equal(output.result.status, 'needs-claude');
    assert.equal(output.result.phase, 'review');
    assert.equal(output.result.escalation?.kind, 'external-research');
    assert.equal(output.changes.length, 0);
    assert.equal(
      await fs.readFile(path.join(workspace, 'src/value.ts'), 'utf8'),
      'export const value = 1;\n'
    );
  });
});
