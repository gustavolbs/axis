import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerScheduler } from '../src/worker-scheduler.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for scheduler state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('queues independent Claude-session jobs sequentially by default', async () => {
  const scheduler = new WorkerScheduler(1);
  const firstGate = deferred();
  const order: string[] = [];

  const first = scheduler.enqueue('engineer', 'repo-a-worktree-1', async () => {
    order.push('first:start');
    await firstGate.promise;
    order.push('first:end');
    return 1;
  });
  const second = scheduler.enqueue('engineer', 'repo-b-worktree-1', async () => {
    order.push('second:start');
    order.push('second:end');
    return 2;
  });

  await waitFor(() => scheduler.snapshot().activeJobs === 1 && scheduler.snapshot().queuedJobs === 1);
  assert.deepEqual(order, ['first:start']);

  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('allows separate worktree isolation keys to overlap when concurrency is explicitly raised', async () => {
  const scheduler = new WorkerScheduler(2);
  const gate = deferred();
  let active = 0;
  let maxActive = 0;

  const run = (key: string) =>
    scheduler.enqueue('task', key, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active -= 1;
    });

  const first = run('repo-a-worktree-1');
  const second = run('repo-b-worktree-1');
  await waitFor(() => scheduler.snapshot().activeJobs === 2);
  assert.equal(maxActive, 2);
  gate.resolve();
  await Promise.all([first, second]);
});

test('never overlaps mutable jobs sharing the same checkout isolation key', async () => {
  const scheduler = new WorkerScheduler(2);
  const firstGate = deferred();
  let active = 0;
  let maxActive = 0;

  const first = scheduler.enqueue('plan', 'same-worktree', async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await firstGate.promise;
    active -= 1;
  });
  const second = scheduler.enqueue('engineer', 'same-worktree', async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
  });

  await waitFor(() => scheduler.snapshot().activeJobs === 1 && scheduler.snapshot().queuedJobs === 1);
  assert.equal(maxActive, 1);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
});
