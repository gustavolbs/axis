import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyInferenceStage,
  progressAtInferenceStart,
  progressFromInferenceResult,
  WorkerInferenceTracker
} from '../src/inference-status.js';

test('classifies local engineer model stages from system prompts', () => {
  assert.equal(
    classifyInferenceStage('You are the investigation stage of a local software-engineering agent.'),
    'investigation'
  );
  assert.equal(
    classifyInferenceStage('You are the reasoning/planning stage of a local software-engineering agent.'),
    'planning'
  );
  assert.equal(
    classifyInferenceStage('You are an adversarial software-engineering reviewer.'),
    'review'
  );
  assert.equal(
    classifyInferenceStage('You maintain durable repository intelligence for future software-engineering tasks.'),
    'repo-learning'
  );
  assert.equal(
    classifyInferenceStage('You are a local coding execution model operating under a stronger planner/reviewer.'),
    'implementation'
  );
  assert.equal(
    classifyInferenceStage('You are a local coding executor working under a stronger planner/reviewer.'),
    'implementation'
  );
  assert.equal(classifyInferenceStage('Generic assistant prompt.'), 'other');
});

test('derives bounded implementation progress without retaining repository source', () => {
  const progress = progressAtInferenceStart(
    'implementation',
    '# TASK\nFix the parser edge case.\n\n# EDITABLE FILES\n- src/parser.ts\n- test/parser.test.ts\n\n# REPOSITORY FILES\nSECRET SOURCE'
  );

  assert.equal(progress.phase, 'implementation');
  assert.equal(progress.detail, 'Fix the parser edge case.');
  assert.deepEqual(progress.files, ['src/parser.ts', 'test/parser.test.ts']);
  assert.equal(JSON.stringify(progress).includes('SECRET SOURCE'), false);
});

test('turns structured model output into a concise decision summary', () => {
  const progress = progressFromInferenceResult(
    'planning',
    JSON.stringify({
      summary: 'Use the existing parser boundary and add one regression test.',
      tasks: [{ id: 'fix-parser' }, { id: 'add-test' }]
    })
  );

  assert.equal(progress.phase, 'planning');
  assert.equal(progress.reasoningSummary, 'Use the existing parser boundary and add one regression test.');
  assert.equal(progress.detail, '2 tasks: fix-parser, add-test');
});

test('tracks current and recent inference without retaining prompts', () => {
  const tracker = new WorkerInferenceTracker();
  const id = tracker.begin('planning', 'qwen3.8:27b');
  const active = tracker.snapshot();

  assert.equal(active.current?.id, id);
  assert.equal(active.current?.stage, 'planning');
  assert.equal(active.current?.model, 'qwen3.8:27b');
  assert.equal(active.recent.length, 0);

  tracker.complete(id, 'success', { promptTokens: 100, completionTokens: 20 });
  const completed = tracker.snapshot();

  assert.equal(completed.current, null);
  assert.equal(completed.recent.length, 1);
  assert.equal(completed.recent[0]?.stage, 'planning');
  assert.equal(completed.recent[0]?.status, 'success');
  assert.equal(completed.recent[0]?.promptTokens, 100);
  assert.equal(completed.recent[0]?.completionTokens, 20);
});
