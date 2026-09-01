import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PersonalUsageRecorder } from '../src/personal-usage.js';
import { PricingStore } from '../src/pricing-store.js';
import { UsageLedger } from '../src/usage-ledger.js';

test('personal chat records priced cloud usage and zero-cost Ollama tokens', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-personal-usage-'));
  try {
    const ledger = new UsageLedger(path.join(root, 'ledger'));
    const pricing = new PricingStore(path.join(root, 'pricing.json'));
    pricing.set('openai', 'gpt-test', {
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 8,
      source: 'test pricing',
      verifiedAt: '2026-08-31T00:00:00.000Z'
    });
    const recorder = new PersonalUsageRecorder({
      ledger,
      pricing,
      now: () => new Date('2026-08-31T12:00:00.000Z')
    });

    const cloud = recorder.recordInference({
      jobId: 'chat-cloud',
      providerId: 'openai',
      providerKind: 'cloud',
      modelId: 'gpt-test',
      result: {
        providerId: 'openai',
        model: 'gpt-test',
        content: 'ok',
        latencyMs: 250,
        usage: { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 }
      }
    });
    assert.equal(cloud.projectId, 'personal');
    assert.equal(cloud.organizationId, 'personal');
    assert.equal(cloud.costUsd, 6);
    assert.equal(cloud.pricingSource, 'test pricing');

    const local = recorder.recordLocalGeneration({
      jobId: 'chat-local',
      modelId: 'qwen3.8:27b',
      promptTokens: 500,
      completionTokens: 100,
      totalDurationNs: 1_000_000_000
    });
    assert.equal(local.providerId, 'ollama');
    assert.equal(local.providerKind, 'local');
    assert.equal(local.costUsd, 0);
    assert.equal(local.usage.totalTokens, 600);

    const events = ledger.list();
    assert.equal(events.length, 2);
    assert.equal(events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0), 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unpriced personal cloud usage stays explicit instead of pretending to cost zero', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-personal-unpriced-'));
  try {
    const recorder = new PersonalUsageRecorder({
      ledger: new UsageLedger(path.join(root, 'ledger')),
      pricing: new PricingStore(path.join(root, 'pricing.json'))
    });
    const event = recorder.recordInference({
      jobId: 'chat-unpriced',
      providerId: 'anthropic',
      providerKind: 'cloud',
      modelId: 'claude-test',
      result: {
        providerId: 'anthropic',
        model: 'claude-test',
        content: 'ok',
        latencyMs: 100,
        usage: { inputTokens: 100, outputTokens: 50 }
      }
    });
    assert.equal(event.costUsd, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
