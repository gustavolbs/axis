import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OperationCancelledError,
  currentCancellationSignal,
  withCancellationSignal
} from '../src/cancellation.js';
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
import { StandaloneJobManager } from '../src/standalone-job-manager.js';
import { runValidationCommand } from '../src/validation.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

class TestProvider implements InferenceProvider {
  readonly capabilities = capabilities;
  calls = 0;

  constructor(
    readonly id: string,
    readonly kind: 'local' | 'cloud',
    private readonly modelId: string,
    private readonly invokeFn: (request: InferenceRequest) => Promise<InferenceResult>
  ) {}

  async listModels(): Promise<ModelDefinition[]> {
    return [{ providerId: this.id, id: this.modelId, displayName: this.modelId, capabilities }];
  }

  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, ok: true, checkedAt: new Date().toISOString(), latencyMs: 1 };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    this.calls += 1;
    return await this.invokeFn(request);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('standalone cancellation is terminal and cancelled jobs are not resumed after restore', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-cancel-'));
  let executions = 0;
  const execution = {
    executeEngineer: async () => {
      executions += 1;
      const signal = currentCancellationSignal();
      await new Promise<void>((resolve, reject) => {
        if (!signal) return reject(new Error('missing cancellation context'));
        if (signal.aborted) return reject(new OperationCancelledError());
        signal.addEventListener('abort', () => reject(new OperationCancelledError()), { once: true });
      });
      throw new Error('unreachable');
    }
  };

  const manager = new StandaloneJobManager(execution, stateDir);
  const created = manager.create({ workspace: stateDir, goal: 'long task' });
  await waitFor(() => manager.get(created.id)?.status === 'running');
  const cancelled = await manager.cancel(created.id);
  assert.equal(cancelled.status, 'cancelled');
  await waitFor(() => manager.get(created.id)?.status === 'cancelled');

  const restoredExecutions = executions;
  const restored = new StandaloneJobManager(execution, stateDir);
  await restored.restore();
  assert.equal(restored.get(created.id)?.status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(executions, restoredExecutions);
  assert.ok(restored.get(created.id)?.events.some((event) => event.type === 'cancelled'));
});

test('provider cancellation releases the attempt and never falls back', async () => {
  const cloud = new TestProvider('anthropic', 'cloud', 'cloud-fast', async () => {
    const signal = currentCancellationSignal();
    await new Promise<void>((_resolve, reject) => {
      if (!signal) return reject(new Error('missing cancellation context'));
      if (signal.aborted) return reject(new OperationCancelledError());
      signal.addEventListener('abort', () => reject(new OperationCancelledError()), { once: true });
    });
    throw new Error('unreachable');
  });
  const local = new TestProvider('ollama', 'local', 'local', async (request) => ({
    providerId: 'ollama',
    model: request.model,
    content: 'must not run',
    latencyMs: 1,
    usage: {}
  }));
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([cloud, local]));
  const controller = new AbortController();
  const released: string[] = [];

  const invocation = withCancellationSignal(controller.signal, () => runtime.invoke({
    inference: { systemPrompt: 'system', userPrompt: 'user', stage: 'planning' },
    routing: {
      project: {
        id: 'cancel-project',
        defaultRoutingPolicy: 'speed-first',
        defaultModel: { mode: 'auto' },
        privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic', 'ollama'] }
      },
      stage: 'planning',
      candidates: [
        {
          providerId: 'anthropic', modelId: 'cloud-fast', providerKind: 'cloud', available: true,
          capabilities, p50LatencyMs: 1, queueDelayMs: 0, qualityScore: 90, estimatedCostUsd: 0.01
        },
        {
          providerId: 'ollama', modelId: 'local', providerKind: 'local', available: true,
          capabilities, p50LatencyMs: 999_999, queueDelayMs: 999_999, qualityScore: 70, estimatedCostUsd: 0
        }
      ]
    },
    onAttemptFailure: ({ candidate }) => {
      released.push(`${candidate.providerId}/${candidate.modelId}`);
    }
  }));

  await waitFor(() => cloud.calls === 1);
  controller.abort();
  await assert.rejects(invocation, (error: unknown) => error instanceof OperationCancelledError);
  assert.deepEqual(released, ['anthropic/cloud-fast']);
  assert.equal(local.calls, 0);
});

test('active validation subprocess is terminated by cancellation', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-validation-cancel-'));
  const controller = new AbortController();
  const running = withCancellationSignal(controller.signal, () => runValidationCommand(
    workspace,
    { command: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'] },
    new Set(['node']),
    20_000
  ));
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, (error: unknown) => error instanceof OperationCancelledError);
});
