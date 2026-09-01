import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import {
  executePremiumLocalEngineer,
  isReadOnlyEngineerRequest
} from '../src/premium-engineer.js';
import type { OllamaChatOptions, OllamaGeneration } from '../src/ollama.js';

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
    workerMaxConcurrentJobs: 1
  };
}

function generation(content: string): OllamaGeneration {
  return {
    content,
    model: 'qwen3.8:27b',
    doneReason: 'stop',
    promptTokens: 100,
    completionTokens: 50,
    totalDurationNs: 1_000_000
  };
}

class FakeModel {
  readonly calls: Array<{ system: string; user: string; runtime: OllamaChatOptions }> = [];

  constructor(private readonly responses: string[]) {}

  async chat(
    system: string,
    user: string,
    _format?: 'json' | Record<string, unknown>,
    runtime: OllamaChatOptions = {}
  ): Promise<OllamaGeneration> {
    this.calls.push({ system, user, runtime });
    const content = this.responses.shift();
    if (content === undefined) throw new Error('Unexpected fake model call.');
    return generation(content);
  }
}

async function withWorkspace(
  run: (workspace: string, stateRoot: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-premium-'));
  const workspace = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  try {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'src', 'microsoft.ts'),
      [
        "export const scopes = ['Calendars.Read', 'User.Read'];",
        "export const callback = 'http://127.0.0.1:53682/callback';"
      ].join('\n') + '\n'
    );
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --test' } }, null, 2)
    );
    await run(workspace, stateRoot);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('recognizes explicit Portuguese and English read-only constraints', () => {
  assert.equal(
    isReadOnlyEngineerRequest({ workspace: '.', goal: 'Investigação read-only: NÃO alterar código.' }),
    true
  );
  assert.equal(
    isReadOnlyEngineerRequest({ workspace: '.', goal: 'Document the auth flow; do not modify files.' }),
    true
  );
  assert.equal(
    isReadOnlyEngineerRequest({ workspace: '.', goal: 'Implement Microsoft calendar support.' }),
    false
  );
});

test('short-circuits before planning when read-only investigation needs external research', async () => {
  await withWorkspace(async (workspace, stateRoot) => {
    const model = new FakeModel([
      JSON.stringify({
        summary: 'Repository auth flow is identifiable, but tenant consent policy is external.',
        searchQueries: ['Calendars.Read', 'callback'],
        fileHints: ['src/microsoft.ts'],
        researchRequests: [
          'Verify current Microsoft Entra user-consent behavior for enterprise tenants when the user is not an admin.'
        ]
      })
    ]);

    const before = await fs.readFile(path.join(workspace, 'src', 'microsoft.ts'), 'utf8');
    const output = await executePremiumLocalEngineer(model as never, config(stateRoot), {
      workspace,
      goal: 'Investigação read-only (NÃO alterar código): documente como conectar Microsoft 365 Calendar.'
    });

    assert.equal(output.result.status, 'needs-guidance');
    assert.equal(output.result.phase, 'investigation');
    assert.equal(output.result.escalation?.kind, 'external-research');
    assert.equal(model.calls.length, 1, 'the implementation planner must not run');
    assert.equal(output.changes.length, 0);
    assert.equal(
      await fs.readFile(path.join(workspace, 'src', 'microsoft.ts'), 'utf8'),
      before
    );
  });
});

test('produces a final local report without entering implementation when repository evidence is sufficient', async () => {
  await withWorkspace(async (workspace, stateRoot) => {
    const model = new FakeModel([
      JSON.stringify({
        summary: 'Inspect exact calendar scopes and callback configuration.',
        searchQueries: ['Calendars.Read', 'callback'],
        fileHints: ['src/microsoft.ts'],
        researchRequests: []
      }),
      JSON.stringify({
        summary: 'The repository requests delegated calendar access and uses a loopback callback.',
        confidence: 0.96,
        findings: [
          {
            claim: 'Calendar access includes Calendars.Read.',
            evidence: ['src/microsoft.ts:1-1']
          },
          {
            claim: 'The callback is loopback on port 53682.',
            evidence: ['src/microsoft.ts:2-2']
          }
        ],
        userActions: ['Run the repository connection command and complete the browser sign-in flow.'],
        constraints: ['No source files need to be changed.'],
        unresolvedQuestions: [],
        researchRequests: []
      })
    ]);

    const output = await executePremiumLocalEngineer(model as never, config(stateRoot), {
      workspace,
      goal: 'Read-only: document the existing Microsoft calendar connection. Do not modify code.'
    });

    assert.equal(output.result.status, 'success');
    assert.equal(output.result.phase, 'complete');
    assert.equal(model.calls.length, 2);
    assert.match(model.calls[1]!.system, /read-only repository research reporter/i);
    assert.match(output.result.summary, /Calendars\.Read/);
    assert.deepEqual(output.result.changedFiles, []);
    assert.equal(output.changes.length, 0);
  });
});

test('resolves missing tail-of-file evidence locally instead of escalating it as external research', async () => {
  await withWorkspace(async (workspace, stateRoot) => {
    const filler = Array.from({ length: 420 }, (_, index) => `// filler ${index}`).join('\n');
    await fs.writeFile(
      path.join(workspace, 'src', 'microsoft.ts'),
      `${filler}\nexport async function completeAuthorization() {\n  return fetch('https://graph.microsoft.com/v1.0/me/calendarView');\n}\n`,
      'utf8'
    );

    const model = new FakeModel([
      JSON.stringify({
        summary: 'The calendar endpoint is implemented later in the provider file.',
        searchQueries: ['completeAuthorization'],
        fileHints: ['src/microsoft.ts'],
        researchRequests: [
          'Read the rest of src/microsoft.ts around `completeAuthorization` to identify the Graph endpoint.'
        ]
      }),
      JSON.stringify({
        summary: 'The local provider calls Microsoft Graph calendarView.',
        confidence: 0.98,
        findings: [
          {
            claim: 'The provider calls /v1.0/me/calendarView.',
            evidence: ['src/microsoft.ts']
          }
        ],
        userActions: [],
        constraints: [],
        unresolvedQuestions: [],
        researchRequests: []
      })
    ]);

    const output = await executePremiumLocalEngineer(model as never, config(stateRoot), {
      workspace,
      goal: 'Read-only: identify the Microsoft Graph calendar endpoint. Do not modify code.'
    });

    assert.equal(output.result.status, 'success');
    assert.equal(output.result.escalation, undefined);
    assert.equal(model.calls.length, 2, 'local evidence completion must not add an external handoff');
    assert.match(model.calls[1]!.user, /graph\.microsoft\.com\/v1\.0\/me\/calendarView/);
    assert.match(output.result.summary, /calendarView/);
  });
});
