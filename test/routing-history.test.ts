import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OperationCancelledError } from '../src/cancellation.js';
import { routeCognitiveStage, type RoutingCandidate } from '../src/cognitive-router.js';
import { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth
} from '../src/providers/types.js';
import { RoutedInferenceRuntime } from '../src/routed-inference.js';
import { RoutingHistoryStore } from '../src/routing-history.js';
import type { ProjectDefinition } from '../src/project-store.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

function project(id = 'project-a', organizationId = 'org-a'): ProjectDefinition {
  const now = '2026-08-31T12:00:00.000Z';
  return {
    id,
    name: id,
    workspace: `/tmp/${id}`,
    organizationId,
    defaultRoutingPolicy: 'balanced',
    defaultModel: { mode: 'auto' },
    privacy: { cloudAllowed: true, allowedProviderIds: ['ollama', 'cloud'] },
    credentialProfileIds: {},
    budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
    repoIntelligenceScope: 'project',
    concurrency: 1,
    createdAt: now,
    updatedAt: now
  };
}

class TestProvider implements InferenceProvider {
  readonly capabilities = capabilities;

  constructor(
    readonly id: string,
    readonly kind: 'local' | 'cloud',
    private readonly modelId: string,
    private readonly invokeFn: (request: InferenceRequest) => Promise<InferenceResult> = async (request) => ({
      providerId: id,
      model: request.model,
      content: 'ok',
      latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    })
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

function tempRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-routing-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function localCandidate(metrics: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    providerId: 'ollama',
    modelId: 'qwen-local',
    providerKind: 'local',
    available: true,
    capabilities,
    ...metrics
  };
}

function cloudCandidate(metrics: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    providerId: 'cloud',
    modelId: 'cloud-model',
    providerKind: 'cloud',
    available: true,
    capabilities,
    ...metrics
  };
}

test('routing history persists metadata only inside an organization/project isolation directory', (t) => {
  const root = tempRoot(t);
  const store = new RoutingHistoryStore(root);
  const first = project('shared-id', 'org-one');
  const second = project('shared-id', 'org-two');

  store.record(first, {
    stage: 'planning',
    candidate: localCandidate(),
    outcome: 'success',
    latencyMs: 42,
    fallback: false,
    timestamp: '2026-08-31T12:00:00.000Z',
    id: 'attempt-one'
  });

  assert.equal(store.list(first, new Date('2026-08-31T12:00:01.000Z')).length, 1);
  assert.equal(store.list(second, new Date('2026-08-31T12:00:01.000Z')).length, 0);
  const files = fs.readdirSync(root, { recursive: true }).map(String);
  const eventFile = files.find((file) => file.endsWith('.json'));
  assert.ok(eventFile);
  const raw = fs.readFileSync(path.join(root, eventFile), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    'fallback', 'id', 'latencyMs', 'modelId', 'organizationId', 'outcome',
    'projectId', 'providerId', 'providerKind', 'stage', 'timestamp', 'version'
  ]);
  assert.ok(!raw.includes('systemPrompt'));
  assert.ok(!raw.includes('userPrompt'));
  assert.ok(!raw.includes('content'));
});

test('calibration waits for a minimum sample size and computes p50 from successful attempts', (t) => {
  const root = tempRoot(t);
  const store = new RoutingHistoryStore(root, { minSamples: 3, maxAgeMs: 60_000 });
  const scoped = project();
  const times = [10, 30, 20];

  for (let index = 0; index < times.length; index += 1) {
    store.record(scoped, {
      stage: 'planning',
      candidate: localCandidate(),
      outcome: 'success',
      latencyMs: times[index],
      fallback: false,
      timestamp: `2026-08-31T12:00:0${index}.000Z`,
      id: `success-${index}`
    });
    const metrics = store.metrics(
      scoped,
      'planning',
      'ollama',
      'qwen-local',
      new Date('2026-08-31T12:00:10.000Z')
    );
    assert.equal(metrics?.historicalSamples, index + 1);
    if (index < 2) {
      assert.equal(metrics?.successRate, undefined);
      assert.equal(metrics?.p50LatencyMs, undefined);
    }
  }

  store.record(scoped, {
    stage: 'planning',
    candidate: localCandidate(),
    outcome: 'error',
    latencyMs: 15,
    fallback: false,
    failureKind: 'retryable',
    timestamp: '2026-08-31T12:00:03.000Z',
    id: 'failure-one'
  });
  const metrics = store.metrics(
    scoped,
    'planning',
    'ollama',
    'qwen-local',
    new Date('2026-08-31T12:00:10.000Z')
  );
  assert.equal(metrics?.historicalSamples, 4);
  assert.equal(metrics?.successRate, 0.75);
  assert.equal(metrics?.p50LatencyMs, 20);
});

test('stale samples are excluded from calibration', (t) => {
  const root = tempRoot(t);
  const store = new RoutingHistoryStore(root, { minSamples: 1, maxAgeMs: 1_000 });
  const scoped = project();
  store.record(scoped, {
    stage: 'review',
    candidate: cloudCandidate(),
    outcome: 'success',
    latencyMs: 100,
    fallback: false,
    timestamp: '2026-08-31T12:00:00.000Z',
    id: 'old'
  });
  assert.equal(
    store.metrics(scoped, 'review', 'cloud', 'cloud-model', new Date('2026-08-31T12:00:02.000Z')),
    undefined
  );
});

test('ProjectProviderRuntime exposes scoped historical metrics in routing candidates', async (t) => {
  const root = tempRoot(t);
  const scoped = project('runtime-project', 'runtime-org');
  scoped.privacy = { cloudAllowed: false, allowedProviderIds: ['ollama'] };
  const history = new RoutingHistoryStore(path.join(root, 'history'), { minSamples: 3 });
  for (const [index, latencyMs] of [30, 10, 20].entries()) {
    history.record(scoped, {
      stage: 'planning',
      candidate: localCandidate(),
      outcome: 'success',
      latencyMs,
      fallback: false,
      timestamp: `2026-08-31T12:00:0${index}.000Z`,
      id: `runtime-${index}`
    });
  }
  const runtime = new ProjectProviderRuntime({
    localProvider: new TestProvider('ollama', 'local', 'qwen-local'),
    settings: new ProviderSettingsStore(path.join(root, 'providers.json')),
    metrics: history.forProject(scoped)
  });
  const catalog = await runtime.routingCandidates(scoped, {
    stage: 'planning',
    localModelHint: 'qwen-local'
  });
  assert.equal(catalog.candidates.length, 1);
  assert.equal(catalog.candidates[0].historicalSamples, 3);
  assert.equal(catalog.candidates[0].successRate, 1);
  assert.equal(catalog.candidates[0].p50LatencyMs, 20);
});

test('calibrated reliability and latency can deterministically change the Auto Router winner', (t) => {
  const root = tempRoot(t);
  const store = new RoutingHistoryStore(root, { minSamples: 3 });
  const scoped = project('router-project', 'router-org');
  const cold = routeCognitiveStage({
    project: scoped,
    stage: 'planning',
    candidates: [localCandidate(), cloudCandidate()],
    policy: 'balanced'
  });
  assert.equal(cold.selected.providerId, 'cloud');

  for (let index = 0; index < 3; index += 1) {
    store.record(scoped, {
      stage: 'planning',
      candidate: localCandidate(),
      outcome: 'success',
      latencyMs: 100 + index,
      fallback: false,
      timestamp: `2026-08-31T12:00:0${index}.000Z`,
      id: `local-${index}`
    });
  }
  for (let index = 0; index < 3; index += 1) {
    store.record(scoped, {
      stage: 'planning',
      candidate: cloudCandidate(),
      outcome: index === 0 ? 'success' : 'error',
      latencyMs: 240_000,
      fallback: false,
      failureKind: index === 0 ? undefined : 'retryable',
      timestamp: `2026-08-31T12:00:1${index}.000Z`,
      id: `cloud-${index}`
    });
  }
  const now = new Date('2026-08-31T12:01:00.000Z');
  const localMetrics = store.metrics(scoped, 'planning', 'ollama', 'qwen-local', now)!;
  const cloudMetrics = store.metrics(scoped, 'planning', 'cloud', 'cloud-model', now)!;
  const calibrated = routeCognitiveStage({
    project: scoped,
    stage: 'planning',
    candidates: [localCandidate(localMetrics), cloudCandidate(cloudMetrics)],
    policy: 'balanced'
  });
  assert.equal(calibrated.selected.providerId, 'ollama');
});

test('attempt observer failures never change inference success', async () => {
  const provider = new TestProvider('ollama', 'local', 'qwen-local');
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([provider]));
  let observed = 0;
  const result = await runtime.invoke({
    inference: { systemPrompt: 'system', userPrompt: 'user', stage: 'planning' },
    routing: {
      project: {
        id: 'observer-project',
        defaultRoutingPolicy: 'balanced',
        defaultModel: { mode: 'auto' },
        privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] }
      },
      stage: 'planning',
      candidates: [localCandidate()]
    },
    onAttemptComplete: () => {
      observed += 1;
      throw new Error('history disk unavailable');
    }
  });
  assert.equal(result.result.content, 'ok');
  assert.equal(observed, 1);
});

test('user cancellation is not recorded as provider reliability failure', async () => {
  const provider = new TestProvider('ollama', 'local', 'qwen-local', async () => {
    throw new OperationCancelledError();
  });
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([provider]));
  let observed = 0;
  await assert.rejects(
    runtime.invoke({
      inference: { systemPrompt: 'system', userPrompt: 'user', stage: 'planning' },
      routing: {
        project: {
          id: 'cancel-project',
          defaultRoutingPolicy: 'balanced',
          defaultModel: { mode: 'auto' },
          privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] }
        },
        stage: 'planning',
        candidates: [localCandidate()]
      },
      onAttemptComplete: () => { observed += 1; }
    }),
    OperationCancelledError
  );
  assert.equal(observed, 0);
});
