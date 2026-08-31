import assert from 'node:assert/strict';
import test from 'node:test';

import type { LocalEngineerResult } from '../src/local-engineer.js';
import { assessEngineeringQuality } from '../src/quality-gate.js';

function baseResult(): LocalEngineerResult {
  return {
    status: 'success',
    phase: 'complete',
    workspace: '/tmp/repo',
    goal: 'Implement feature',
    summary: 'Done',
    investigation: {
      searchQueries: ['feature'],
      evidenceFiles: ['src/a.ts', 'src/b.ts', 'test/a.test.ts'],
      researchRequests: []
    },
    plan: {
      summary: 'Plan',
      analysis: 'Evidence-backed',
      confidence: 0.86,
      decisions: [],
      riskTags: [],
      sensitiveDecisionRequired: false,
      validationScripts: ['test'],
      tasks: [
        {
          id: 't1',
          task: 'Implement',
          dependsOn: [],
          editableFiles: ['src/a.ts'],
          contextFiles: [],
          constraints: []
        },
        {
          id: 't2',
          task: 'Test',
          dependsOn: ['t1'],
          editableFiles: ['test/a.test.ts'],
          contextFiles: [],
          constraints: []
        }
      ]
    },
    repairRounds: 0,
    changedFiles: ['src/a.ts', 'test/a.test.ts'],
    diff: 'diff',
    validation: [
      { command: 'pnpm', args: ['test'], ok: true, output: 'ok', durationMs: 100 }
    ],
    review: {
      verdict: 'pass',
      confidence: 0.9,
      summary: 'Pass',
      issues: [],
      researchRequests: []
    },
    modelCalls: []
  };
}

test('validated reviewed work scores strongly', () => {
  const quality = assessEngineeringQuality(baseResult(), {
    effort: 'high',
    score: 60,
    reasons: ['cross-cutting'],
    deliberationPasses: 2,
    reviewPasses: 2,
    independentAudit: true
  });
  assert.ok(quality.score >= 80);
  assert.equal(quality.passed, true);
});

test('missing validation materially reduces confidence', () => {
  const result = baseResult();
  result.validation = [];
  result.review = undefined;
  result.plan!.confidence = 0.55;
  const quality = assessEngineeringQuality(result, undefined, 80);
  assert.ok(quality.score < 80);
  assert.equal(quality.passed, false);
  assert.ok(quality.signals.some((signal) => signal.name === 'no-validation'));
});
