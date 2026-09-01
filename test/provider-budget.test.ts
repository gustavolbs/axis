import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PricingStore } from '../src/pricing-store.js';
import { ProviderBudgetError, ProviderBudgetManager } from '../src/provider-budget.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import type {
  InferenceProvider,
  InferenceRequest,
  ProviderCapabilities
} from '../src/providers/types.js';
import { UsageLedger } from '../src/usage-ledger.js';

function temp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `local-coder-provider-budget-${name}-`));
}

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: false,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

function request(maxOutputTokens?: number): InferenceRequest {
  return {
    model: 'future-chat-1',
    systemPrompt: 'You are concise.',
    userPrompt: 'Say hello.',
    maxOutputTokens
  };
}

function provider(
  kind: 'local' | 'cloud' = 'cloud',
  invoke?: InferenceProvider['invoke']
): InferenceProvider {
  return {
    id: kind === 'local' ? 'ollama' : 'future-ai',
    kind,
    capabilities,
    async listModels() {
      return [{ providerId: this.id, id: 'future-chat-1', displayName: 'Future Chat 1' }];
    },
    async health() {
      return {
        providerId: this.id,
        ok: true,
        checkedAt: new Date(0).toISOString(),
        latencyMs: 1
      };
    },
    invoke: invoke ?? (async (input) => ({
      providerId: this.id,
      model: input.model,
      content: 'ok',
      latencyMs: 1,
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 }
    }))
  };
}

function fixture(name: string, now = new Date('2026-09-12T12:00:00.000Z')) {
  const root = temp(name);
  const settings = new ProviderSettingsStore(path.join(root, 'providers.json'));
  const pricing = new PricingStore(path.join(root, 'pricing.json'));
  const ledger = new UsageLedger(path.join(root, 'usage'));
  const budget = new ProviderBudgetManager({ settings, pricing, ledger, now: () => now });
  return { root, settings, pricing, ledger, budget, now };
}

function appendSpend(
  ledger: UsageLedger,
  timestamp: string,
  costUsd?: number
): void {
  ledger.append({
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    timestamp,
    projectId: 'project-a',
    organizationId: 'org-a',
    stage: 'other',
    providerId: 'future-ai',
    providerKind: 'cloud',
    modelId: 'future-chat-1',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    latencyMs: 1,
    costUsd,
    fallbackUsed: false
  });
}

test('provider monthly budget persists and null restores Unlimited', () => {
  const { settings, root } = fixture('settings');
  const finite = settings.update('future-ai', { monthlyBudgetUsd: 25.5 });
  assert.equal(finite.monthlyBudgetUsd, 25.5);

  const unlimited = settings.update('future-ai', { monthlyBudgetUsd: null });
  assert.equal(unlimited.monthlyBudgetUsd, undefined);

  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'providers.json'), 'utf8')) as {
    providers: Record<string, { monthlyBudgetUsd?: number }>;
  };
  assert.equal('monthlyBudgetUsd' in persisted.providers['future-ai']!, false);
  assert.throws(() => settings.update('future-ai', { monthlyBudgetUsd: 0 }), /positive USD amount/);
});

test('Unlimited cloud provider does not require pricing or an output bound', async () => {
  const { budget } = fixture('unlimited');
  let calls = 0;
  const wrapped = budget.wrap(provider('cloud', async (input) => {
    calls += 1;
    return {
      providerId: 'future-ai',
      model: input.model,
      content: 'ok',
      latencyMs: 1,
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }
    };
  }));

  const result = await wrapped.invoke(request());
  assert.equal(result.content, 'ok');
  assert.equal(calls, 1);
});

test('finite provider budget permits a call whose conservative upper bound fits', async () => {
  const { settings, pricing, budget } = fixture('permit');
  settings.update('future-ai', { monthlyBudgetUsd: 1 });
  pricing.set('future-ai', 'future-chat-1', {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 10
  });
  let calls = 0;
  const wrapped = budget.wrap(provider('cloud', async (input) => {
    calls += 1;
    return {
      providerId: 'future-ai',
      model: input.model,
      content: 'ok',
      latencyMs: 1,
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 }
    };
  }));

  await wrapped.invoke(request(1_000));
  assert.equal(calls, 1);
});

test('finite provider budget blocks before inference when projected monthly spend exceeds the cap', async () => {
  const { settings, pricing, ledger, budget, now } = fixture('block');
  settings.update('future-ai', { monthlyBudgetUsd: 1 });
  pricing.set('future-ai', 'future-chat-1', {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 100
  });
  appendSpend(ledger, now.toISOString(), 0.95);
  let calls = 0;
  const wrapped = budget.wrap(provider('cloud', async (input) => {
    calls += 1;
    return {
      providerId: 'future-ai', model: input.model, content: 'should-not-run', latencyMs: 1, usage: {}
    };
  }));

  await assert.rejects(
    wrapped.invoke(request(1_000)),
    (error: unknown) => error instanceof ProviderBudgetError && error.code === 'monthly-budget-exceeded'
  );
  assert.equal(calls, 0);
});

test('finite provider budget fails closed when current-month cloud usage is unpriced', async () => {
  const { settings, pricing, ledger, budget, now } = fixture('unpriced');
  settings.update('future-ai', { monthlyBudgetUsd: 5 });
  pricing.set('future-ai', 'future-chat-1', {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 10
  });
  appendSpend(ledger, now.toISOString());

  await assert.rejects(
    budget.wrap(provider()).invoke(request(100)),
    (error: unknown) => error instanceof ProviderBudgetError && error.code === 'historical-cost-unknown'
  );
});

test('concurrent provider reservations prevent two calls from jointly crossing the cap', async () => {
  const { settings, pricing, budget } = fixture('concurrency');
  settings.update('future-ai', { monthlyBudgetUsd: 0.15 });
  pricing.set('future-ai', 'future-chat-1', {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 100
  });

  let releaseFirst!: () => void;
  let calls = 0;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const wrapped = budget.wrap(provider('cloud', async (input) => {
    calls += 1;
    await firstGate;
    return {
      providerId: 'future-ai', model: input.model, content: 'ok', latencyMs: 1, usage: {}
    };
  }));

  const first = wrapped.invoke(request(1_000));
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(
    wrapped.invoke(request(1_000)),
    (error: unknown) => error instanceof ProviderBudgetError && error.code === 'monthly-budget-exceeded'
  );
  assert.equal(calls, 1);
  releaseFirst();
  await first;
});

test('local providers bypass monetary budget enforcement because API cost is zero', async () => {
  const { settings, budget } = fixture('local');
  settings.update('ollama', { monthlyBudgetUsd: 0.01 });
  let calls = 0;
  const local = provider('local', async (input) => {
    calls += 1;
    return {
      providerId: 'ollama', model: input.model, content: 'local', latencyMs: 1, usage: {}
    };
  });
  const wrapped = budget.wrap(local);
  assert.equal(wrapped, local);
  await wrapped.invoke(request());
  assert.equal(calls, 1);
});

test('provider budgets are wired generically into cloud factories and Usage settings', () => {
  const runtime = fs.readFileSync(path.join(process.cwd(), 'src/project-provider-runtime.ts'), 'utf8').replace(/\r\n/g, '\n');
  const surface = fs.readFileSync(path.join(process.cwd(), 'app/src/UsageSettings.tsx'), 'utf8').replace(/\r\n/g, '\n');

  assert.match(runtime, /this\.budget\.wrap\(provider\)/);
  assert.match(runtime, /\.\.\.Object\.keys\(this\.factories\)/);
  assert.match(surface, /Provider budgets/);
  assert.match(surface, /monthlyBudgetUsd/);
  assert.match(surface, /Unlimited/);
  assert.match(surface, /\/api\/providers\/\$\{encodeURIComponent\(providerId\)\}/);
});
