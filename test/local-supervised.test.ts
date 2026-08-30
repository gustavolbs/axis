import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import { executeLocalCodePlan } from '../src/orchestrator.js';
import { buildReviewCapsule } from '../src/review-capsule.js';

function config(): LocalCoderConfig {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: 'fake-model',
    requestTimeoutMs: 5_000,
    validationTimeoutMs: 10_000,
    maxFileBytes: 100_000,
    maxContextBytes: 500_000,
    allowedValidationCommands: new Set(['npm']),
    telemetryEnabled: false,
    telemetryPath: path.join(os.tmpdir(), 'unused-local-coder-telemetry.jsonl'),
    runStorePath: path.join(os.tmpdir(), 'unused-local-coder-runs'),
    contextIndexPath: path.join(os.tmpdir(), 'unused-local-coder-indexes')
  };
}

test('executes already-decided sensitive implementation as local-supervised', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-supervised-'));

  try {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'src/credential.ts'),
      'export const removeCredential = () => false;\n'
    );
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } })
    );

    let calls = 0;
    const model = {
      async chat() {
        calls += 1;
        return {
          content: JSON.stringify({
            summary: 'Applied the already-decided credential removal behavior.',
            files: [
              {
                path: 'src/credential.ts',
                content: 'export const removeCredential = () => true;\n'
              }
            ]
          }),
          model: 'fake-model',
          doneReason: 'stop',
          promptTokens: 10,
          completionTokens: 5,
          totalDurationNs: 1_000_000
        };
      }
    };

    const result = await executeLocalCodePlan(model, config(), {
      workspace,
      goal: 'Apply the credential-removal fix whose security behavior Claude already decided.',
      tasks: [
        {
          id: 'credential-removal',
          task: 'Implement the already-decided credential removal behavior.',
          editableFiles: ['src/credential.ts'],
          validation: [{ command: 'npm', args: ['test'] }],
          routing: {
            solutionKnown: true,
            validationKnown: true,
            riskTags: ['auth', 'credentials'],
            sensitiveDecisionResolved: true
          }
        }
      ]
    });

    assert.equal(result.status, 'success');
    assert.equal(result.preflight[0]?.classification.route, 'local-supervised');
    assert.equal(result.preflight[0]?.classification.reviewPolicy.mode, 'full-diff');
    assert.equal(calls, 1);
    assert.match(await fs.readFile(path.join(workspace, 'src/credential.ts'), 'utf8'), /true/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('forced supervised review always requires the full diff', () => {
  const review = buildReviewCapsule({
    diff: [
      '--- src/credential.ts (before)',
      '+++ src/credential.ts (after)',
      '@@ -1 +1 @@',
      '-const value = 1;',
      '+const value = 2;'
    ].join('\n'),
    changedFiles: ['src/credential.ts'],
    validationPassed: true,
    forceFullDiff: true,
    additionalFlags: ['local-supervised-sensitive-change']
  });

  assert.equal(review.fullDiffRecommended, true);
  assert.equal(review.risk, 'high');
  assert.ok(review.flags.includes('local-supervised-sensitive-change'));
  assert.ok(review.flags.includes('full-diff-required-by-routing'));
});
