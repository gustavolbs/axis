import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteWorkerError } from '../src/remote-worker-client.js';
import { RemoteWorkerInferenceProvider } from '../src/providers/remote-worker-provider.js';
import { ProviderError } from '../src/providers/types.js';
import type { RemoteWorkerHealth } from '../src/remote-protocol.js';
import type { OllamaGeneration } from '../src/ollama.js';

function health(overrides: Partial<RemoteWorkerHealth> = {}): RemoteWorkerHealth {
  return {
    protocolVersion: 1,
    workerVersion: '0.14.0',
    ok: true,
    hostname: 'windows-worker',
    platform: 'win32',
    model: 'qwen3.8:27b',
    bootstrap: 'none',
    ollama: { availableModels: ['qwen3.8:27b', 'some-other-model'] },
    ...overrides
  };
}

test('remote worker provider exposes only the configured worker model', async () => {
  const provider = new RemoteWorkerInferenceProvider({
    health: async () => health(),
    chat: async (): Promise<OllamaGeneration> => ({ content: 'unused', model: 'qwen3.8:27b' })
  });

  const models = await provider.listModels();
  assert.deepEqual(models.map((model) => model.id), ['qwen3.8:27b']);
  assert.equal(models[0]?.providerId, 'ollama');
  assert.equal(models[0]?.metadata?.remoteWorker, true);
  assert.equal(models[0]?.metadata?.configuredFastModel, true);
  assert.equal(models[0]?.metadata?.configuredStrongModel, true);
});

test('remote worker provider maps structured chat and usage through protocol v1', async () => {
  let receivedFormat: 'json' | Record<string, unknown> | undefined;
  const provider = new RemoteWorkerInferenceProvider({
    health: async () => health(),
    chat: async (_system, _user, format): Promise<OllamaGeneration> => {
      receivedFormat = format;
      return {
        content: '{"ok":true}',
        model: 'qwen3.8:27b',
        doneReason: 'stop',
        totalDurationNs: 25_000_000,
        promptTokens: 11,
        completionTokens: 4
      };
    }
  });
  await provider.listModels();

  const result = await provider.invoke({
    model: 'qwen3.8:27b',
    systemPrompt: 'system',
    userPrompt: 'user',
    output: {
      type: 'json_schema',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } }
      }
    }
  });

  assert.deepEqual(receivedFormat, {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } }
  });
  assert.equal(result.providerId, 'ollama');
  assert.equal(result.model, 'qwen3.8:27b');
  assert.equal(result.content, '{"ok":true}');
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 4, totalTokens: 15 });
});

test('remote worker provider refuses model switching not supported by protocol v1', async () => {
  let chatCalls = 0;
  const provider = new RemoteWorkerInferenceProvider({
    health: async () => health(),
    chat: async (): Promise<OllamaGeneration> => {
      chatCalls += 1;
      return { content: 'unused', model: 'qwen3.8:27b' };
    }
  });
  await provider.listModels();

  await assert.rejects(
    provider.invoke({
      model: 'another-model',
      systemPrompt: 'system',
      userPrompt: 'user'
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.options.retryable, false);
      assert.equal(error.options.code, 'remote_worker_model_switch_unsupported');
      return true;
    }
  );
  assert.equal(chatCalls, 0);
});

test('remote worker transport unavailability becomes retryable provider failure', async () => {
  const provider = new RemoteWorkerInferenceProvider({
    health: async () => health(),
    chat: async () => {
      throw new RemoteWorkerError('worker offline', true, 503);
    }
  });
  await provider.listModels();

  await assert.rejects(
    provider.invoke({
      model: 'qwen3.8:27b',
      systemPrompt: 'system',
      userPrompt: 'user'
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.options.retryable, true);
      assert.equal(error.options.status, 503);
      assert.equal(error.options.code, 'remote_worker_error');
      return true;
    }
  );
});
