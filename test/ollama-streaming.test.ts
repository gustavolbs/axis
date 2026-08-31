import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import { OllamaClient, preparePromptForInference } from '../src/ollama.js';

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

test('uses streaming Ollama chat and aggregates NDJSON chunks into one generation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-streaming-'));
  const originalFetch = globalThis.fetch;
  let chatBody: Record<string, unknown> | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [] });
      if (url.endsWith('/api/chat')) {
        chatBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const lines = [
          { model: 'qwen3.8:27b', message: { role: 'assistant', content: '{"sum' }, done: false },
          { model: 'qwen3.8:27b', message: { role: 'assistant', content: 'mary":"ok"}' }, done: false },
          {
            model: 'qwen3.8:27b',
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
            total_duration: 12_000_000,
            prompt_eval_count: 120,
            eval_count: 14
          }
        ];
        return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const client = new OllamaClient(config(directory));
    const generation = await client.chat('system', 'user', { type: 'object' });

    assert.equal(chatBody?.stream, true);
    assert.equal(generation.content, '{"summary":"ok"}');
    assert.equal(generation.promptTokens, 120);
    assert.equal(generation.completionTokens, 14);
    assert.equal(generation.doneReason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('bounds planning prompts while preserving the goal and validation tail', () => {
  const system = 'You are the reasoning/planning stage of a local software-engineering agent.';
  const hugeEvidence = 'evidence-line\n'.repeat(8_000);
  const original = `# GOAL\nKeep the public contract stable.\n\n# VERIFIED FILE CONTENT\n${hugeEvidence}\n# ALLOWED VALIDATION SCRIPTS\ncheck, test`;
  const prepared = preparePromptForInference(system, original, 16_384);

  assert.equal(prepared.truncated, true);
  assert.ok(prepared.userPrompt.length <= 48_000);
  assert.ok(prepared.userPrompt.includes('Keep the public contract stable.'));
  assert.ok(prepared.userPrompt.includes('# ALLOWED VALIDATION SCRIPTS'));
  assert.ok(prepared.userPrompt.includes('[planning evidence truncated'));
  assert.equal(prepared.originalUserPromptChars, original.length);
});
