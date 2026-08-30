import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import { OllamaClient } from '../src/ollama.js';

function config(directory: string): LocalCoderConfig {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: 'fast-7b',
    strongModel: 'strong-14b',
    adaptiveModelsEnabled: true,
    ollamaNumCtx: 16_384,
    fastModelKeepAlive: '90s',
    strongModelKeepAlive: '30s',
    requestTimeoutMs: 5_000,
    validationTimeoutMs: 5_000,
    maxFileBytes: 100_000,
    maxContextBytes: 96_000,
    allowedValidationCommands: new Set(['npm']),
    telemetryEnabled: false,
    telemetryPath: path.join(directory, 'telemetry.jsonl'),
    runStorePath: path.join(directory, 'runs'),
    contextIndexPath: path.join(directory, 'indexes')
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('serializes inference across independent OllamaClient instances', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-global-lock-'));
  const originalFetch = globalThis.fetch;
  let activeChats = 0;
  let maxActiveChats = 0;

  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      if (url.endsWith('/api/chat')) {
        activeChats += 1;
        maxActiveChats = Math.max(maxActiveChats, activeChats);
        await new Promise((resolve) => setTimeout(resolve, 80));
        activeChats -= 1;
        return jsonResponse({
          model: 'fast-7b',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 2
        });
      }
      if (url.endsWith('/api/generate')) return jsonResponse({ done: true, done_reason: 'unload' });
      throw new Error(`Unexpected URL: ${url}`);
    };

    const first = new OllamaClient(config(directory));
    const second = new OllamaClient(config(directory));
    await Promise.all([
      first.chat('system', 'first'),
      second.chat('system', 'second')
    ]);

    assert.equal(maxActiveChats, 1);
    await assert.rejects(() => fs.stat(path.join(directory, 'inference.lock')), { code: 'ENOENT' });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('unloads the other configured tier before starting inference', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-tier-unload-'));
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/ps')) {
        return jsonResponse({ models: [{ model: 'strong-14b' }] });
      }
      if (url.endsWith('/api/generate')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; keep_alive?: number };
        assert.equal(body.model, 'strong-14b');
        assert.equal(body.keep_alive, 0);
        return jsonResponse({ done: true, done_reason: 'unload' });
      }
      if (url.endsWith('/api/chat')) {
        return jsonResponse({
          model: 'fast-7b',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          done_reason: 'stop'
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = new OllamaClient(config(directory));
    await client.chat('system', 'task', undefined, { model: 'fast-7b' });

    assert.deepEqual(
      calls.map((url) => url.split('/').at(-1)),
      ['ps', 'generate', 'chat']
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
