import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReviewCapsule } from '../src/review-capsule.js';

test('marks small validated implementation as low risk', () => {
  const capsule = buildReviewCapsule({
    changedFiles: ['src/value.ts'],
    validationPassed: true,
    diff: [
      '--- src/value.ts (before)',
      '+++ src/value.ts (after)',
      '@@ -1 +1 @@',
      '-const value = 1;',
      '+const value = 2;'
    ].join('\n')
  });

  assert.equal(capsule.risk, 'low');
  assert.equal(capsule.additions, 1);
  assert.equal(capsule.deletions, 1);
  assert.equal(capsule.fullDiffRecommended, false);
});

test('forces full review for security-sensitive or failed validation changes', () => {
  const capsule = buildReviewCapsule({
    changedFiles: ['src/auth/session.ts'],
    validationPassed: false,
    diff: [
      '--- src/auth/session.ts (before)',
      '+++ src/auth/session.ts (after)',
      '@@ -1 +1 @@',
      '-export const session = oldSession;',
      '+export const session = signCredential();'
    ].join('\n')
  });

  assert.equal(capsule.risk, 'high');
  assert.equal(capsule.fullDiffRecommended, true);
  assert.ok(capsule.flags.includes('security-sensitive-signal'));
  assert.ok(capsule.flags.includes('validation-not-clean'));
});
