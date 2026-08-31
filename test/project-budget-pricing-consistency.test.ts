import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { calculateUsageCostUsd, PricingStore } from '../src/pricing-store.js';
import { ProjectBudgetSession } from '../src/project-budget.js';
import { ProjectStore } from '../src/project-store.js';
import type { RoutingCandidate } from '../src/cognitive-router.js';
import { UsageLedger } from '../src/usage-ledger.js';

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-budget-pricing-consistency-'));
}

function candidate(): RoutingCandidate {
  return {
    providerId: 'anthropic',
    modelId: 'claude-model',
    providerKind: 'cloud',
    available: true
  };
}

test('budgeted admission reads pricing only after acquiring the shared budget lock', async () => {
  const root = temp();
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  const project = projects.create({
    id: 'budgeted-project',
    name: 'Budgeted Project',
    workspace: path.join(root, 'repo'),
    organizationId: 'company-a',
    privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic'] },
    budgets: { dailyUsd: 10 }
  });
  const pricing = new PricingStore(path.join(root, 'pricing.json'));
  const ledger = new UsageLedger(path.join(root, 'usage'));
  pricing.set('anthropic', 'claude-model', {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 1,
    source: 'old'
  });
  const session = new ProjectBudgetSession(project, pricing, ledger);
  let admission!: ReturnType<ProjectBudgetSession['authorize']>;

  await ledger.withBudgetLock(() => {
    admission = session.authorize(candidate(), {
      systemPrompt: 's',
      userPrompt: 'u',
      maxOutputTokens: 100
    });
    pricing.set('anthropic', 'claude-model', {
      inputPerMillionUsd: 10,
      outputPerMillionUsd: 20,
      source: 'new'
    });
  });

  const resolved = await admission;
  const expectedUpper = calculateUsageCostUsd(
    { inputTokens: Buffer.byteLength('s\nu', 'utf8'), outputTokens: 100 },
    { inputPerMillionUsd: 10, outputPerMillionUsd: 20 }
  );
  assert.equal(resolved.upperBoundCostUsd, expectedUpper);
  session.releaseAttempt(candidate());
});

test('unbudgeted in-flight inference settles with the price sheet used at admission', async () => {
  const root = temp();
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  const project = projects.create({
    id: 'unbudgeted-project',
    name: 'Unbudgeted Project',
    workspace: path.join(root, 'repo'),
    organizationId: 'company-a',
    privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic'] }
  });
  const pricing = new PricingStore(path.join(root, 'pricing.json'));
  const ledger = new UsageLedger(path.join(root, 'usage'));
  pricing.set('anthropic', 'claude-model', {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 1,
    source: 'old-price-sheet'
  });
  const session = new ProjectBudgetSession(project, pricing, ledger);

  await session.authorize(candidate(), {
    systemPrompt: 'system',
    userPrompt: 'user',
    maxOutputTokens: 100
  });
  pricing.set('anthropic', 'claude-model', {
    inputPerMillionUsd: 10,
    outputPerMillionUsd: 10,
    source: 'new-price-sheet'
  });

  const event = session.record(
    'planning',
    candidate(),
    {
      providerId: 'anthropic',
      model: 'claude-model',
      content: 'done',
      latencyMs: 10,
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 }
    },
    false
  );

  assert.equal(event.pricingSource, 'old-price-sheet');
  assert.equal(event.costUsd, 0.0002);
  assert.equal(pricing.get('anthropic', 'claude-model')?.source, 'new-price-sheet');
});
