import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import { OllamaClient } from '../src/ollama.js';
import type { OllamaStreamProgress } from '../src/ollama-stream.js';

function config(directory: string): LocalCoderConfig {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3.8:27b',
    strongModel: 'qwen3.8:27b',
    adaptiveModelsEnabled: false,
    ollamaNumCtx: 16_384,
    fastModelKeepAlive: '90s',
    strongModelKeepAlive: '30s',
    requestTimeoutMs: 5_000,
    inferenceHeaderTimeoutMs: 1_000,
    inferenceFirstChunkTimeoutMs: 1_000,
    inferenceIdleTimeoutMs: 1_000,
    inferenceMaxDurationMs: 30_000,
    investigationMaxDurationMs: 3_000,
    planningMaxDurationMs: 4_000,
    reviewMaxDurationMs: 5_000,
    investigationMaxTokens: 777,
    planningMaxTokens: 1_234,
    reviewMaxTokens: 1_500,
    validationTimeoutMs: 5_000,
    maxFileBytes: 100_000,
    maxContextBytes: 96_000,
    allowedValidationCommands: new Set(['npm']),
    telemetryEnabled: false,
    telemetryPath: path.join(directory, 'telemetry.jsonl'),
    runStorePath: path.join(directory, 'runs'),
    contextIndexPath: path.join(directory, 'indexes'),
    executionMode: 'local',
    remoteWorkerTimeoutMs: 20_000,
    remoteMaxDeltaBytes: 1_000_000,
    workerHost: '127.0.0.1',
    workerPort: 7337,
    workerStatePath: path.join(directory, 'worker'),
    workerMaxBodyBytes: 2_000_000,
    workerAllowedGitHosts: new Set(['github.com']),
    workerBootstrap: 'none',
    workerMaxConcurrentJobs: 1
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function chatResponse(): Response {
  const lines = [
    {
      model: 'qwen3.8:27b',
      message: { role: 'assistant', content: '', thinking: 'active reasoning' },
      done: false
    },
    {
      model: 'qwen3.8:27b',
      message: { role: 'assistant', content: '{"summary":"ok"}' },
      done: false
    },
    {
      model: 'qwen3.8:27b',
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      total_duration: 1_000_000_000,
      prompt_eval_count: 200,
      eval_count: 40
    }
  ];
  return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, { status: 200 });
}

test('planning sends a bounded num_predict and reports thinking-to-generating stream liveness', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-premium-inference-'));
  const originalFetch = globalThis.fetch;
  let chatBody: Record<string, unknown> | undefined;
  const progress: OllamaStreamProgress[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      if (url.endsWith('/api/chat')) {
        chatBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return chatResponse();
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = new OllamaClient(config(directory));
    const generation = await client.chat(
      'You are the reasoning/planning stage of a local software-engineering agent.',
      '# GOAL\nBuild a bounded plan.',
      { type: 'object' },
      { think: 'medium', onStreamProgress: (event) => progress.push(event) }
    );

    const options = chatBody?.options as Record<string, unknown> | undefined;
    assert.equal(options?.num_predict, 1_234);
    assert.equal(chatBody?.think, 'medium');
    assert.equal(generation.content, '{"summary":"ok"}');
    assert.ok(progress.some((event) => event.state === 'thinking'));
    assert.ok(progress.some((event) => event.state === 'generating'));
    assert.ok((progress.at(-1)?.chunkCount ?? 0) >= 3);
    assert.ok((progress.at(-1)?.thinkingChars ?? 0) > 0);
    assert.ok((progress.at(-1)?.outputChars ?? 0) > 0);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Qwen3.8 investigation high intent is reduced to medium and uses the investigation token budget', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-premium-investigation-'));
  const originalFetch = globalThis.fetch;
  let chatBody: Record<string, unknown> | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      if (url.endsWith('/api/chat')) {
        chatBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return chatResponse();
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = new OllamaClient(config(directory));
    await client.chat(
      'You are the investigation stage of a local software-engineering agent.',
      '# GOAL\nFind exact repository evidence.',
      { type: 'object' },
      { think: 'high' }
    );

    const options = chatBody?.options as Record<string, unknown> | undefined;
    assert.equal(options?.num_predict, 777);
    assert.equal(chatBody?.think, 'medium');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
