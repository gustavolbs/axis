import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import { createExecutionRuntime } from '../src/execution-runtime.js';
import type { LocalEngineerResult } from '../src/local-engineer.js';
import type { OllamaClient, OllamaGeneration } from '../src/ollama.js';
import { executePremiumLocalAgent } from '../src/premium-agent.js';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../src/remote-protocol.js';
import { StandaloneJobManager } from '../src/standalone-job-manager.js';

function success(summary: string): LocalEngineerResult {
  return {
    status: 'success',
    phase: 'complete',
    workspace: '/definitely/not/a/repository',
    goal: 'Como vc está?',
    summary,
    investigation: { searchQueries: [], evidenceFiles: [], researchRequests: [] },
    repairRounds: 0,
    changedFiles: [],
    diff: '',
    validation: [],
    modelCalls: []
  };
}

test('chat mode performs exactly one conversational inference without touching a repository', async () => {
  let calls = 0;
  const model: Pick<OllamaClient, 'chat'> = {
    async chat(systemPrompt, userPrompt, format, runtime): Promise<OllamaGeneration> {
      calls += 1;
      assert.match(systemPrompt, /Chat mode, not Cowork mode/);
      assert.equal(userPrompt, 'Como vc está?');
      assert.equal(format, undefined);
      assert.equal(runtime?.think, false);
      return {
        model: 'qwen3.8:27b',
        content: 'Estou bem! E você?'
      } as OllamaGeneration;
    }
  };
  const config = {
    model: 'qwen3.8:27b',
    ollamaNumCtx: 16_384,
    fastModelKeepAlive: '90s',
    reportMaxTokens: 3_072
  } as LocalCoderConfig;

  const execution = await executePremiumLocalAgent(model, config, {
    interactionMode: 'chat',
    workspace: '/definitely/not/a/repository',
    goal: 'Como vc está?'
  });

  assert.equal(calls, 1);
  assert.equal(execution.result.status, 'success');
  assert.equal(execution.result.phase, 'complete');
  assert.equal(execution.result.summary, 'Estou bem! E você?');
  assert.deepEqual(execution.result.changedFiles, []);
  assert.deepEqual(execution.result.validation, []);
  assert.equal(execution.result.escalation, undefined);
  assert.deepEqual(execution.changes, []);
});

test('remote project-less chat uses /v1/chat and never enters remote engineer workspace transport', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    urls.push(url);
    assert.equal(url, 'http://worker.test/v1/chat');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)) as {
      protocolVersion?: number;
      userPrompt?: string;
    };
    assert.equal(body.protocolVersion, REMOTE_WORKER_PROTOCOL_VERSION);
    assert.equal(body.userPrompt, 'Oi, tudo bem?');
    return new Response(JSON.stringify({
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      generation: {
        model: 'qwen3.8:27b',
        content: 'Tudo certo!'
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const config = {
      executionMode: 'remote',
      remoteWorkerUrl: 'http://worker.test',
      remoteWorkerTimeoutMs: 5_000,
      model: 'qwen3.8:27b',
      ollamaNumCtx: 16_384,
      fastModelKeepAlive: '90s',
      reportMaxTokens: 3_072
    } as LocalCoderConfig;
    const runtime = createExecutionRuntime(config, {} as OllamaClient);
    const result = await runtime.execution.executeEngineer({
      interactionMode: 'chat',
      workspace: '',
      goal: 'Oi, tudo bem?'
    });

    assert.equal(result.status, 'success');
    assert.equal(result.summary, 'Tudo certo!');
    assert.deepEqual(urls, ['http://worker.test/v1/chat']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('standalone chat jobs preserve interaction mode and cannot enter guidance checkpoints', async () => {
  let receivedMode: string | undefined;
  const manager = new StandaloneJobManager({
    executeEngineer: async (input) => {
      receivedMode = (input as typeof input & { interactionMode?: string }).interactionMode;
      return success('Resposta direta.');
    }
  });

  const created = manager.create({
    workspace: '/tmp',
    goal: 'Como vc está?',
    interactionMode: 'chat'
  });

  const deadline = Date.now() + 1_000;
  let job = manager.get(created.id)!;
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() > deadline) throw new Error('Timed out waiting for chat job.');
    await new Promise((resolve) => setTimeout(resolve, 5));
    job = manager.get(created.id)!;
  }

  assert.equal(receivedMode, 'chat');
  assert.equal(job.status, 'success');
  assert.equal(job.decisionRequest, undefined);
  assert.equal(job.escalationPlan, undefined);
  assert.ok(job.events.some((event) => event.title === 'Direct chat started'));
  assert.ok(job.events.some((event) => event.title === 'Chat response completed'));
});

test('desktop Chat/Cowork toggle is included in the job payload', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'app/src/AgentSurfaceV2.tsx'), 'utf8');
  assert.match(source, /interactionMode:\s*mode/);
  assert.match(source, /active\.input\.interactionMode\s*!==\s*'chat'/);
});
