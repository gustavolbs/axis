import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PricingStore } from '../src/pricing-store.js';
import {
  DEFAULT_BUDGETED_MAX_OUTPUT_TOKENS,
  PROVIDER_BUDGET_PROJECT_ID,
  ProviderBudgetError,
  ProviderBudgetManager
} from '../src/provider-budget.js';
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
  invoke?: InferenceProvider['invoke'],
  maxOutputTokens?: number
): InferenceProvider {
  const providerId = kind === 'local' ? 'ollama' : 'future-ai';
  return {
    id: providerId,
    kind,
    capabilities,
    async listModels() {
      return [{
        providerId: this.id,
        id: 'future-chat-1',
        displayName: 'Future Chat 1',
        maxOutputTokens
      }];
    },
    async health() {
      return { providerId: this.id, ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 1 };
    },
    invoke: invoke ?? (async (input) => ({
      providerId,
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
  costUsd?: number,
  billingId?: string,
  modelId = 'future-chat-1'
): void {
  ledger.append({
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    timestamp,
    projectId: 'project-a',
    organizationId: 'org-a',
    stage: 'other',
    providerId: 'future-ai',
    providerKind: 'cloud',
    modelId,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    latencyMs: 1,
    costUsd,
    billingId,
    fallbackUsed: false
  });
}

function configureFiniteBudget(input: ReturnType<typeof fixture>, monthlyBudgetUsd = 1): void {
  input.settings.update('future-ai', { unlimitedUsage: false, monthlyBudgetUsd });
  input.pricing.set('future-ai', 'future-chat-1', {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 10
  });
}

test('provider spend policy persists explicit Unlimited and finite monthly budget modes', () => {
  const { settings, root } = fixture('settings');
  const finite = settings.update('future-ai', { unlimitedUsage: false, monthlyBudgetUsd: 25.5 });
  assert.equal(finite.unlimitedUsage, false);
  assert.equal(finite.monthlyBudgetUsd, 25.5);

  const unlimited = settings.update('future-ai', { unlimitedUsage: true, monthlyBudgetUsd: null });
  assert.equal(unlimited.unlimitedUsage, true);
  assert.equal(unlimited.monthlyBudgetUsd, undefined);

  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'providers.json'), 'utf8')) as {
    providers: Record<string, { unlimitedUsage?: boolean; monthlyBudgetUsd?: number }>;
  };
  assert.equal(persisted.providers['future-ai']?.unlimitedUsage, true);
  assert.equal('monthlyBudgetUsd' in persisted.providers['future-ai']!, false);
  assert.throws(() => settings.update('future-ai', { unlimitedUsage: false, monthlyBudgetUsd: 0 }), /positive USD amount/);
});

test('cloud spend is disabled until Unlimited or a finite budget is explicitly configured', async () => {
  const { budget } = fixture('no-policy');
  let calls = 0;
  const wrapped = budget.wrap(provider('cloud', async (input) => {
    calls += 1;
    return { providerId: 'future-ai', model: input.model, content: 'no', latencyMs: 1, usage: {} };
  }));
  await assert.rejects(
    wrapped.invoke(request(100)),
    (error: unknown) => error instanceof ProviderBudgetError && error.code === 'budget-configuration-required'
  );
  assert.equal(calls, 0);
});

test('explicit Unlimited cloud provider does not require pricing or an output bound', async () => {
  const { settings, budget } = fixture('unlimited');
  settings.update('future-ai', { unlimitedUsage: true });
  let calls = 0;
  const wrapped = budget.wrap(provider('cloud', async (input) => {
    calls += 1;
    return {
      providerId: 'future-ai', model: input.model, content: 'ok', latencyMs: 1,
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }
    };
  }));
  const result = await wrapped.invoke(request());
  assert.equal(result.content, 'ok');
  assert.equal(result.billingId, undefined);
  assert.equal(calls, 1);
});

test('finite provider budget requires pricing and supplies a safe output bound before inference', async () => {
  const missingPricing = fixture('missing-pricing');
  missingPricing.settings.update('future-ai', { unlimitedUsage: false, monthlyBudgetUsd: 1 });
  await assert.rejects(
    missingPricing.budget.wrap(provider()).invoke(request(100)),
    (error: unknown) => error instanceof ProviderBudgetError && error.code === 'pricing-required'
  );
  const missingBound = fixture('missing-bound');
  configureFiniteBudget(missingBound);
  let receivedMaxOutputTokens: number | undefined;
  const result = await missingBound.budget.wrap(provider('cloud', async (input) => {
    receivedMaxOutputTokens = input.maxOutputTokens;
    return {
      providerId: 'future-ai', model: input.model, content: 'ok', latencyMs: 1,
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }
    };
  })).invoke(request());
  assert.equal(result.content, 'ok');
  assert.equal(receivedMaxOutputTokens, DEFAULT_BUDGETED_MAX_OUTPUT_TOKENS);

  await assert.rejects(
    missingBound.budget.authorize(provider(), request()),
    (error: unknown) => error instanceof ProviderBudgetError && error.code === 'output-bound-required'
  );
});

test('automatic budget output bound respects a smaller published model maximum', async () => {
  const input = fixture('published-output-bound');
  configureFiniteBudget(input);
  let receivedMaxOutputTokens: number | undefined;
  await input.budget.wrap(provider('cloud', async (requestInput) => {
    receivedMaxOutputTokens = requestInput.maxOutputTokens;
    return {
      providerId: 'future-ai', model: requestInput.model, content: 'ok', latencyMs: 1,
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }
    };
  }, 4_096)).invoke(request());
  assert.equal(receivedMaxOutputTokens, 4_096);
});

test('finite provider budget permits a call whose pessimistic upper bound fits', async () => {
  const input = fixture('permit');
  configureFiniteBudget(input);
  let calls = 0;
  const wrapped = input.budget.wrap(provider('cloud', async (requestInput) => {
    calls += 1;
    return {
      providerId: 'future-ai', model: requestInput.model, content: 'ok', latencyMs: 1,
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 }
    };
  }));
  const result = await wrapped.invoke(request(1_000));
  assert.equal(calls, 1);
  assert.ok(result.billingId);
});

test('finite provider budget blocks before inference when projected monthly spend exceeds the cap', async () => {
  const { settings, pricing, ledger, budget, now } = fixture('block');
  settings.update('future-ai', { unlimitedUsage: false, monthlyBudgetUsd: 1 });
  pricing.set('future-ai', 'future-chat-1', { inputPerMillionUsd: 1, outputPerMillionUsd: 100 });
  appendSpend(ledger, now.toISOString(), 0.95);
  let calls = 0;
  const wrapped = budget.wrap(provider('cloud', async (input) => {
    calls += 1;
    return { providerId: 'future-ai', model: input.model, content: 'should-not-run', latencyMs: 1, usage: {} };
  }));
  await assert.rejects(
    wrapped.invoke(request(1_000)),
    (error: unknown) => error instanceof ProviderBudgetError && error.code === 'monthly-budget-exceeded'
  );
  assert.equal(calls, 0);
});

test('finite provider budget backfills current-month usage after pricing becomes available', async () => {
  const input = fixture('repriced');
  configureFiniteBudget(input, 5);
  appendSpend(input.ledger, input.now.toISOString());
  const result = await input.budget.wrap(provider()).invoke(request(100));
  assert.equal(result.content, 'ok');
  const historical = input.ledger.list().find((event) => event.billingId === undefined);
  assert.equal(historical?.costUsd, 0.00006);
});

test('finite provider budget still fails closed when historical model pricing is genuinely unknown', async () => {
  const input = fixture('still-unpriced');
  configureFiniteBudget(input, 5);
  appendSpend(input.ledger, input.now.toISOString(), undefined, undefined, 'unknown-model');
  await assert.rejects(
    input.budget.wrap(provider()).invoke(request(100)),
    (error: unknown) => error instanceof ProviderBudgetError && error.code === 'historical-cost-unknown'
  );
});

test('concurrent provider reservations prevent two calls from jointly crossing the cap', async () => {
  const { settings, pricing, budget } = fixture('concurrency');
  settings.update('future-ai', { unlimitedUsage: false, monthlyBudgetUsd: 0.15 });
  pricing.set('future-ai', 'future-chat-1', { inputPerMillionUsd: 1, outputPerMillionUsd: 100 });
  let releaseFirst!: () => void;
  let calls = 0;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const wrapped = budget.wrap(provider('cloud', async (input) => {
    calls += 1;
    await firstGate;
    return { providerId: 'future-ai', model: input.model, content: 'ok', latencyMs: 1, usage: {} };
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

test('a successful billable call keeps its reservation until matching usage is durable', async () => {
  const input = fixture('durable-accounting');
  configureFiniteBudget(input);
  const result = await input.budget.wrap(provider()).invoke(request(100));
  assert.ok(result.billingId);
  assert.equal(input.ledger.listReservations(PROVIDER_BUDGET_PROJECT_ID, input.now).length, 1);
  appendSpend(input.ledger, input.now.toISOString(), 0.0001, result.billingId);
  assert.equal(await input.budget.reconcile('future-ai'), 1);
  assert.equal(input.ledger.listReservations(PROVIDER_BUDGET_PROJECT_ID, input.now).length, 0);
});

test('transport/provider errors after invoke starts retain the upper-bound reservation', async () => {
  const input = fixture('uncertain-error');
  configureFiniteBudget(input);
  const wrapped = input.budget.wrap(provider('cloud', async () => {
    throw new Error('connection reset after request write');
  }));
  await assert.rejects(wrapped.invoke(request(100)), /connection reset/);
  const reservations = input.ledger.listReservations(PROVIDER_BUDGET_PROJECT_ID, input.now);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0]?.expiresAt, '2026-10-01T00:00:00.000Z');
});

test('local providers bypass monetary budget enforcement because API cost is zero', async () => {
  const { settings, budget } = fixture('local');
  settings.update('ollama', { unlimitedUsage: false, monthlyBudgetUsd: 0.01 });
  let calls = 0;
  const local = provider('local', async (input) => {
    calls += 1;
    return { providerId: 'ollama', model: input.model, content: 'local', latencyMs: 1, usage: {} };
  });
  const wrapped = budget.wrap(local);
  assert.equal(wrapped, local);
  await wrapped.invoke(request());
  assert.equal(calls, 1);
});

test('provider budgets are wired generically into every provider runtime and Usage settings', () => {
  const runtime = fs.readFileSync(path.join(process.cwd(), 'src/project-provider-runtime.ts'), 'utf8').replace(/\r\n/g, '\n');
  const surface = fs.readFileSync(path.join(process.cwd(), 'app/src/UsageSettings.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(
    runtime,
    /this\.capabilityPolicy\.wrap\(this\.budget\.wrap\(withSafeModelLimits\(provider\)\)\)/
  );
  assert.match(runtime, /\.\.\.Object\.keys\(this\.factories\)/);
  assert.match(surface, /Provider budgets/);
  assert.match(surface, /monthlyBudgetUsd/);
  assert.match(surface, /Unlimited/);
});
