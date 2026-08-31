import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RoutingCandidate } from '../src/cognitive-router.js';
import {
  BudgetGuardError,
  ProjectBudgetSession
} from '../src/project-budget.js';
import {
  PricingStore,
  calculateUsageCostUsd
} from '../src/pricing-store.js';
import { ProjectStore } from '../src/project-store.js';
import { UsageLedger } from '../src/usage-ledger.js';

function temp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `local-coder-${name}-`));
}

function cloudCandidate(): RoutingCandidate {
  return {
    providerId: 'anthropic',
    providerKind: 'cloud',
    modelId: 'cloud-model',
    available: true,
    capabilities: { structuredOutput: true, reasoning: true }
  };
}

function project(root: string, budgets: { dailyUsd?: number; monthlyUsd?: number; perJobUsd?: number } = {}) {
  const workspace = path.join(root, 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  return new ProjectStore(path.join(root, 'projects.json')).create({
    id: 'budget-project',
    name: 'Budget Project',
    workspace,
    organizationId: 'budget-org',
    privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic'] },
    budgets
  });
}

function priced(root: string): PricingStore {
  const pricing = new PricingStore(path.join(root, 'pricing.json'));
  pricing.set('anthropic', 'cloud-model', {
    inputPerMillionUsd: 1_000_000,
    outputPerMillionUsd: 1_000_000,
    source: 'test-price-sheet',
    verifiedAt: '2026-08-31T00:00:00.000Z'
  });
  return pricing;
}

test('pricing calculation separates uncached, cache-read and cache-write input', () => {
  const cost = calculateUsageCostUsd(
    {
      inputTokens: 100,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 50
    },
    {
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 2,
      cacheReadPerMillionUsd: 0.1,
      cacheWritePerMillionUsd: 0.5
    }
  );
  assert.equal(cost, 0.000177);
});

test('budgeted cloud fails closed when pricing is missing', async () => {
  const root = temp('budget-missing-pricing');
  const session = new ProjectBudgetSession(
    project(root, { dailyUsd: 10 }),
    new PricingStore(path.join(root, 'pricing.json')),
    new UsageLedger(path.join(root, 'usage'))
  );

  await assert.rejects(
    session.authorize(cloudCandidate(), { systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof BudgetGuardError);
      assert.equal(error.code, 'pricing-required');
      return true;
    }
  );
});

test('budgeted cloud requires an output bound before provider I/O', async () => {
  const root = temp('budget-output-bound');
  const session = new ProjectBudgetSession(
    project(root, { dailyUsd: 10 }),
    priced(root),
    new UsageLedger(path.join(root, 'usage'))
  );

  await assert.rejects(
    session.authorize(cloudCandidate(), { systemPrompt: 's', userPrompt: 'u' }),
    (error: unknown) => {
      assert.ok(error instanceof BudgetGuardError);
      assert.equal(error.code, 'output-bound-required');
      return true;
    }
  );
});

test('concurrent sessions cannot reserve the same remaining daily budget', async () => {
  const root = temp('budget-concurrency');
  const definition = project(root, { dailyUsd: 5 });
  const pricing = priced(root);
  const ledger = new UsageLedger(path.join(root, 'usage'));
  const now = () => new Date('2026-08-31T12:00:00.000Z');
  const first = new ProjectBudgetSession(definition, pricing, ledger, { jobId: 'job-one', now });
  const second = new ProjectBudgetSession(definition, pricing, ledger, { jobId: 'job-two', now });
  const candidate = cloudCandidate();
  const inference = { systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 1 };

  const outcomes = await Promise.allSettled([
    first.authorize(candidate, inference),
    second.authorize(candidate, inference)
  ]);
  const fulfilled = outcomes.filter((item) => item.status === 'fulfilled');
  const rejected = outcomes.filter((item) => item.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const rejection = rejected[0] as PromiseRejectedResult;
  assert.ok(rejection.reason instanceof BudgetGuardError);
  assert.equal(rejection.reason.code, 'daily-budget-exceeded');
  assert.equal(ledger.listReservations(definition.id, now()).length, 1);

  if (outcomes[0]?.status === 'fulfilled') first.releaseAttempt(candidate);
  else second.releaseAttempt(candidate);
  assert.equal(ledger.listReservations(definition.id, now()).length, 0);
});

test('successful cloud usage replaces reservation with exact priced ledger event', async () => {
  const root = temp('budget-settle');
  const definition = project(root, { dailyUsd: 10, perJobUsd: 10 });
  const pricing = priced(root);
  const ledger = new UsageLedger(path.join(root, 'usage'));
  const now = () => new Date('2026-08-31T12:00:00.000Z');
  const session = new ProjectBudgetSession(definition, pricing, ledger, { jobId: 'job-settle', now });
  const candidate = cloudCandidate();

  const admission = await session.authorize(candidate, {
    systemPrompt: 's',
    userPrompt: 'u',
    maxOutputTokens: 1
  });
  assert.ok(admission.reservationId);
  assert.equal(ledger.listReservations(definition.id, now()).length, 1);

  session.record(
    'planning',
    candidate,
    {
      providerId: 'anthropic',
      model: 'cloud-model-20260831',
      content: '{}',
      latencyMs: 25,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    },
    false
  );

  assert.equal(ledger.listReservations(definition.id, now()).length, 0);
  const events = ledger.list(definition.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.costUsd, 2);
  assert.equal(events[0]?.pricingSource, 'test-price-sheet');
  assert.equal(events[0]?.modelId, 'cloud-model');
  const snapshot = session.snapshot();
  assert.equal(snapshot.jobKnownCostUsd, 2);
  assert.equal(snapshot.jobUnknownCostEvents, 0);
  assert.equal(snapshot.daily.knownCostUsd, 2);
  assert.equal(snapshot.dailyReservedUpperBoundUsd, 0);
});

test('active reservations surface warning thresholds before hard stop', async () => {
  const root = temp('budget-warning');
  const definition = project(root, { dailyUsd: 10 });
  const session = new ProjectBudgetSession(
    definition,
    priced(root),
    new UsageLedger(path.join(root, 'usage')),
    { jobId: 'job-warning', now: () => new Date('2026-08-31T12:00:00.000Z') }
  );
  const candidate = cloudCandidate();
  const admission = await session.authorize(candidate, {
    systemPrompt: 's',
    userPrompt: 'u',
    maxOutputTokens: 3
  });

  assert.ok(admission.warnings.some((warning) => warning.scope === 'daily' && warning.fraction === 0.5));
  session.releaseAttempt(candidate);
  assert.ok(session.snapshot().warnings.some((warning) => warning.scope === 'daily' && warning.fraction === 0.5));
});
