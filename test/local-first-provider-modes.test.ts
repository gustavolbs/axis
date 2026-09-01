import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseModelSelection } from '../src/app-runtime.js';
import { CredentialManager, CredentialProfileStore } from '../src/credential-store.js';
import type { ExecutionBackend } from '../src/execution-runtime.js';
import type { LocalEngineerResult } from '../src/local-engineer.js';
import { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import type { ProjectDefinition } from '../src/project-store.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth,
  ProviderKind
} from '../src/providers/types.js';
import { StandaloneJobManager, type StandaloneJobSnapshot } from '../src/standalone-job-manager.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

class FakeProvider implements InferenceProvider {
  readonly capabilities = capabilities;

  constructor(
    readonly id: string,
    readonly kind: ProviderKind,
    private readonly modelIds: string[]
  ) {}

  async listModels(): Promise<ModelDefinition[]> {
    return this.modelIds.map((id) => ({
      providerId: this.id,
      id,
      displayName: id,
      capabilities
    }));
  }

  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, ok: true, checkedAt: new Date().toISOString(), latencyMs: 1 };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    return {
      providerId: this.id,
      model: request.model,
      content: 'fake guidance',
      latencyMs: 1,
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
    };
  }
}

function project(): ProjectDefinition {
  return {
    id: 'provider-mode-project',
    name: 'Provider Mode Project',
    workspace: '/tmp/provider-mode-project',
    organizationId: 'provider-mode-org',
    defaultRoutingPolicy: 'balanced',
    defaultModel: { mode: 'local-first', modelId: 'qwen-local' },
    privacy: { cloudAllowed: true, allowedProviderIds: ['ollama', 'anthropic', 'openai'] },
    credentialProfileIds: {
      anthropic: 'anthropic-test',
      openai: 'openai-test'
    },
    budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
    repoIntelligenceScope: 'project',
    concurrency: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  };
}

async function providerRuntimeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-provider-modes-'));
  const profiles = new CredentialProfileStore(path.join(root, 'credentials.json'));
  profiles.upsert({
    id: 'anthropic-test',
    providerId: 'anthropic',
    label: 'Anthropic test',
    organizationId: 'provider-mode-org',
    secret: { backend: 'environment', id: 'LOCAL_CODER_TEST_ANTHROPIC_KEY' }
  });
  profiles.upsert({
    id: 'openai-test',
    providerId: 'openai',
    label: 'OpenAI test',
    organizationId: 'provider-mode-org',
    secret: { backend: 'environment', id: 'LOCAL_CODER_TEST_OPENAI_KEY' }
  });
  process.env.LOCAL_CODER_TEST_ANTHROPIC_KEY = 'anthropic-secret';
  process.env.LOCAL_CODER_TEST_OPENAI_KEY = 'openai-secret';

  const settings = new ProviderSettingsStore(path.join(root, 'providers.json'));
  settings.update('ollama', {
    defaultModelId: 'qwen-local',
    models: { 'qwen-local': { enabled: true, qualityScore: 80 } }
  });
  settings.update('anthropic', {
    defaultModelId: 'claude-test',
    models: { 'claude-test': { enabled: true, frontier: true, qualityScore: 98 } }
  });
  settings.update('openai', {
    defaultModelId: 'gpt-test',
    models: { 'gpt-test': { enabled: true, frontier: true, qualityScore: 97 } }
  });

  const runtime = new ProjectProviderRuntime({
    localProvider: new FakeProvider('ollama', 'local', ['qwen-local']),
    credentials: new CredentialManager(profiles),
    settings,
    cloudProviderFactories: {
      anthropic: () => new FakeProvider('anthropic', 'cloud', ['claude-test']),
      openai: () => new FakeProvider('openai', 'cloud', ['gpt-test'])
    }
  });
  return { root, runtime };
}

function result(
  status: LocalEngineerResult['status'],
  escalation?: LocalEngineerResult['escalation']
): LocalEngineerResult {
  return {
    status,
    phase: status === 'success' ? 'complete' : 'planning',
    workspace: '/tmp/provider-mode-project',
    goal: 'Implement a bounded improvement',
    summary: status === 'success' ? 'Done.' : 'Need one bounded answer.',
    investigation: { searchQueries: [], evidenceFiles: ['src/example.ts'], researchRequests: [] },
    repairRounds: 0,
    changedFiles: [],
    diff: '',
    validation: [],
    escalation,
    modelCalls: []
  };
}

async function waitFor(
  manager: StandaloneJobManager,
  id: string,
  predicate: (job: StandaloneJobSnapshot) => boolean
): Promise<StandaloneJobSnapshot> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = manager.get(id);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job ${id}.`);
}

test('desktop model selection parser accepts four-mode local-first payloads', () => {
  assert.deepEqual(parseModelSelection({ mode: 'local-first', modelId: 'qwen3.8:27b' }), {
    mode: 'local-first',
    modelId: 'qwen3.8:27b'
  });
  assert.deepEqual(parseModelSelection({ mode: 'explicit', providerId: 'anthropic', modelId: 'claude-test' }), {
    mode: 'explicit',
    providerId: 'anthropic',
    modelId: 'claude-test'
  });
  assert.deepEqual(parseModelSelection({ mode: 'explicit', providerId: 'openai', modelId: 'gpt-test' }), {
    mode: 'explicit',
    providerId: 'openai',
    modelId: 'gpt-test'
  });
});

test('local-first candidate catalog is Ollama-only even when stronger cloud models are configured', async () => {
  const { root, runtime } = await providerRuntimeFixture();
  try {
    const { candidates } = await runtime.routingCandidates(project(), {
      stage: 'planning',
      modelSelection: { mode: 'local-first', modelId: 'qwen-local' }
    });
    assert.deepEqual(
      candidates.map((candidate) => `${candidate.providerId}/${candidate.modelId}`),
      ['ollama/qwen-local']
    );
  } finally {
    delete process.env.LOCAL_CODER_TEST_ANTHROPIC_KEY;
    delete process.env.LOCAL_CODER_TEST_OPENAI_KEY;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('direct Claude and GPT selections exclude unrelated providers from fallback candidates', async () => {
  const { root, runtime } = await providerRuntimeFixture();
  try {
    const claude = await runtime.routingCandidates(project(), {
      stage: 'planning',
      modelSelection: { mode: 'explicit', providerId: 'anthropic', modelId: 'claude-test' }
    });
    assert.deepEqual(
      claude.candidates.map((candidate) => `${candidate.providerId}/${candidate.modelId}`),
      ['anthropic/claude-test']
    );

    const gpt = await runtime.routingCandidates(project(), {
      stage: 'review',
      modelSelection: { mode: 'explicit', providerId: 'openai', modelId: 'gpt-test' }
    });
    assert.deepEqual(
      gpt.candidates.map((candidate) => `${candidate.providerId}/${candidate.modelId}`),
      ['openai/gpt-test']
    );
  } finally {
    delete process.env.LOCAL_CODER_TEST_ANTHROPIC_KEY;
    delete process.env.LOCAL_CODER_TEST_OPENAI_KEY;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local-first escalation consults cloud once then resumes Ollama with bounded guidance', async () => {
  let engineerCalls = 0;
  let resumedGuidance = '';
  let consulted = 0;
  const escalation = {
    kind: 'review-failure' as const,
    reason: 'The local review cannot resolve one API contract safely.',
    questions: ['Which contract should be preserved?'],
    researchRequests: [],
    evidence: ['src/example.ts'],
    resumeWith: 'Resume the job with userGuidance containing the resolved decision or research evidence.' as const
  };
  const execution = {
    executeEngineer: async (input) => {
      engineerCalls += 1;
      if (engineerCalls === 1) return result('needs-guidance', escalation);
      resumedGuidance = input.userGuidance ?? '';
      return result('success');
    },
    prepareEscalation: async () => ({
      stage: 'review' as const,
      recommended: {
        providerId: 'anthropic',
        modelId: 'claude-test',
        supportsReasoning: true,
        reasoningEffort: 'high' as const
      },
      options: [
        { providerId: 'anthropic', modelId: 'claude-test', supportsReasoning: true },
        { providerId: 'openai', modelId: 'gpt-test', supportsReasoning: true }
      ],
      reasons: ['Claude is the strongest configured consultant for this review.']
    }),
    consultEscalation: async (_input, _escalation, choice) => {
      consulted += 1;
      assert.equal(choice.providerId, 'anthropic');
      assert.equal(choice.modelId, 'claude-test');
      return {
        providerId: 'anthropic',
        modelId: 'claude-test',
        reasoningEffort: 'high' as const,
        content: 'Preserve the existing public contract and change only the internal adapter.',
        latencyMs: 25,
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 }
      };
    }
  } satisfies Pick<ExecutionBackend, 'executeEngineer' | 'prepareEscalation' | 'consultEscalation'>;

  const manager = new StandaloneJobManager(execution);
  const created = manager.create({
    projectId: 'provider-mode-project',
    workspace: '/tmp/provider-mode-project',
    goal: 'Implement a bounded improvement',
    modelSelection: { mode: 'local-first', modelId: 'qwen-local' },
    reasoningEffort: 'high'
  });

  const waiting = await waitFor(manager, created.id, (job) => job.status === 'waiting-guidance');
  assert.equal(waiting.escalationPlan?.recommended?.providerId, 'anthropic');
  assert.equal(waiting.escalationPlan?.recommended?.modelId, 'claude-test');

  await manager.submitEscalation(created.id, {
    providerId: 'anthropic',
    modelId: 'claude-test',
    reasoningEffort: 'high'
  });
  const completed = await waitFor(manager, created.id, (job) => job.status === 'success');

  assert.equal(completed.status, 'success');
  assert.equal(consulted, 1);
  assert.equal(engineerCalls, 2);
  assert.match(resumedGuidance, /CLOUD ESCALATION GUIDANCE/);
  assert.match(resumedGuidance, /Provider: anthropic/);
  assert.match(resumedGuidance, /Model: claude-test/);
  assert.match(resumedGuidance, /Preserve the existing public contract/);
});
