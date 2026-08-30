import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTask } from '../src/classifier.js';

test('routes existing deterministic commands away from LLMs', () => {
  const result = classifyTask({ task: 'Run the test suite for this repository.' });
  assert.equal(result.route, 'deterministic');
  assert.ok(result.confidence >= 0.9);
});

test('keeps risky auth work in Claude', () => {
  const result = classifyTask({
    task: 'Implement authorization changes for the admin API.',
    solutionKnown: true,
    validationKnown: true,
    estimatedFiles: 2
  });
  assert.equal(result.route, 'claude');
  assert.ok(result.signals.highRisk.length > 0);
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
