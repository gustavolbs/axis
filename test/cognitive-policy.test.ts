import assert from 'node:assert/strict';
import test from 'node:test';

import { assessCognitiveEffort } from '../src/cognitive-policy.js';

test('small bounded change stays low/medium without deliberation', () => {
  const profile = assessCognitiveEffort(
    { goal: 'Fix a small test assertion in one component.' },
    { repositoryFiles: 120, relevantFiles: 2, packageScripts: 4 },
    'adaptive'
  );
  assert.ok(profile.effort === 'low' || profile.effort === 'medium');
  assert.equal(profile.deliberationPasses, 0);
  assert.equal(profile.reviewPasses, 1);
});

test('cross-cutting architecture work buys additional test-time compute', () => {
  const profile = assessCognitiveEffort(
    {
      goal: 'Design and implement a cross-cutting event-driven migration across the application with concurrency and public API compatibility.'
    },
    { repositoryFiles: 900, relevantFiles: 11, packageScripts: 12 },
    'adaptive'
  );
  assert.ok(profile.effort === 'high' || profile.effort === 'max');
  assert.ok(profile.deliberationPasses >= 2);
  assert.ok(profile.reviewPasses >= 2);
  assert.equal(profile.independentAudit, true);
});

test('max mode forces maximum local cognition', () => {
  const profile = assessCognitiveEffort(
    { goal: 'Rename a variable.' },
    { repositoryFiles: 10, relevantFiles: 1, packageScripts: 1 },
    'max',
    3
  );
  assert.equal(profile.effort, 'max');
  assert.equal(profile.deliberationPasses, 3);
  assert.equal(profile.reviewPasses, 3);
});
