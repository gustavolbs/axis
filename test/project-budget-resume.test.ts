import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RoutingCandidate } from '../src/cognitive-router.js';
import { BudgetGuardError, ProjectBudgetSession } from '../src/project-budget.js';
import { PricingStore } from '../src/pricing-store.js';
import { ProjectStore } from '../src/project-store.js';
import { UsageLedger } from '../src/usage-ledger.js';

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-budget-resume-'));
}

const candidate: RoutingCandidate = {
  providerId: 'anthropic',
  providerKind: 'cloud',
  modelId: 'cloud-model',
  available: true,
  capabilities: { structuredOutput: true, reasoning: true }
};

test('resumed session reconstructs already-spent per-job cost from the durable ledger', async () => {
  const dir = root();
  const workspace = path.join(dir, 'repo');
  fs.mkdirSync(workspace);
  const project = new ProjectStore(path.join(dir, 'projects.json')).create({
    id: 'resume-project',
    name: 'Resume Project',
    workspace,
    organizationId: 'resume-org',
    privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic'] },
    budgets: { perJobUsd: 5 }
  });
  const pricing = new PricingStore(path.join(dir, 'pricing.json'));
  pricing.set('anthropic', 'cloud-model', {
    inputPerMillionUsd: 1_000_000,
    outputPerMillionUsd: 1_000_000,
    source: 'resume-test',
    verifiedAt: '2026-08-31T00:00:00.000Z'
  });
  const ledger = new UsageLedger(path.join(dir, 'usage'));
  const now = () => new Date('2026-08-31T12:00:00.000Z');

  const firstRound = new ProjectBudgetSession(project, pricing, ledger, {
    jobId: 'same-mcp-job',
    now
  });
  await firstRound.authorize(candidate, {
    systemPrompt: '',
    userPrompt: '',
    maxOutputTokens: 1
  });
  firstRound.record(
    'planning',
    candidate,
    {
      providerId: 'anthropic',
      model: 'cloud-model',
      content: 'ok',
      latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    },
    false
  );
  assert.equal(firstRound.snapshot().jobKnownCostUsd, 2);

  const resumedRound = new ProjectBudgetSession(project, pricing, ledger, {
    jobId: 'same-mcp-job',
    now
  });
  assert.equal(resumedRound.snapshot().jobKnownCostUsd, 2);

  await assert.rejects(
    resumedRound.authorize(candidate, {
      systemPrompt: 's',
      userPrompt: 'u',
      maxOutputTokens: 1
    }),
    (error: unknown) => {
      assert.ok(error instanceof BudgetGuardError);
      assert.equal(error.code, 'job-budget-exceeded');
      return true;
    }
  );
  assert.equal(ledger.listReservations(project.id, now()).length, 0);
});
