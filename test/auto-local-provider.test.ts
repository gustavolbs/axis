import assert from 'node:assert/strict';
import test from 'node:test';

import { AutoLocalInferenceProvider } from '../src/providers/auto-local-provider.js';
import {
  ProviderError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelDefinition,
  type ProviderCapabilities,
  type ProviderHealth
} from '../src/providers/types.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

class StubLocalProvider implements InferenceProvider {
  readonly id = 'ollama';
  readonly kind = 'local' as const;
  readonly capabilities = capabilities;

  constructor(
    private readonly model: string,
    private readonly invokeFn: (request: InferenceRequest) => Promise<InferenceResult>
  ) {}

  async listModels(): Promise<ModelDefinition[]> {
    return [{ providerId: this.id, id: this.model, displayName: this.model, capabilities }];
  }

  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, ok: true, checkedAt: new Date().toISOString(), latencyMs: 1, modelsAvailable: 1 };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    return await this.invokeFn(request);
  }
}

test('auto local provider falls back to Mac when worker dies after successful discovery', async () => {
  let preferredCalls = 0;
  let fallbackCalls = 0;
  const preferred = new StubLocalProvider('qwen3.8:27b', async () => {
    preferredCalls += 1;
    throw new ProviderError('ollama', 'worker disconnected', { retryable: true });
  });
  const fallback = new StubLocalProvider('qwen3.8:27b', async (request) => {
    fallbackCalls += 1;
    return {
      providerId: 'ollama',
      model: request.model,
      content: 'mac fallback',
      latencyMs: 2,
      usage: {}
    };
  });
  const auto = new AutoLocalInferenceProvider(preferred, fallback);

  const models = await auto.listModels();
  assert.equal(models[0]?.metadata?.autoLocalSource, 'remote-worker');
  const result = await auto.invoke({
    model: 'qwen3.8:27b',
    systemPrompt: 'system',
    userPrompt: 'user'
  });

  assert.equal(result.content, 'mac fallback');
  assert.equal(preferredCalls, 1);
  assert.equal(fallbackCalls, 1);
});

test('auto local provider never substitutes a different Mac model during fallback', async () => {
  const preferred = new StubLocalProvider('qwen3.8:27b', async () => {
    throw new ProviderError('ollama', 'worker disconnected', { retryable: true });
  });
  let fallbackCalls = 0;
  const fallback = new StubLocalProvider('different-model', async (request) => {
    fallbackCalls += 1;
    return { providerId: 'ollama', model: request.model, content: 'wrong', latencyMs: 1, usage: {} };
  });
  const auto = new AutoLocalInferenceProvider(preferred, fallback);
  await auto.listModels();

  await assert.rejects(
    auto.invoke({ model: 'qwen3.8:27b', systemPrompt: 'system', userPrompt: 'user' }),
    /worker disconnected/
  );
  assert.equal(fallbackCalls, 0);
});
