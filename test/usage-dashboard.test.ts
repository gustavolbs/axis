import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { UsageDashboard, parseUsageDashboardPeriod } from '../src/usage-dashboard.js';
import { UsageLedger } from '../src/usage-ledger.js';

function append(
  ledger: UsageLedger,
  input: {
    id: string;
    timestamp: string;
    providerId: string;
    providerKind: 'local' | 'cloud';
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
  }
) {
  return ledger.append({
    id: input.id,
    jobId: `job-${input.id}`,
    timestamp: input.timestamp,
    projectId: input.providerKind === 'local' ? 'personal' : 'project-a',
    organizationId: input.providerKind === 'local' ? 'personal' : 'org-a',
    stage: 'other',
    providerId: input.providerId,
    providerKind: input.providerKind,
    modelId: input.modelId,
    usage: {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.inputTokens + input.outputTokens
    },
    latencyMs: 100,
    costUsd: input.costUsd,
    fallbackUsed: false
  });
}

test('global usage dashboard aggregates providers models spend and unpriced cloud calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-usage-dashboard-'));
  try {
    const ledger = new UsageLedger(root);
    append(ledger, {
      id: 'local',
      timestamp: '2026-08-30T12:00:00.000Z',
      providerId: 'ollama',
      providerKind: 'local',
      modelId: 'qwen3.8:27b',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0
    });
    append(ledger, {
      id: 'openai',
      timestamp: '2026-08-20T12:00:00.000Z',
      providerId: 'openai',
      providerKind: 'cloud',
      modelId: 'gpt-test',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      costUsd: 6
    });
    append(ledger, {
      id: 'anthropic',
      timestamp: '2026-08-15T12:00:00.000Z',
      providerId: 'anthropic',
      providerKind: 'cloud',
      modelId: 'claude-test',
      inputTokens: 2_000,
      outputTokens: 1_000
    });
    append(ledger, {
      id: 'old',
      timestamp: '2026-07-01T12:00:00.000Z',
      providerId: 'openai',
      providerKind: 'cloud',
      modelId: 'gpt-old',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 1
    });

    const dashboard = new UsageDashboard(ledger);
    const view = dashboard.summary('30d', new Date('2026-08-31T12:00:00.000Z'));

    assert.equal(view.period, '30d');
    assert.equal(view.totals.calls, 3);
    assert.equal(view.totals.localCalls, 1);
    assert.equal(view.totals.cloudCalls, 2);
    assert.equal(view.totals.inputTokens, 1_002_100);
    assert.equal(view.totals.outputTokens, 501_050);
    assert.equal(view.totals.totalTokens, 1_503_150);
    assert.equal(view.totals.knownCostUsd, 6);
    assert.equal(view.totals.unknownCostEvents, 1);
    assert.equal(view.currentMonth.knownCostUsd, 6);
    assert.equal(view.currentMonth.unknownCostEvents, 1);

    const ollama = view.providers.find((provider) => provider.providerId === 'ollama');
    assert.ok(ollama);
    assert.equal(ollama.providerKind, 'local');
    assert.equal(ollama.knownCostUsd, 0);
    assert.equal(ollama.totalTokens, 150);

    const openai = view.models.find((model) => model.providerId === 'openai' && model.modelId === 'gpt-test');
    assert.ok(openai);
    assert.equal(openai.knownCostUsd, 6);
    assert.equal(openai.totalTokens, 1_500_000);

    assert.equal(view.timeline.interval, 'day');
    assert.equal(view.timeline.points.length, 3);

    const all = dashboard.summary('all', new Date('2026-08-31T12:00:00.000Z'));
    assert.equal(all.totals.calls, 4);
    assert.equal(all.totals.knownCostUsd, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('usage period parser rejects unsupported periods', () => {
  assert.equal(parseUsageDashboardPeriod(undefined), '30d');
  assert.equal(parseUsageDashboardPeriod('month'), 'month');
  assert.throws(() => parseUsageDashboardPeriod('year'), /7d, 30d, month, or all/);
});
