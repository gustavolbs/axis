import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelemetryStore } from '../src/telemetry.js';

test('aggregates routing, success, retries, tokens, and durations', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-telemetry-'));
  const filePath = path.join(directory, 'telemetry.jsonl');

  try {
    const store = new TelemetryStore(filePath, true);
    await store.record({ kind: 'classification', route: 'local' });
    await store.record({
      kind: 'execution',
      status: 'success',
      model: 'test-model',
      attempts: 2,
      promptTokens: 100,
      completionTokens: 25,
      generationDurationMs: 1500,
      validationDurationMs: 250,
      changedFiles: 2
    });
    await store.record({
      kind: 'delegation',
      status: 'success',
      promptTokens: 20,
      completionTokens: 10,
      generationDurationMs: 300
    });

    const summary = await store.summary(30);
    assert.equal(summary.events, 3);
    assert.equal(summary.classifications.local, 1);
    assert.equal(summary.executions.total, 1);
    assert.equal(summary.executions.success, 1);
    assert.equal(summary.executions.retriedTasks, 1);
    assert.equal(summary.executions.averageAttempts, 2);
    assert.equal(summary.executions.changedFiles, 2);
    assert.equal(summary.localInference.promptTokens, 120);
    assert.equal(summary.localInference.completionTokens, 35);
    assert.equal(summary.localInference.totalTokens, 155);
    assert.equal(summary.localInference.generationDurationMs, 1800);
    assert.equal(summary.localInference.validationDurationMs, 250);
    assert.equal(summary.localInference.apiCostUsd, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('disabled telemetry does not create a file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-telemetry-disabled-'));
  const filePath = path.join(directory, 'telemetry.jsonl');

  try {
    const store = new TelemetryStore(filePath, false);
    await store.record({ kind: 'classification', route: 'claude' });
    await assert.rejects(() => fs.stat(filePath), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
