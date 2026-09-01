import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import type { OllamaGeneration } from '../src/ollama.js';
import { executePremiumLocalAgent } from '../src/premium-agent.js';

function config(stateRoot: string): LocalCoderConfig {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3.8:27b',
    strongModel: 'qwen3.8:27b',
    adaptiveModelsEnabled: false,
    ollamaNumCtx: 16_384,
    fastModelKeepAlive: '90s',
    strongModelKeepAlive: '30s',
    requestTimeoutMs: 5_000,
    validationTimeoutMs: 5_000,
    maxFileBytes: 100_000,
    maxContextBytes: 96_000,
    allowedValidationCommands: new Set(['npm', 'pnpm']),
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
    workerMaxConcurrentJobs: 1,
    researchEnabled: true,
  };
}

function generation(content: string): OllamaGeneration {
  return {
    content,
    model: 'qwen3.8:27b',
    doneReason: 'stop',
    promptTokens: 120,
    completionTokens: 80,
    totalDurationNs: 2_000_000
  };
}

async function withWorkspace(
  run: (workspace: string, stateRoot: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'premium-agent-test-'));
  const workspace = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  try {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --test' } }, null, 2)
    );
    await fs.writeFile(path.join(workspace, 'src', 'app.ts'), 'export const app = true;\n');
    await run(workspace, stateRoot);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('stops before mutation and asks a bounded material user decision when repository evidence cannot infer the preference', async () => {
  await withWorkspace(async (workspace, stateRoot) => {
    let calls = 0;
    const model = {
      async chat(): Promise<OllamaGeneration> {
        calls += 1;
        return generation(
          JSON.stringify({
            summary: 'The feature requires a durable UI composition strategy that this fixture does not establish.',
            confidence: 0.82,
            impactAreas: ['UI component composition'],
            affectedContracts: ['Rendered component structure'],
            testStrategy: ['Add component behavior tests after the choice is resolved.'],
            risks: ['Introducing a second design-system convention'],
            approach: ['Resolve the UI composition convention, then let the local planner decompose implementation.'],
            researchRequests: [],
            userDecisions: [
              {
                id: 'ui-system',
                question: 'Which UI composition strategy should this feature establish?',
                rationale: 'Neither option is established in the repository and the choice affects future maintenance.',
                options: [
                  {
                    id: 'tailwind',
                    label: 'Tailwind utilities',
                    tradeoff: 'Minimal abstraction, but more local composition code.'
                  },
                  {
                    id: 'shadcn',
                    label: 'shadcn/ui',
                    tradeoff: 'Reusable component primitives, but establishes an additional convention.'
                  }
                ],
                recommendedOptionId: 'tailwind',
                blocking: true
              }
            ]
          })
        );
      }
    };

    const output = await executePremiumLocalAgent(model as never, config(stateRoot), {
      workspace,
      goal: 'Implement a new settings dialog for the product.'
    });

    assert.equal(calls, 1, 'only the local impact-analysis call should run before the user decision');
    assert.equal(output.result.status, 'needs-guidance');
    assert.equal(output.result.phase, 'planning');
    const premium = output.result as typeof output.result & {
      decisionRequest?: { questions: Array<{ id: string; options: Array<{ id: string }> }> };
    };
    assert.equal(premium.decisionRequest?.questions[0]?.id, 'ui-system');
    assert.deepEqual(
      premium.decisionRequest?.questions[0]?.options.map((option) => option.id),
      ['tailwind', 'shadcn']
    );
    assert.deepEqual(output.result.changedFiles, []);
    assert.equal(output.changes.length, 0);
    assert.equal(
      await fs.readFile(path.join(workspace, 'src', 'app.ts'), 'utf8'),
      'export const app = true;\n'
    );
  });
});
