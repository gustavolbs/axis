import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelemetryStore } from '../src/telemetry.js';

test('aggregates routing, executions, orchestrations, tokens, and durations', async () => {
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
    await store.record({
      kind: 'orchestration',
      status: 'success',
      model: 'test-model',
      attempts: 4,
      tasks: 3,
      completedTasks: 3,
      promptTokens: 300,
      completionTokens: 75,
      generationDurationMs: 3200,
      validationDurationMs: 450,
      changedFiles: 5
    });

    const summary = await store.summary(30);
    assert.equal(summary.events, 4);
    assert.equal(summary.classifications.local, 1);
    assert.equal(summary.executions.total, 1);
    assert.equal(summary.executions.success, 1);
    assert.equal(summary.executions.retriedTasks, 1);
    assert.equal(summary.executions.averageAttempts, 2);
    assert.equal(summary.executions.changedFiles, 2);
    assert.equal(summary.orchestrations.total, 1);
    assert.equal(summary.orchestrations.success, 1);
    assert.equal(summary.orchestrations.plannedTasks, 3);
    assert.equal(summary.orchestrations.completedTasks, 3);
    assert.equal(summary.orchestrations.taskCompletionRate, 1);
    assert.equal(summary.orchestrations.averageTasksPerPlan, 3);
    assert.equal(summary.localInference.promptTokens, 420);
    assert.equal(summary.localInference.completionTokens, 110);
    assert.equal(summary.localInference.totalTokens, 530);
    assert.equal(summary.localInference.generationDurationMs, 5000);
    assert.equal(summary.localInference.validationDurationMs, 700);
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
