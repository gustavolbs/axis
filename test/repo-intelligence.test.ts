import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalEngineerResult } from '../src/local-engineer.js';
import {
  prepareRepoIntelligence,
  recordRepoIntelligenceLearning
} from '../src/repo-intelligence.js';

async function run(command: string, args: string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8').trim());
    });
  });
}

async function createRepo(root: string, name: string, remote: string): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await run('git', ['init'], repo);
  await run('git', ['config', 'user.email', 'test@example.com'], repo);
  await run('git', ['config', 'user.name', 'Test User'], repo);
  await run('git', ['remote', 'add', 'origin', remote], repo);
  await fs.writeFile(
    path.join(repo, 'src', 'service.ts'),
    'export function service() { return "v1"; }\n',
    'utf8'
  );
  await run('git', ['add', '.'], repo);
  await run('git', ['commit', '-m', 'initial'], repo);
  return repo;
}

function successfulResult(workspace: string): LocalEngineerResult {
  return {
    status: 'success',
    phase: 'complete',
    workspace,
    goal: 'Keep service access behind the repository boundary',
    summary: 'Service boundary preserved and validated.',
    investigation: {
      searchQueries: ['service'],
      evidenceFiles: ['src/service.ts'],
      researchRequests: []
    },
    plan: {
      summary: 'Preserve the service boundary.',
      analysis: 'The service module is the existing boundary.',
      confidence: 0.95,
      decisions: ['Keep callers behind src/service.ts.'],
      riskTags: [],
      sensitiveDecisionRequired: false,
      validationScripts: ['test'],
      tasks: [
        {
          id: 'service-boundary',
          task: 'Preserve service boundary',
          dependsOn: [],
          editableFiles: ['src/service.ts'],
          contextFiles: ['src/service.ts'],
          constraints: []
        }
      ]
    },
    repairRounds: 0,
    changedFiles: ['src/service.ts'],
    diff: '',
    validation: [],
    modelCalls: []
  };
}

test('repo intelligence persists useful facts and marks them stale after uncommitted source changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-intelligence-'));
  const config = { workerStatePath: path.join(root, 'state') };

  try {
    const repo = await createRepo(root, 'repo-a', 'https://github.com/example/repo-a.git');
    const first = await prepareRepoIntelligence(repo, 'service boundary', config);
    assert.equal(first.retrieved.length, 0);
    assert.equal(first.familiarity.facts, 0);

    const recorded = await recordRepoIntelligenceLearning(first, config, {
      result: successfulResult(repo),
      facts: [
        {
          kind: 'architecture',
          text: 'src/service.ts is the repository service boundary; callers should use it instead of bypassing it.',
          tags: ['service', 'boundary'],
          sourcePaths: ['src/service.ts'],
          confidence: 0.94
        }
      ]
    });
    assert.equal(recorded.learnedFacts, 1);
    assert.ok(recorded.familiarity.overall > 0);

    const second = await prepareRepoIntelligence(repo, 'change the service boundary', config);
    assert.equal(second.retrieved.length, 1);
    assert.equal(second.retrieved[0].stale, false);
    assert.match(second.capsule, /repository service boundary/i);

    await fs.writeFile(
      path.join(repo, 'src', 'service.ts'),
      'export function service() { return "uncommitted-v2"; }\n',
      'utf8'
    );

    const third = await prepareRepoIntelligence(repo, 'change the service boundary', config);
    assert.equal(third.retrieved.length, 1);
    assert.equal(third.retrieved[0].stale, true);
    assert.match(third.capsule, /STALE: verify source before relying/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('repo intelligence notices Git changes and isolates repositories and separate same-origin clones', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-intelligence-isolation-'));
  const config = { workerStatePath: path.join(root, 'state') };

  try {
    const sharedOrigin = 'https://github.com/example/repo-a.git';
    const repoA = await createRepo(root, 'repo-a', sharedOrigin);
    const repoB = await createRepo(root, 'repo-b', 'https://github.com/example/repo-b.git');
    const repoASeparateClone = await createRepo(root, 'repo-a-other-clone', sharedOrigin);

    const sessionA = await prepareRepoIntelligence(repoA, 'service', config);
    await recordRepoIntelligenceLearning(sessionA, config, {
      result: successfulResult(repoA),
      facts: [
        {
          kind: 'invariant',
          text: 'Service callers must preserve the repo A invariant.',
          tags: ['service', 'repo-a'],
          sourcePaths: ['src/service.ts'],
          confidence: 0.9
        }
      ]
    });

    const sessionB = await prepareRepoIntelligence(repoB, 'service invariant', config);
    assert.notEqual(sessionA.identityKey, sessionB.identityKey);
    assert.equal(sessionB.retrieved.length, 0);
    assert.equal(sessionB.familiarity.facts, 0);

    const separateClone = await prepareRepoIntelligence(
      repoASeparateClone,
      'service invariant',
      config
    );
    assert.notEqual(sessionA.memoryScopeKey, separateClone.memoryScopeKey);
    assert.notEqual(sessionA.identityKey, separateClone.identityKey);
    assert.equal(separateClone.retrieved.length, 0);
    assert.equal(separateClone.familiarity.facts, 0);

    await fs.writeFile(
      path.join(repoA, 'src', 'service.ts'),
      'export function service() { return "committed-v2"; }\n',
      'utf8'
    );
    await run('git', ['add', '.'], repoA);
    await run('git', ['commit', '-m', 'change service'], repoA);

    const changed = await prepareRepoIntelligence(repoA, 'service invariant', config);
    assert.ok(changed.gitChangesDetected.includes('src/service.ts'));
    assert.equal(changed.retrieved[0]?.stale, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
