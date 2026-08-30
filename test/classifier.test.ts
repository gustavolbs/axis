import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTask } from '../src/classifier.js';

test('routes existing deterministic commands away from LLMs', () => {
  const result = classifyTask({ task: 'Run the test suite for this repository.' });
  assert.equal(result.route, 'deterministic');
  assert.ok(result.confidence >= 0.9);
});

test('keeps unresolved auth work in Claude', () => {
  const result = classifyTask({
    task: 'Implement authorization changes for the admin API.',
    solutionKnown: true,
    validationKnown: true,
    estimatedFiles: 2
  });
  assert.equal(result.route, 'claude');
  assert.ok(result.signals.supervisedRisk.length > 0);
  assert.match(result.reasons.join(' '), /sensitiveDecisionResolved=true/);
});

test('routes already-decided bounded auth implementation as local-supervised', () => {
  const result = classifyTask({
    task: 'Implement the already-decided credential removal behavior and update its tests.',
    solutionKnown: true,
    validationKnown: true,
    estimatedFiles: 3,
    riskTags: ['auth', 'credentials'],
    sensitiveDecisionResolved: true
  });

  assert.equal(result.route, 'local-supervised');
  assert.equal(result.reviewPolicy.mode, 'full-diff');
  assert.equal(result.reviewPolicy.claudeReviewRequired, true);
  assert.ok(result.signals.supervisedRisk.length > 0);
});

test('keeps cryptography design in Claude even when a solution is claimed known', () => {
  const result = classifyTask({
    task: 'Implement a new encryption and signing design for stored credentials.',
    solutionKnown: true,
    validationKnown: true,
    estimatedFiles: 2,
    sensitiveDecisionResolved: true
  });

  assert.equal(result.route, 'claude');
  assert.ok(result.signals.blockingRisk.length > 0);
});

test('routes bounded known implementation to the local executor', () => {
  const result = classifyTask({
    task: 'Add Vitest coverage for the existing mapper and fix the known TypeScript error.',
    solutionKnown: true,
    validationKnown: true,
    estimatedFiles: 2
  });
  assert.equal(result.route, 'local');
  assert.ok(result.confidence > 0.7);
});

test('keeps discovery work in Claude even when the task looks implementation-friendly', () => {
  const result = classifyTask({
    task: 'Fix the React component regression.',
    solutionKnown: false,
    requiresDiscovery: true,
    estimatedFiles: 1
  });
  assert.equal(result.route, 'claude');
});
