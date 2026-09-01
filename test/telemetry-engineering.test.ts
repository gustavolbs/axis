import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelemetryStore } from '../src/telemetry.js';

test('summarizes local-engineer success, guidance checkpoint and repair rounds', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-engineering-telemetry-'));
  const filePath = path.join(directory, 'telemetry.jsonl');

  try {
    const store = new TelemetryStore(filePath, true);
    await store.record({
      kind: 'engineering',
      status: 'success',
      model: 'qwen3.6',
      repairRounds: 1,
      tasks: 4,
      completedTasks: 4,
      changedFiles: 5,
      promptTokens: 1000,
      completionTokens: 300,
      generationDurationMs: 10_000
    });
    await store.record({
      kind: 'engineering',
      status: 'needs-guidance',
      model: 'qwen3.6',
      repairRounds: 0,
      tasks: 0,
      changedFiles: 0,
      promptTokens: 400,
      completionTokens: 100,
      generationDurationMs: 3_000
    });
    await store.record({
      kind: 'engineering',
      status: 'escalated',
      model: 'qwen3.6',
      repairRounds: 0,
      tasks: 2,
      completedTasks: 1,
      promptTokens: 600,
      completionTokens: 150,
      generationDurationMs: 5_000
    });

    const summary = await store.summary(30);
    assert.equal(summary.engineering.total, 3);
    assert.equal(summary.engineering.success, 1);
    assert.equal(summary.engineering.needsClaude, 1);
    assert.equal(summary.engineering.escalated, 1);
    assert.equal(summary.engineering.localSuccessRate, 1 / 3);
    assert.equal(summary.engineering.claudeEscalationRate, 2 / 3);
    assert.equal(summary.engineering.repairRounds, 1);
    assert.equal(summary.engineering.averageRepairRounds, 1 / 3);
    assert.equal(summary.engineering.plannedTasks, 6);
    assert.equal(summary.engineering.changedFiles, 5);
    assert.equal(summary.localInference.promptTokens, 2000);
    assert.equal(summary.localInference.completionTokens, 550);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
