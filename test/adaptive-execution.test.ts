import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, type LocalCoderConfig } from '../src/config.js';
import { executeAgenticCodeTask } from '../src/executor.js';
import type { OllamaChatOptions, OllamaGeneration } from '../src/ollama.js';

function config(overrides: Partial<LocalCoderConfig> = {}): LocalCoderConfig {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: 'fast-7b',
    strongModel: 'strong-14b',
    adaptiveModelsEnabled: true,
    ollamaNumCtx: 16_384,
    fastModelKeepAlive: '90s',
    strongModelKeepAlive: '30s',
    requestTimeoutMs: 5_000,
    validationTimeoutMs: 10_000,
    maxFileBytes: 100_000,
    maxContextBytes: 96_000,
    allowedValidationCommands: new Set(['npm', 'pnpm', 'yarn', 'bun']),
    telemetryEnabled: false,
    telemetryPath: path.join(os.tmpdir(), 'unused-adaptive-telemetry.jsonl'),
    runStorePath: path.join(os.tmpdir(), 'unused-adaptive-runs'),
    contextIndexPath: path.join(os.tmpdir(), 'unused-adaptive-indexes'),
    ...overrides
  };
}

function generation(model: string, content: string): OllamaGeneration {
  return {
    content,
    model,
    doneReason: 'stop',
    promptTokens: 10,
    completionTokens: 5,
    totalDurationNs: 1_000_000
  };
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-adaptive-'));
  try {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src/value.ts'), 'export const value = 1;\n');
    await run(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test('defaults adaptive mode to 7b fast, 14b strong, and bounded context', () => {
  const result = loadConfig({});
  assert.equal(result.adaptiveModelsEnabled, true);
  assert.equal(result.model, 'qwen2.5-coder:7b');
  assert.equal(result.strongModel, 'qwen2.5-coder:14b');
  assert.equal(result.ollamaNumCtx, 16_384);
  assert.equal(result.maxContextBytes, 96_000);
});

test('legacy single-model mode can still be explicitly enabled', () => {
  const result = loadConfig({
    LOCAL_CODER_ADAPTIVE_MODELS: 'false',
    LOCAL_CODER_MODEL: 'legacy-model'
  });
  assert.equal(result.adaptiveModelsEnabled, false);
  assert.equal(result.model, 'legacy-model');
});

test('uses fast model first and escalates a failed proposal to the strong model', async () => {
  await withWorkspace(async (workspace) => {
    const calls: OllamaChatOptions[] = [];
    let attempt = 0;
    const model = {
      async chat(
        _system: string,
        _user: string,
        _format?: 'json' | Record<string, unknown>,
        runtime: OllamaChatOptions = {}
      ) {
        calls.push(runtime);
        attempt += 1;
        if (attempt === 1) return generation('fast-7b', 'not-json');
        return generation(
          'strong-14b',
          JSON.stringify({
            summary: 'Updated value.',
            files: [{ path: 'src/value.ts', content: 'export const value = 2;\n' }]
          })
        );
      }
    };

    const result = await executeAgenticCodeTask(model, config(), {
      workspace,
      task: 'Apply the already-decided bounded TypeScript update.',
      editableFiles: ['src/value.ts'],
      maxAttempts: 2
    });

    assert.equal(result.status, 'success');
    assert.equal(result.modelEscalated, true);
    assert.deepEqual(
      calls.map((call) => call.model),
      ['fast-7b', 'strong-14b']
    );
    assert.deepEqual(
      result.generations.map((item) => item.tier),
      ['fast', 'strong']
    );
    assert.equal(await fs.readFile(path.join(workspace, 'src/value.ts'), 'utf8'), 'export const value = 2;\n');
  });
});

test('successful bounded work stays entirely on the fast model', async () => {
  await withWorkspace(async (workspace) => {
    const calls: OllamaChatOptions[] = [];
    const model = {
      async chat(
        _system: string,
        _user: string,
        _format?: 'json' | Record<string, unknown>,
        runtime: OllamaChatOptions = {}
      ) {
        calls.push(runtime);
        return generation(
          'fast-7b',
          JSON.stringify({
            summary: 'Updated value.',
            files: [{ path: 'src/value.ts', content: 'export const value = 2;\n' }]
          })
        );
      }
    };

    const result = await executeAgenticCodeTask(model, config(), {
      workspace,
      task: 'Apply the already-decided bounded TypeScript update.',
      editableFiles: ['src/value.ts'],
      maxAttempts: 2
    });

    assert.equal(result.status, 'success');
    assert.equal(result.modelEscalated, false);
    assert.deepEqual(calls.map((call) => call.model), ['fast-7b']);
  });
});
