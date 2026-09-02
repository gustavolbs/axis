import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnthropicInferenceProvider,
  OllamaInferenceProvider,
  OpenAIInferenceProvider,
  ProviderRegistry
} from '../src/providers/index.js';
import type { OllamaChatOptions, OllamaGeneration, OllamaHealth } from '../src/ollama.js';

function response(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers
  });
}

function sse(blocks: unknown[]): Response {
  const text = blocks
    .map((block) => `data: ${typeof block === 'string' ? block : JSON.stringify(block)}\n\n`)
    .join('');
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function ollamaHealth(): OllamaHealth {
  return {
    ok: true,
    baseUrl: 'http://127.0.0.1:11434',
    configuredModel: 'qwen3.8:27b',
    modelAvailable: true,
    fastModel: 'qwen3.8:27b',
    fastModelAvailable: true,
    strongModel: 'qwen3.8:27b',
    strongModelAvailable: true,
    adaptiveModelsEnabled: false,
    numCtx: 16_384,
    maxParallelInferences: 1,
    globalInferenceLock: true,
    inferenceTimeouts: { headerMs: 1, firstChunkMs: 1, idleMs: 1, maxDurationMs: 1 },
    stageBudgets: {},
    availableModels: ['qwen3.8:27b']
  };
}

test('Ollama remains available through the provider-neutral contract', async () => {
  let runtimeOptions: OllamaChatOptions | undefined;
  const client = {
    health: async () => ollamaHealth(),
    chat: async (
      _system: string,
      _user: string,
      _format?: 'json' | Record<string, unknown>,
      runtime?: OllamaChatOptions
    ): Promise<OllamaGeneration> => {
      runtimeOptions = runtime;
      runtime?.onStreamProgress?.({
        state: 'thinking',
        chunkCount: 1,
        thinkingChars: 50,
        outputChars: 0,
        lastActivityAt: new Date().toISOString()
      });
      runtime?.onStreamProgress?.({
        state: 'generating',
        chunkCount: 2,
        thinkingChars: 50,
        outputChars: 11,
        lastActivityAt: new Date().toISOString()
      });
      return {
        content: '{"ok":true}',
        model: 'qwen3.8:27b',
        doneReason: 'stop',
        totalDurationNs: 1_000_000,
        promptTokens: 20,
        completionTokens: 5
      };
    }
  };
  const provider = new OllamaInferenceProvider(client);
  const states: string[] = [];
  const models = await provider.listModels();
  const result = await provider.invoke({
    model: 'qwen3.8:27b',
    systemPrompt: 'system',
    userPrompt: 'user',
    output: { type: 'json_schema', schema: { type: 'object' } },
    reasoning: { effort: 'high' },
    onProgress: (progress) => states.push(progress.state)
  });

  assert.deepEqual(models.map((model) => model.id), ['qwen3.8:27b']);
  assert.equal(runtimeOptions?.model, 'qwen3.8:27b');
  assert.equal(runtimeOptions?.think, 'high');
  assert.equal(result.content, '{"ok":true}');
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 5, totalTokens: 25 });
  assert.ok(states.includes('reasoning'));
  assert.ok(states.includes('generating'));
});

test('Anthropic model discovery and invocation are independent of Ollama', async () => {
  const secret = 'sk-ant-test-super-secret';
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/v1/models')) {
      return response({
        data: [{
          id: 'claude-opus-5',
          display_name: 'Claude Opus 5',
          created_at: '2026-07-24T00:00:00Z',
          max_input_tokens: 1_000_000,
          max_tokens: 300_000,
          capabilities: {
            structured_outputs: { supported: true },
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: true },
              high: { supported: true },
              xhigh: { supported: true },
              max: { supported: true }
            },
            thinking: {
              supported: true,
              types: { adaptive: { supported: true }, enabled: { supported: true } }
            }
          }
        }],
        has_more: false,
        last_id: 'claude-opus-5'
      });
    }
    if (url.endsWith('/v1/messages')) {
      return response({
        id: 'msg_test',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: '{"answer":"ok"}' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
          output_tokens: 30,
          output_tokens_details: { thinking_tokens: 5 }
        }
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const provider = new AnthropicInferenceProvider({ apiKey: secret, fetch: fetchImpl });
  const models = await provider.listModels();
  const result = await provider.invoke({
    model: 'claude-opus-5',
    systemPrompt: 'system',
    userPrompt: 'user',
    output: {
      type: 'json_schema',
      name: 'answer',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { answer: { type: 'string' } },
        required: ['answer']
      }
    },
    reasoning: { effort: 'high' },
    maxOutputTokens: 8_192
  });

  assert.equal(models[0]?.displayName, 'Claude Opus 5');
  assert.equal(models[0]?.capabilities?.structuredOutput, true);
  assert.equal(result.providerId, 'anthropic');
  assert.equal(result.content, '{"answer":"ok"}');
  assert.equal(result.usage.inputTokens, 130);
  assert.equal(result.usage.cacheReadInputTokens, 20);
  assert.equal(result.usage.cacheWriteInputTokens, 10);
  assert.equal(result.usage.reasoningTokens, 5);
  assert.equal(result.usage.totalTokens, 160);
  assert.ok(calls.every((call) => !call.url.includes('ollama')));

  const messageCall = calls.find((call) => call.url.endsWith('/v1/messages'));
  assert.ok(messageCall);
  const body = JSON.parse(String(messageCall.init?.body)) as Record<string, unknown>;
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, {
    format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { answer: { type: 'string' } },
        required: ['answer']
      }
    },
    effort: 'high'
  });
});

test('Anthropic streaming reports operational state without exposing thinking text', async () => {
  const progress: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/messages')) {
      return sse([
        {
          type: 'message_start',
          message: { id: 'msg_stream', model: 'claude-opus-5', usage: { input_tokens: 4 } }
        },
        {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'private reasoning must not surface' }
        },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2, output_tokens_details: { thinking_tokens: 1 } }
        },
        { type: 'message_stop' }
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const provider = new AnthropicInferenceProvider({ apiKey: 'sk-ant-stream-secret', fetch: fetchImpl });
  const result = await provider.invoke({
    model: 'claude-opus-5',
    systemPrompt: 'system',
    userPrompt: 'user',
    onProgress: (event) => progress.push(event as unknown as Record<string, unknown>)
  });

  assert.equal(result.content, 'hello');
  assert.ok(progress.some((event) => event.state === 'reasoning'));
  assert.ok(progress.some((event) => event.state === 'generating'));
  assert.equal(JSON.stringify(progress).includes('private reasoning must not surface'), false);
});

test('Anthropic errors redact API keys', async () => {
  const secret = 'sk-ant-should-never-leak';
  const provider = new AnthropicInferenceProvider({
    apiKey: secret,
    fetch: async () => response(`invalid key ${secret}`, 401)
  });
  await assert.rejects(
    provider.invoke({ model: 'claude-opus-5', systemPrompt: 's', userPrompt: 'u' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      assert.ok(error.message.includes('[REDACTED]'));
      return true;
    }
  );
});

test('OpenAI uses Responses API with store disabled and normalizes detailed usage', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/models')) {
      return response({
        data: [
          { id: 'gpt-5.6-sol', created: 1780000000, owned_by: 'openai' },
          { id: 'gpt-5.4-mini', created: 1770000000, owned_by: 'openai' }
        ]
      });
    }
    if (url.endsWith('/responses')) {
      return response({
        id: 'resp_test',
        model: 'gpt-5.6-sol',
        status: 'completed',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: '{"answer":"ok"}' }]
        }],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
          output_tokens: 25,
          output_tokens_details: { reasoning_tokens: 8 },
          total_tokens: 145
        }
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const provider = new OpenAIInferenceProvider({ apiKey: 'sk-openai-secret-value', fetch: fetchImpl });
  const models = await provider.listModels();
  const result = await provider.invoke({
    model: 'gpt-5.6-sol',
    systemPrompt: 'system',
    userPrompt: 'user',
    reasoning: { effort: 'high' },
    output: {
      type: 'json_schema',
      name: 'answer',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { answer: { type: 'string' } },
        required: ['answer']
      }
    }
  });

  assert.deepEqual(models.map((model) => model.id), ['gpt-5.6-sol', 'gpt-5.4-mini']);
  assert.equal(models[1]?.contextWindow, 400_000);
  assert.equal(models[1]?.maxOutputTokens, 128_000);
  assert.equal(result.content, '{"answer":"ok"}');
  assert.equal(result.usage.cacheReadInputTokens, 40);
  assert.equal(result.usage.cacheWriteInputTokens, 10);
  assert.equal(result.usage.reasoningTokens, 8);
  assert.ok(calls.every((call) => !call.url.includes('ollama')));

  const responseCall = calls.find((call) => call.url.endsWith('/responses'));
  assert.ok(responseCall);
  const body = JSON.parse(String(responseCall.init?.body)) as Record<string, unknown>;
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.deepEqual(body.text, {
    format: {
      type: 'json_schema',
      name: 'answer',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { answer: { type: 'string' } },
        required: ['answer']
      }
    }
  });
});

test('OpenAI streaming exposes state and output but not reasoning text', async () => {
  const states: string[] = [];
  const provider = new OpenAIInferenceProvider({
    apiKey: 'sk-openai-stream-secret',
    fetch: async () => sse([
      { type: 'response.reasoning_summary_text.delta', delta: 'safe-or-private provider detail' },
      { type: 'response.output_text.delta', delta: 'hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_stream',
          model: 'gpt-5.6-sol',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
          usage: {
            input_tokens: 3,
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 5
          }
        }
      }
    ])
  });
  const result = await provider.invoke({
    model: 'gpt-5.6-sol',
    systemPrompt: 's',
    userPrompt: 'u',
    onProgress: (event) => states.push(event.state)
  });

  assert.equal(result.content, 'hello');
  assert.ok(states.includes('reasoning'));
  assert.ok(states.includes('generating'));
});

test('provider registry keeps providers explicit and rejects duplicate ids', async () => {
  const local = new OllamaInferenceProvider({
    health: async () => ollamaHealth(),
    chat: async () => ({ content: 'ok', model: 'qwen3.8:27b' })
  });
  const registry = new ProviderRegistry([local]);
  assert.equal(registry.get('ollama'), local);
  assert.equal(registry.has('anthropic'), false);
  assert.throws(() => registry.register(local), /already registered/);
  assert.deepEqual((await registry.listModels()).map((model) => model.providerId), ['ollama']);
});
