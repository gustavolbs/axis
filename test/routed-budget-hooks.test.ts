import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderRegistry } from '../src/providers/registry.js';
import {
  ProviderError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelDefinition,
  type ProviderCapabilities,
  type ProviderHealth
} from '../src/providers/types.js';
import { RoutedInferenceRuntime } from '../src/routed-inference.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

class TestProvider implements InferenceProvider {
  readonly capabilities = capabilities;

  constructor(
    readonly id: string,
    readonly kind: 'local' | 'cloud',
    private readonly modelId: string,
    private readonly invokeFn: (request: InferenceRequest) => Promise<InferenceResult>
  ) {}

  async listModels(): Promise<ModelDefinition[]> {
    return [{ providerId: this.id, id: this.modelId, displayName: this.modelId, capabilities }];
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
    return await this.invokeFn(request);
  }
}

function project() {
  return {
    id: 'budget-routing-project',
    defaultRoutingPolicy: 'speed-first' as const,
    defaultModel: { mode: 'auto' as const },
    privacy: {
      cloudAllowed: true,
      allowedProviderIds: ['anthropic', 'ollama']
    }
  };
}

function fastCloudCandidate() {
  return {
    providerId: 'anthropic',
    modelId: 'cloud-fast',
    providerKind: 'cloud' as const,
    available: true,
    capabilities,
    queueDelayMs: 0,
    p50LatencyMs: 10,
    successRate: 0.99,
    estimatedCostUsd: 0.01,
    qualityScore: 90
  };
}

function slowLocalCandidate() {
  return {
    providerId: 'ollama',
    modelId: 'qwen-local',
    providerKind: 'local' as const,
    available: true,
    capabilities,
    queueDelayMs: 500_000,
    p50LatencyMs: 500_000,
    successRate: 0.99,
    estimatedCostUsd: 0,
    qualityScore: 90
  };
}

test('authorized failed attempt is released before fallback admission and fallback becomes selected route', async () => {
  const lifecycle: string[] = [];
  const cloud = new TestProvider('anthropic', 'cloud', 'cloud-fast', async () => {
    lifecycle.push('invoke:anthropic');
    throw new ProviderError('anthropic', 'temporary outage', { retryable: true });
  });
  const local = new TestProvider('ollama', 'local', 'qwen-local', async (request) => {
    lifecycle.push('invoke:ollama');
    return {
      providerId: 'ollama',
      model: request.model,
      content: 'local fallback',
      latencyMs: 5,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
    };
  });
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([cloud, local]));

  const result = await runtime.invoke({
    inference: {
      systemPrompt: 'system',
      userPrompt: 'user',
      stage: 'planning',
      maxOutputTokens: 100
    },
    routing: {
      project: project(),
      stage: 'planning',
      policy: 'speed-first',
      candidates: [fastCloudCandidate(), slowLocalCandidate()]
    },
    authorizeAttempt: ({ candidate }) => {
      lifecycle.push(`authorize:${candidate.providerId}`);
    },
    onAttemptFailure: ({ candidate }) => {
      lifecycle.push(`release:${candidate.providerId}`);
    }
  });

  assert.deepEqual(lifecycle, [
    'authorize:anthropic',
    'invoke:anthropic',
    'release:anthropic',
    'authorize:ollama',
    'invoke:ollama'
  ]);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.routing.selected.providerId, 'ollama');
  assert.equal(result.routing.selected.modelId, 'qwen-local');
  assert.equal(result.result.content, 'local fallback');
});

test('auto routing falls back to local without invoking cloud when cloud admission is denied', async () => {
  let cloudCalls = 0;
  let localCalls = 0;
  const cloud = new TestProvider('anthropic', 'cloud', 'cloud-fast', async (request) => {
    cloudCalls += 1;
    return {
      providerId: 'anthropic',
      model: request.model,
      content: 'cloud',
      latencyMs: 1,
      usage: {}
    };
  });
  const local = new TestProvider('ollama', 'local', 'qwen-local', async (request) => {
    localCalls += 1;
    return {
      providerId: 'ollama',
      model: request.model,
      content: 'local after budget stop',
      latencyMs: 2,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    };
  });
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([cloud, local]));

  const result = await runtime.invoke({
    inference: {
      systemPrompt: 'system',
      userPrompt: 'user',
      stage: 'planning',
      maxOutputTokens: 100
    },
    routing: {
      project: project(),
      stage: 'planning',
      policy: 'speed-first',
      candidates: [fastCloudCandidate(), slowLocalCandidate()]
    },
    authorizeAttempt: ({ candidate }) => {
      if (candidate.providerKind === 'cloud') throw new Error('cloud budget exhausted');
    }
  });

  assert.equal(cloudCalls, 0);
  assert.equal(localCalls, 1);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.attempts[0]?.admissionDenied, true);
  assert.equal(result.routing.selected.providerId, 'ollama');
  assert.equal(result.result.content, 'local after budget stop');
});

test('admission rejection happens before any provider I/O', async () => {
  let providerCalls = 0;
  const cloud = new TestProvider('anthropic', 'cloud', 'cloud-fast', async (request) => {
    providerCalls += 1;
    return {
      providerId: 'anthropic',
      model: request.model,
      content: 'should not happen',
      latencyMs: 1,
      usage: {}
    };
  });
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([cloud]));

  await assert.rejects(
    runtime.invoke({
      inference: {
        systemPrompt: 'system',
        userPrompt: 'user',
        stage: 'planning',
        maxOutputTokens: 100
      },
      routing: {
        project: {
          ...project(),
          privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic'] }
        },
        stage: 'planning',
        candidates: [fastCloudCandidate()]
      },
      authorizeAttempt: () => {
        throw new Error('budget denied');
      }
    }),
    /budget denied/
  );
  assert.equal(providerCalls, 0);
});
