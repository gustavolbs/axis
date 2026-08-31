import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RoutingConstraintError,
  routeCognitiveStage,
  type RoutingCandidate
} from '../src/cognitive-router.js';
import type { ProjectDefinition } from '../src/project-store.js';
import {
  FallbackConfirmationRequired,
  RoutedInferenceRuntime
} from '../src/routed-inference.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import {
  ProviderError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelDefinition,
  type ProviderCapabilities,
  type ProviderHealth,
  type ProviderKind
} from '../src/providers/types.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: true,
  toolUse: true
};

class FakeProvider implements InferenceProvider {
  calls: InferenceRequest[] = [];

  constructor(
    readonly id: string,
    readonly kind: ProviderKind,
    private readonly modelId: string,
    private readonly handler: (request: InferenceRequest) => Promise<InferenceResult>
  ) {}

  readonly capabilities = capabilities;

  async listModels(): Promise<ModelDefinition[]> {
    return [{
      providerId: this.id,
      id: this.modelId,
      displayName: this.modelId,
      capabilities
    }];
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      modelsAvailable: 1
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    this.calls.push(request);
    return await this.handler(request);
  }
}

function ok(providerId: string, model: string, content = 'ok'): InferenceResult {
  return {
    providerId,
    model,
    content,
    latencyMs: 10,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
  };
}

function project(overrides: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return {
    id: 'company-a',
    name: 'Company A',
    workspace: '/repo/company-a',
    organizationId: 'company-a',
    defaultRoutingPolicy: 'balanced',
    defaultModel: { mode: 'auto' },
    privacy: { cloudAllowed: true, allowedProviderIds: ['ollama', 'anthropic', 'openai'] },
    credentialProfileIds: {},
    budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
    repoIntelligenceScope: 'project',
    concurrency: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

function localCandidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    providerId: 'ollama',
    modelId: 'qwen-local',
    providerKind: 'local',
    available: true,
    capabilities,
    qualityScore: 72,
    p50LatencyMs: 12 * 60_000,
    queueDelayMs: 0,
    estimatedCostUsd: 0,
    ...overrides
  };
}

function anthropicCandidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    providerId: 'anthropic',
    modelId: 'anthropic-fast',
    providerKind: 'cloud',
    available: true,
    capabilities,
    qualityScore: 88,
    frontier: true,
    p50LatencyMs: 4 * 60_000,
    queueDelayMs: 0,
    estimatedCostUsd: 0.25,
    ...overrides
  };
}

function openaiCandidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    providerId: 'openai',
    modelId: 'openai-fast',
    providerKind: 'cloud',
    available: true,
    capabilities,
    qualityScore: 84,
    frontier: true,
    p50LatencyMs: 5 * 60_000,
    queueDelayMs: 0,
    estimatedCostUsd: 0.24,
    ...overrides
  };
}

function inference() {
  return {
    systemPrompt: 'You are a software engineer.',
    userPrompt: 'Fix the checkout bug.',
    stage: 'implementation' as const,
    output: { type: 'text' as const }
  };
}

test('speed-first routes directly to cloud without invoking local inference first', async () => {
  const local = new FakeProvider('ollama', 'local', 'qwen-local', async () => ok('ollama', 'qwen-local'));
  const anthropic = new FakeProvider('anthropic', 'cloud', 'anthropic-fast', async () => ok('anthropic', 'anthropic-fast'));
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([local, anthropic]));

  const result = await runtime.invoke({
    inference: inference(),
    routing: {
      project: project({ defaultRoutingPolicy: 'speed-first' }),
      stage: 'implementation',
      candidates: [
        localCandidate({ queueDelayMs: 27 * 60_000, p50LatencyMs: 8 * 60_000 }),
        anthropicCandidate({ p50LatencyMs: 222_000 })
      ]
    }
  });

  assert.equal(result.result.providerId, 'anthropic');
  assert.equal(anthropic.calls.length, 1);
  assert.equal(local.calls.length, 0);
  assert.match(result.routing.reasons.join(' '), /speed-first/);
  assert.match(result.routing.reasons.join(' '), /historical p50 222s/);
});

test('local-first keeps bounded healthy work local without a cloud call', async () => {
  const local = new FakeProvider('ollama', 'local', 'qwen-local', async () => ok('ollama', 'qwen-local'));
  const anthropic = new FakeProvider('anthropic', 'cloud', 'anthropic-fast', async () => ok('anthropic', 'anthropic-fast'));
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([local, anthropic]));

  const result = await runtime.invoke({
    inference: inference(),
    routing: {
      project: project({ defaultRoutingPolicy: 'local-first' }),
      stage: 'implementation',
      candidates: [
        localCandidate({ p50LatencyMs: 5 * 60_000, qualityScore: 78 }),
        anthropicCandidate({ p50LatencyMs: 3 * 60_000, qualityScore: 88 })
      ]
    }
  });

  assert.equal(result.result.providerId, 'ollama');
  assert.equal(local.calls.length, 1);
  assert.equal(anthropic.calls.length, 0);
});

test('explicit model selection is exact and never silently reroutes', async () => {
  const local = new FakeProvider('ollama', 'local', 'qwen-local', async () => ok('ollama', 'qwen-local'));
  const openai = new FakeProvider('openai', 'cloud', 'openai-fast', async () => ok('openai', 'openai-fast'));
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([local, openai]));

  const result = await runtime.invoke({
    inference: inference(),
    routing: {
      project: project(),
      stage: 'implementation',
      modelSelection: { mode: 'explicit', providerId: 'openai', modelId: 'openai-fast' },
      candidates: [localCandidate(), openaiCandidate()]
    }
  });

  assert.equal(result.result.providerId, 'openai');
  assert.equal(openai.calls.length, 1);
  assert.equal(local.calls.length, 0);
});

test('project provider allowlist and cloud permission are hard routing constraints', () => {
  const blockedProviderProject = project({
    privacy: { cloudAllowed: true, allowedProviderIds: ['ollama', 'anthropic'] },
    defaultRoutingPolicy: 'speed-first'
  });
  const decision = routeCognitiveStage({
    project: blockedProviderProject,
    stage: 'implementation',
    candidates: [localCandidate(), openaiCandidate({ p50LatencyMs: 1 })]
  });
  assert.equal(decision.selected.providerId, 'ollama');
  assert.match(
    decision.considered.find((item) => item.providerId === 'openai')?.exclusionReason ?? '',
    /blocked by project.*allowlist/
  );

  const localOnly = project({
    privacy: { cloudAllowed: false, allowedProviderIds: ['ollama', 'anthropic'] },
    defaultRoutingPolicy: 'speed-first'
  });
  const localDecision = routeCognitiveStage({
    project: localOnly,
    stage: 'implementation',
    candidates: [localCandidate(), anthropicCandidate({ p50LatencyMs: 1 })]
  });
  assert.equal(localDecision.selected.providerId, 'ollama');
  assert.match(
    localDecision.considered.find((item) => item.providerId === 'anthropic')?.exclusionReason ?? '',
    /does not allow cloud inference/
  );
});

test('blocked explicit selection fails instead of falling back', () => {
  assert.throws(
    () => routeCognitiveStage({
      project: project({ privacy: { cloudAllowed: false, allowedProviderIds: ['ollama', 'openai'] } }),
      stage: 'implementation',
      modelSelection: { mode: 'explicit', providerId: 'openai', modelId: 'openai-fast' },
      candidates: [localCandidate(), openaiCandidate()]
    }),
    (error: unknown) => {
      assert.ok(error instanceof RoutingConstraintError);
      assert.match(error.message, /does not allow cloud inference/);
      return true;
    }
  );
});

test('frontier-only excludes non-frontier candidates as a hard constraint', () => {
  const decision = routeCognitiveStage({
    project: project({ defaultRoutingPolicy: 'frontier-only' }),
    stage: 'deliberation',
    candidates: [
      localCandidate({ frontier: false, qualityScore: 99, p50LatencyMs: 1 }),
      anthropicCandidate({ frontier: true, qualityScore: 88 })
    ]
  });
  assert.equal(decision.selected.providerId, 'anthropic');
  assert.match(
    decision.considered.find((item) => item.providerId === 'ollama')?.exclusionReason ?? '',
    /frontier-only/
  );
});

test('rate-limited cloud provider can fall through to another allowed cloud provider without local inference', async () => {
  const local = new FakeProvider('ollama', 'local', 'qwen-local', async () => ok('ollama', 'qwen-local'));
  const anthropic = new FakeProvider('anthropic', 'cloud', 'anthropic-fast', async () => {
    throw new ProviderError('anthropic', 'rate limited', { status: 429, retryable: true, rateLimited: true });
  });
  const openai = new FakeProvider('openai', 'cloud', 'openai-fast', async () => ok('openai', 'openai-fast'));
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([local, anthropic, openai]));

  const result = await runtime.invoke({
    inference: inference(),
    routing: {
      project: project({ defaultRoutingPolicy: 'speed-first' }),
      stage: 'implementation',
      candidates: [
        localCandidate({ queueDelayMs: 30 * 60_000 }),
        anthropicCandidate({ qualityScore: 92, p50LatencyMs: 120_000, estimatedCostUsd: 0.25 }),
        openaiCandidate({ qualityScore: 89, p50LatencyMs: 150_000, estimatedCostUsd: 0.24 })
      ]
    }
  });

  assert.equal(result.result.providerId, 'openai');
  assert.equal(result.fallbackUsed, true);
  assert.equal(anthropic.calls.length, 1);
  assert.equal(openai.calls.length, 1);
  assert.equal(local.calls.length, 0);
  assert.deepEqual(result.attempts.map((attempt) => attempt.providerId), ['anthropic', 'openai']);
});

test('local to cloud fallback is never silent when monetary cost is introduced', async () => {
  const local = new FakeProvider('ollama', 'local', 'qwen-local', async () => {
    throw new ProviderError('ollama', 'local unavailable', { retryable: true });
  });
  const anthropic = new FakeProvider('anthropic', 'cloud', 'anthropic-fast', async () => ok('anthropic', 'anthropic-fast'));
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([local, anthropic]));

  await assert.rejects(
    runtime.invoke({
      inference: inference(),
      routing: {
        project: project({ defaultRoutingPolicy: 'local-first' }),
        stage: 'implementation',
        candidates: [
          localCandidate({ qualityScore: 90, p50LatencyMs: 60_000 }),
          anthropicCandidate({ qualityScore: 80, p50LatencyMs: 120_000, estimatedCostUsd: 0.30 })
        ]
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof FallbackConfirmationRequired);
      assert.equal(error.request.from.providerId, 'ollama');
      assert.equal(error.request.to.providerId, 'anthropic');
      assert.equal(error.request.costChange, 'known-material');
      return true;
    }
  );
  assert.equal(local.calls.length, 1);
  assert.equal(anthropic.calls.length, 0);
});

test('confirmed local to cloud fallback resumes with the same routed request', async () => {
  const local = new FakeProvider('ollama', 'local', 'qwen-local', async () => {
    throw new ProviderError('ollama', 'local unavailable', { retryable: true });
  });
  const anthropic = new FakeProvider('anthropic', 'cloud', 'anthropic-fast', async () => ok('anthropic', 'anthropic-fast'));
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([local, anthropic]));
  const confirmations: string[] = [];

  const result = await runtime.invoke({
    inference: inference(),
    routing: {
      project: project({ defaultRoutingPolicy: 'local-first' }),
      stage: 'implementation',
      candidates: [
        localCandidate({ qualityScore: 90, p50LatencyMs: 60_000 }),
        anthropicCandidate({ qualityScore: 80, p50LatencyMs: 120_000, estimatedCostUsd: 0.30 })
      ]
    },
    confirmFallback: (request) => {
      confirmations.push(`${request.from.providerId}->${request.to.providerId}`);
      return true;
    }
  });

  assert.equal(result.result.providerId, 'anthropic');
  assert.deepEqual(confirmations, ['ollama->anthropic']);
  assert.equal(local.calls.length, 1);
  assert.equal(anthropic.calls.length, 1);
});

test('auto policy resolves urgency to speed-first and complexity to deep', () => {
  const urgent = routeCognitiveStage({
    project: project({ defaultRoutingPolicy: 'auto' }),
    stage: 'planning',
    urgency: 'urgent',
    candidates: [localCandidate(), anthropicCandidate()]
  });
  assert.equal(urgent.effectivePolicy, 'speed-first');

  const complex = routeCognitiveStage({
    project: project({ defaultRoutingPolicy: 'auto' }),
    stage: 'deliberation',
    complexityScore: 90,
    candidates: [localCandidate(), anthropicCandidate()]
  });
  assert.equal(complex.effectivePolicy, 'deep');
  assert.equal(complex.selected.providerId, 'anthropic');
});
