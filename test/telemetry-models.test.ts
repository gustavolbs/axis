import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelemetryStore } from '../src/telemetry.js';

test('uses exact inference events for per-model telemetry without double counting execution aggregates', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-model-telemetry-'));
  const filePath = path.join(directory, 'telemetry.jsonl');

  try {
    const store = new TelemetryStore(filePath, true);
    await store.record({
      kind: 'inference',
      status: 'success',
      model: 'fast-7b',
      promptTokens: 100,
      completionTokens: 20,
      generationDurationMs: 500
    });
    await store.record({
      kind: 'inference',
      status: 'success',
      model: 'strong-14b',
      promptTokens: 120,
      completionTokens: 30,
      generationDurationMs: 900
    });
    // This aggregate represents the same two generations and must not be counted again.
    await store.record({
      kind: 'execution',
      status: 'success',
      model: 'strong-14b',
      attempts: 2,
      promptTokens: 220,
      completionTokens: 50,
      generationDurationMs: 1400,
      validationDurationMs: 50
    });

    const summary = await store.summary(30);
    assert.equal(summary.localInference.calls, 2);
    assert.equal(summary.localInference.promptTokens, 220);
    assert.equal(summary.localInference.completionTokens, 50);
    assert.equal(summary.localInference.totalTokens, 270);
    assert.equal(summary.localInference.generationDurationMs, 1400);
    assert.equal(summary.localInference.validationDurationMs, 50);
    assert.equal(summary.localInference.byModel['fast-7b']?.calls, 1);
    assert.equal(summary.localInference.byModel['fast-7b']?.totalTokens, 120);
    assert.equal(summary.localInference.byModel['strong-14b']?.calls, 1);
    assert.equal(summary.localInference.byModel['strong-14b']?.totalTokens, 150);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
