import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RoutingConstraintError,
  routeCognitiveStage,
  type RoutingCandidate
} from '../src/cognitive-router.js';
import type { ProjectDefinition } from '../src/project-store.js';
import { RoutedInferenceRuntime } from '../src/routed-inference.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth
} from '../src/providers/types.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: true,
  toolUse: true
};

function project(): ProjectDefinition {
  return {
    id: 'private-project',
    name: 'Private Project',
    workspace: '/repo/private',
    organizationId: 'private-org',
    defaultRoutingPolicy: 'speed-first',
    defaultModel: { mode: 'auto' },
    privacy: { cloudAllowed: false, allowedProviderIds: ['ollama', 'anthropic'] },
    credentialProfileIds: {},
    budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
    repoIntelligenceScope: 'project',
    concurrency: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

class CloudProvider implements InferenceProvider {
  readonly id = 'anthropic';
  readonly kind = 'cloud' as const;
  readonly capabilities = capabilities;
  calls = 0;

  async listModels(): Promise<ModelDefinition[]> {
    return [{ providerId: this.id, id: 'model-a', displayName: 'model-a', capabilities }];
  }
  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, ok: true, checkedAt: new Date().toISOString(), latencyMs: 1 };
  }
  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    this.calls += 1;
    return { providerId: this.id, model: request.model, content: 'ok', latencyMs: 1, usage: {} };
  }
}

test('capability-constrained stages exclude candidates whose support is unknown', () => {
  const base: RoutingCandidate = {
    providerId: 'ollama',
    modelId: 'local',
    providerKind: 'local',
    available: true,
    capabilities: {},
    qualityScore: 99,
    p50LatencyMs: 1,
    estimatedCostUsd: 0
  };
  const supported: RoutingCandidate = {
    providerId: 'anthropic',
    modelId: 'model-a',
    providerKind: 'cloud',
    available: true,
    capabilities,
    qualityScore: 80,
    p50LatencyMs: 1000,
    estimatedCostUsd: 0.2
  };
  const cloudProject = { ...project(), privacy: { cloudAllowed: true, allowedProviderIds: ['ollama', 'anthropic'] } };

  const decision = routeCognitiveStage({
    project: cloudProject,
    stage: 'planning',
    requireReasoning: true,
    requireStructuredOutput: true,
    candidates: [base, supported]
  });

  assert.equal(decision.selected.providerId, 'anthropic');
  assert.match(
    decision.considered.find((candidate) => candidate.providerId === 'ollama')?.exclusionReason ?? '',
    /positively known/
  );
});

test('duplicate provider/model candidates are rejected before scoring', () => {
  const duplicate: RoutingCandidate = {
    providerId: 'ollama',
    modelId: 'same-model',
    providerKind: 'local',
    available: true,
    capabilities,
    estimatedCostUsd: 0
  };
  assert.throws(
    () => routeCognitiveStage({
      project: project(),
      stage: 'implementation',
      candidates: [duplicate, { ...duplicate }]
    }),
    /Duplicate routing candidate/
  );
});

test('registered provider kind cannot be spoofed to bypass cloud privacy policy', async () => {
  const cloud = new CloudProvider();
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([cloud]));

  await assert.rejects(
    runtime.invoke({
      inference: {
        systemPrompt: 'system',
        userPrompt: 'user',
        stage: 'implementation'
      },
      routing: {
        project: project(),
        stage: 'implementation',
        candidates: [{
          providerId: 'anthropic',
          modelId: 'model-a',
          providerKind: 'local',
          available: true,
          capabilities,
          qualityScore: 100,
          p50LatencyMs: 1,
          estimatedCostUsd: 0
        }]
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof RoutingConstraintError);
      assert.match(error.message, /registered provider is cloud/);
      return true;
    }
  );
  assert.equal(cloud.calls, 0);
});
