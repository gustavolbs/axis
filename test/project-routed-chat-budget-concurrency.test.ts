import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RoutingCandidate } from '../src/cognitive-router.js';
import type { OllamaClient } from '../src/ollama.js';
import { PricingStore } from '../src/pricing-store.js';
import { ProjectBudgetSession } from '../src/project-budget.js';
import type { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import { ProjectRoutedChatClient } from '../src/project-routed-chat.js';
import { ProjectStore } from '../src/project-store.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth
} from '../src/providers/types.js';
import { UsageLedger } from '../src/usage-ledger.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

class DeferredCloudProvider implements InferenceProvider {
  readonly id = 'anthropic';
  readonly kind = 'cloud' as const;
  readonly capabilities = capabilities;
  private readonly pending = new Map<string, () => void>();

  get pendingCount(): number {
    return this.pending.size;
  }

  async listModels(): Promise<ModelDefinition[]> {
    return [{
      providerId: this.id,
      id: 'same-model',
      displayName: 'Same Model',
      capabilities
    }];
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      modelsAvailable: 1
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    return await new Promise<InferenceResult>((resolve) => {
      this.pending.set(request.userPrompt, () => {
        this.pending.delete(request.userPrompt);
        resolve({
          providerId: this.id,
          model: request.model,
          content: request.userPrompt,
          latencyMs: 5,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
        });
      });
    });
  }

  complete(userPrompt: string): void {
    const resolve = this.pending.get(userPrompt);
    if (!resolve) throw new Error(`No pending inference for ${userPrompt}.`);
    resolve();
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for concurrent provider calls.');
}

test('concurrent routed calls to the same model settle their own reservations out of order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-routed-budget-concurrency-'));
  const workspace = path.join(root, 'repo');
  fs.mkdirSync(workspace);
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  const project = projects.create({
    id: 'concurrent-project',
    name: 'Concurrent Project',
    workspace,
    organizationId: 'company-a',
    defaultRoutingPolicy: 'balanced',
    defaultModel: { mode: 'explicit', providerId: 'anthropic', modelId: 'same-model' },
    privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic'] },
    budgets: { dailyUsd: 10, monthlyUsd: 100, perJobUsd: 10 }
  });

  const pricing = new PricingStore(path.join(root, 'pricing.json'));
  pricing.set('anthropic', 'same-model', {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 1,
    source: 'test-price',
    verifiedAt: '2026-08-31T00:00:00.000Z'
  });
  const ledger = new UsageLedger(path.join(root, 'usage'));
  const fixedNow = new Date('2026-08-31T12:00:00.000Z');
  const budget = new ProjectBudgetSession(project, pricing, ledger, {
    jobId: 'concurrent-job',
    now: () => fixedNow
  });

  const cloud = new DeferredCloudProvider();
  const registry = new ProviderRegistry([cloud]);
  const candidate: RoutingCandidate = {
    providerId: 'anthropic',
    modelId: 'same-model',
    providerKind: 'cloud',
    available: true,
    capabilities,
    qualityScore: 95
  };
  const providerRuntime = {
    routingCandidates: async () => ({ registry, candidates: [candidate] })
  } as unknown as ProjectProviderRuntime;
  const legacyLocal = {
    chat: async () => { throw new Error('Legacy local chat must not run.'); }
  } as unknown as Pick<OllamaClient, 'chat'>;
  const chat = new ProjectRoutedChatClient(project, providerRuntime, legacyLocal, { budget });

  const large = chat.chat(
    'You are the reasoning/planning stage of a local software-engineering agent.',
    'large-call',
    undefined,
    { maxTokens: 1_000 }
  );
  const small = chat.chat(
    'You are the reasoning/planning stage of a local software-engineering agent.',
    'small-call',
    undefined,
    { maxTokens: 10 }
  );

  await waitFor(() => cloud.pendingCount === 2);
  const initialReservations = ledger.listReservations(project.id, fixedNow);
  assert.equal(initialReservations.length, 2);
  const upperBounds = initialReservations.map((reservation) => reservation.upperBoundCostUsd).sort((a, b) => a - b);
  assert.ok(upperBounds[1]! > upperBounds[0]!);

  cloud.complete('small-call');
  const smallResult = await small;
  assert.equal(smallResult.content, 'small-call');

  const afterSmall = ledger.listReservations(project.id, fixedNow);
  assert.equal(afterSmall.length, 1);
  assert.equal(afterSmall[0]?.upperBoundCostUsd, upperBounds[1]);

  cloud.complete('large-call');
  const largeResult = await large;
  assert.equal(largeResult.content, 'large-call');
  assert.equal(ledger.listReservations(project.id, fixedNow).length, 0);

  const events = ledger.list(project.id);
  assert.equal(events.length, 2);
  assert.equal(events.every((event) => event.jobId === 'concurrent-job'), true);
});
