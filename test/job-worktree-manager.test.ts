import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JobWorktreeManager } from '../src/job-worktree-manager.js';
import type { LocalEngineerResult } from '../src/local-engineer.js';
import { StandaloneJobManager } from '../src/standalone-job-manager.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function waitForStatus(manager: StandaloneJobManager, id: string, status: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (manager.get(id)?.status !== status) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${status}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function success(input: { workspace: string; goal: string }): LocalEngineerResult {
  return {
    status: 'success', phase: 'complete', workspace: input.workspace, goal: input.goal, summary: 'done',
    investigation: { searchQueries: [], evidenceFiles: [], researchRequests: [] }, repairRounds: 0,
    changedFiles: [], diff: '', validation: [], modelCalls: []
  };
}

test('product job worktree protects a dirty source checkout, recovers exact ownership, and cleans up', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-job-worktree-'));
  const source = path.join(directory, 'source');
  const storage = path.join(directory, 'state', 'worktrees');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'value.txt'), 'base\n');
  git(source, ['init', '--quiet']);
  git(source, ['config', 'user.email', 'axis@example.test']);
  git(source, ['config', 'user.name', 'Axis Test']);
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'base']);
  await fs.writeFile(path.join(source, 'value.txt'), 'dirty source\n');

  try {
    const manager = new JobWorktreeManager(storage);
    const worktree = await manager.prepare({
      jobId: 'job-1', companyId: 'company-a', projectId: 'project-a',
      sourceWorkspace: source, signal: new AbortController().signal
    });
    assert.ok(worktree);
    assert.equal(await fs.readFile(path.join(source, 'value.txt'), 'utf8'), 'dirty source\n');
    assert.equal(await fs.readFile(path.join(worktree.workspace, 'value.txt'), 'utf8'), 'base\n');
    assert.match(git(source, ['worktree', 'list', '--porcelain']), new RegExp(`locked ${worktree.ownershipLock}`));

    const recovered = await manager.prepare({
      jobId: 'job-1', companyId: 'company-a', projectId: 'project-a',
      sourceWorkspace: source, existing: worktree, signal: new AbortController().signal
    });
    assert.deepEqual(recovered, worktree);

    await manager.cleanup(worktree, new AbortController().signal);
    await assert.rejects(() => fs.access(worktree.workspace));
    assert.equal(await fs.readFile(path.join(source, 'value.txt'), 'utf8'), 'dirty source\n');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('managed job worktree recovery rejects a forged Company ownership record', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-job-worktree-'));
  const source = path.join(directory, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'value.txt'), 'base\n');
  git(source, ['init', '--quiet']);
  git(source, ['config', 'user.email', 'axis@example.test']);
  git(source, ['config', 'user.name', 'Axis Test']);
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'base']);

  try {
    const manager = new JobWorktreeManager(path.join(directory, 'state', 'worktrees'));
    const worktree = await manager.prepare({ jobId: 'job-1', companyId: 'company-a', sourceWorkspace: source, signal: new AbortController().signal });
    assert.ok(worktree);
    await assert.rejects(
      () => manager.prepare({
        jobId: 'job-1', companyId: 'company-b', sourceWorkspace: source,
        existing: worktree,
        signal: new AbortController().signal
      }),
      /ownership does not match/
    );
    await manager.cleanup(worktree, new AbortController().signal);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('cleanup preserves a managed worktree with unintegrated changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-job-worktree-'));
  const source = path.join(directory, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'value.txt'), 'base\n');
  git(source, ['init', '--quiet']);
  git(source, ['config', 'user.email', 'axis@example.test']);
  git(source, ['config', 'user.name', 'Axis Test']);
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'base']);
  try {
    const manager = new JobWorktreeManager(path.join(directory, 'state', 'worktrees'));
    const worktree = await manager.prepare({ jobId: 'job-dirty', companyId: 'company-a', sourceWorkspace: source, signal: new AbortController().signal });
    assert.ok(worktree);
    await fs.writeFile(path.join(worktree.workspace, 'value.txt'), 'unintegrated\n');
    await assert.rejects(() => manager.cleanup(worktree, new AbortController().signal), /unintegrated changes.*preserved/);
    assert.equal(await fs.readFile(path.join(worktree.workspace, 'value.txt'), 'utf8'), 'unintegrated\n');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Cowork persists its exact managed root and rehydrates it without changing the source checkout', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-job-worktree-'));
  const source = path.join(directory, 'source');
  const state = path.join(directory, 'state');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'value.txt'), 'base\n');
  git(source, ['init', '--quiet']);
  git(source, ['config', 'user.email', 'axis@example.test']);
  git(source, ['config', 'user.name', 'Axis Test']);
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'base']);
  try {
    const manager = new StandaloneJobManager({ executeEngineer: async (input) => success(input) }, state);
    const job = manager.create({ companyId: 'company-a', projectId: 'project-a', workspace: source, goal: 'Change it.' });
    await waitForStatus(manager, job.id, 'success');
    const saved = manager.get(job.id);
    assert.ok(saved?.worktree);
    assert.equal(saved?.input.workspace, saved?.worktree?.workspace);
    assert.equal(await fs.readFile(path.join(source, 'value.txt'), 'utf8'), 'base\n');

    const restored = new StandaloneJobManager({ executeEngineer: async (input) => success(input) }, state);
    await restored.restore();
    assert.equal(restored.get(job.id)?.worktree?.workspace, saved?.worktree?.workspace);
    assert.equal(await restored.remove(job.id), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('restart pauses an unresolved mutation until an explicit recovery decision', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-job-restart-'));
  const workspace = path.join(directory, 'workspace');
  const state = path.join(directory, 'state');
  await fs.mkdir(workspace);
  let releaseFirst!: () => void;
  const first = new StandaloneJobManager({
    executeEngineer: async (input) => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return success(input);
    }
  }, state);
  let createdId = '';
  try {
    const created = first.create({ companyId: 'company-a', workspace, goal: 'Mutate.' });
    createdId = created.id;
    await waitForStatus(first, created.id, 'running');
    first.recordMutation(created.id, {
      callId: 'mutation-1', toolName: 'write_file', mutationStatus: 'unknown',
      startedAt: new Date().toISOString()
    });
    await first.setPendingCheckpoint(created.id, undefined);

    let resumedRuns = 0;
    const restored = new StandaloneJobManager({
      executeEngineer: async (input) => { resumedRuns += 1; return success(input); }
    }, state);
    await restored.restore();
    assert.equal(restored.get(created.id)?.status, 'waiting-guidance');
    assert.equal(restored.get(created.id)?.recoveryState?.kind, 'indeterminate-mutation');
    assert.equal(resumedRuns, 0);
    assert.throws(() => restored.submitGuidance(created.id, 'continue'), /explicit recovery decision/);

    restored.resolveIndeterminateMutation(created.id, 'retry-confirmed');
    await waitForStatus(restored, created.id, 'success');
    assert.equal(resumedRuns, 1);
    assert.equal(restored.get(created.id)?.mutationLedger?.[0]?.retryDecision, 'retry-confirmed');
    assert.ok(restored.get(created.id)?.mutationLedger?.[0]?.resolvedAt);
    await restored.setPendingCheckpoint(created.id, undefined);
  } finally {
    releaseFirst?.();
    if (createdId && first.get(createdId)?.status === 'running') await waitForStatus(first, createdId, 'success');
    if (createdId) await first.setPendingCheckpoint(createdId, undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
