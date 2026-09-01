import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkerHistoryStore } from '../src/worker-history.js';

test('persists run metadata, prompts, outputs, progress and failures as a readable timeline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-history-'));
  try {
    const store = new WorkerHistoryStore(root, 20);
    const id = '761b556a-1a35-43f5-a3cb-e9194a1fc4e2';
    await store.startRun({
      id,
      kind: 'engineer',
      isolationKey: 'aee6d86981b3ce6e',
      startedAt: '2026-08-31T01:00:00.000Z'
    });
    await store.annotateRun(id, {
      goal: 'Improve one small test safely.',
      repositoryUrl: 'https://github.com/example/repo.git'
    });
    await store.appendEvent(id, {
      type: 'request',
      title: 'engineering request',
      data: { goal: 'Improve one small test safely.' }
    });
    await store.recordProgress(id, {
      phase: 'planning',
      action: 'Qwen is building the implementation plan',
      updatedAt: '2026-08-31T01:01:00.000Z'
    });
    await store.appendEvent(id, {
      type: 'model-input',
      title: 'Planning prompt sent to Qwen',
      stage: 'planning',
      model: 'qwen3.8:27b',
      systemPrompt: 'planner system prompt',
      userPrompt: 'bounded user prompt',
      originalUserPromptChars: 90000,
      promptTruncated: true
    });
    await store.appendEvent(id, {
      type: 'model-output',
      title: 'Planning output',
      stage: 'planning',
      model: 'qwen3.8:27b',
      output: '{"summary":"bounded change"}',
      promptTokens: 4100,
      completionTokens: 500,
      durationMs: 90000
    });
    await store.finishRun(id, 'success');

    const summaries = await store.listRuns();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.status, 'success');
    assert.equal(summaries[0]?.goal, 'Improve one small test safely.');
    assert.equal(summaries[0]?.phase, 'planning');

    const run = await store.readRun(id);
    assert.ok(run);
    assert.equal(run.events[0]?.type, 'job-start');
    assert.ok(run.events.some((event) => event.type === 'model-input' && event.userPrompt === 'bounded user prompt'));
    assert.ok(run.events.some((event) => event.type === 'model-output' && event.output?.includes('bounded change')));
    assert.equal(run.events.at(-1)?.type, 'job-finish');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
