import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FALLBACK_CLOUD_CONTEXT_WINDOW,
  FALLBACK_CLOUD_MAX_OUTPUT_TOKENS,
  FALLBACK_LOCAL_CONTEXT_WINDOW,
  FALLBACK_LOCAL_MAX_OUTPUT_TOKENS,
  modelWithSafeLimits,
  withSafeModelLimits
} from '../src/providers/model-limits.js';
import type {
  InferenceProvider,
  InferenceRequest,
  ProviderCapabilities,
  ProviderKind
} from '../src/providers/types.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: false,
  reasoning: false,
  promptCaching: false,
  toolUse: false
};

function provider(
  kind: ProviderKind,
  onInvoke: (request: InferenceRequest) => void,
  limits: { contextWindow?: number; maxOutputTokens?: number } = {}
): InferenceProvider {
  return {
    id: kind === 'cloud' ? 'future-cloud' : 'future-local',
    kind,
    capabilities,
    async listModels() {
      return [{
        providerId: this.id,
        id: 'future-model',
        displayName: 'Future Model',
        ...limits
      }];
    },
    async health() {
      return { providerId: this.id, ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 1 };
    },
    async invoke(request) {
      onInvoke(request);
      return { providerId: this.id, model: request.model, content: 'ok', latencyMs: 1, usage: {} };
    }
  };
}

function request(maxOutputTokens?: number): InferenceRequest {
  return { model: 'future-model', systemPrompt: 'system', userPrompt: 'user', maxOutputTokens };
}

test('every future cloud provider receives complete conservative model limits', async () => {
  let received: number | undefined;
  const wrapped = withSafeModelLimits(provider('cloud', (input) => { received = input.maxOutputTokens; }));
  const [model] = await wrapped.listModels();
  assert.equal(model?.contextWindow, FALLBACK_CLOUD_CONTEXT_WINDOW);
  assert.equal(model?.maxOutputTokens, FALLBACK_CLOUD_MAX_OUTPUT_TOKENS);
  assert.equal(model?.metadata?.modelLimitsSource, 'conservative-fallback');
  await wrapped.invoke(request());
  assert.equal(received, FALLBACK_CLOUD_MAX_OUTPUT_TOKENS);
});

test('every future local provider receives complete conservative model limits', async () => {
  let received: number | undefined;
  const wrapped = withSafeModelLimits(provider('local', (input) => { received = input.maxOutputTokens; }));
  const [model] = await wrapped.listModels();
  assert.equal(model?.contextWindow, FALLBACK_LOCAL_CONTEXT_WINDOW);
  assert.equal(model?.maxOutputTokens, FALLBACK_LOCAL_MAX_OUTPUT_TOKENS);
  await wrapped.invoke(request());
  assert.equal(received, FALLBACK_LOCAL_MAX_OUTPUT_TOKENS);
});

test('published model capacity is preserved while default inference stays practical', async () => {
  let received: number | undefined;
  const wrapped = withSafeModelLimits(provider('cloud', (input) => { received = input.maxOutputTokens; }, {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000
  }));
  const [model] = await wrapped.listModels();
  assert.equal(model?.contextWindow, 1_000_000);
  assert.equal(model?.maxOutputTokens, 128_000);
  assert.equal(model?.metadata?.modelLimitsSource, 'provider');
  await wrapped.invoke(request());
  assert.equal(received, FALLBACK_CLOUD_MAX_OUTPUT_TOKENS);
  await wrapped.invoke(request(4_096));
  assert.equal(received, 4_096);
});

test('invalid provider metadata is normalized instead of leaking into the catalog', () => {
  const model = modelWithSafeLimits({
    providerId: 'broken-provider',
    id: 'broken-model',
    displayName: 'Broken Model',
    contextWindow: Number.NaN,
    maxOutputTokens: -1
  }, 'cloud');
  assert.equal(model.contextWindow, FALLBACK_CLOUD_CONTEXT_WINDOW);
  assert.equal(model.maxOutputTokens, FALLBACK_CLOUD_MAX_OUTPUT_TOKENS);
});
