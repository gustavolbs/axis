import { createHash, randomUUID } from 'node:crypto';

export type WorkerJobKind = 'chat' | 'task' | 'plan' | 'engineer';

interface PendingJob<T> {
  id: string;
  kind: WorkerJobKind;
  isolationKey: string;
  enqueuedAt: number;
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface ActiveJob {
  id: string;
  kind: WorkerJobKind;
  isolationKey: string;
  startedAt: number;
}

export interface WorkerSchedulerSnapshot {
  maxConcurrentJobs: number;
  activeJobs: number;
  queuedJobs: number;
  active: Array<{
    id: string;
    kind: WorkerJobKind;
    isolationKey: string;
    runningMs: number;
  }>;
  queued: Array<{
    id: string;
    kind: WorkerJobKind;
    isolationKey: string;
    waitingMs: number;
  }>;
}

function opaqueKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Accepts work from many Claude/MCP processes while keeping resource usage bounded.
 * Jobs sharing an isolation key never overlap. Different worktrees may overlap only
 * when maxConcurrentJobs > 1; the Ollama client still serializes actual inference.
 */
export class WorkerScheduler {
  private readonly pending: Array<PendingJob<unknown>> = [];
  private readonly active = new Map<string, ActiveJob>();
  private readonly activeIsolationKeys = new Set<string>();

  constructor(private readonly maxConcurrentJobs = 1) {
    if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1) {
      throw new Error('maxConcurrentJobs must be a positive integer.');
    }
  }

  async enqueue<T>(
    kind: WorkerJobKind,
    isolationKeyInput: string,
    run: () => Promise<T>
  ): Promise<T> {
    const isolationKey = opaqueKey(isolationKeyInput || 'global');

    return await new Promise<T>((resolve, reject) => {
      this.pending.push({
        id: randomUUID(),
        kind,
        isolationKey,
        enqueuedAt: Date.now(),
        run,
        resolve: resolve as PendingJob<unknown>['resolve'],
        reject
      });
      this.drain();
    });
  }

  snapshot(): WorkerSchedulerSnapshot {
    const now = Date.now();
    return {
      maxConcurrentJobs: this.maxConcurrentJobs,
      activeJobs: this.active.size,
      queuedJobs: this.pending.length,
      active: [...this.active.values()].map((job) => ({
        id: job.id,
        kind: job.kind,
        isolationKey: job.isolationKey,
        runningMs: Math.max(0, now - job.startedAt)
      })),
      queued: this.pending.slice(0, 20).map((job) => ({
        id: job.id,
        kind: job.kind,
        isolationKey: job.isolationKey,
        waitingMs: Math.max(0, now - job.enqueuedAt)
      }))
    };
  }

  private drain(): void {
    while (this.active.size < this.maxConcurrentJobs) {
      const index = this.pending.findIndex(
        (job) => !this.activeIsolationKeys.has(job.isolationKey)
      );
      if (index < 0) return;

      const [job] = this.pending.splice(index, 1);
      this.active.set(job.id, {
        id: job.id,
        kind: job.kind,
        isolationKey: job.isolationKey,
        startedAt: Date.now()
      });
      this.activeIsolationKeys.add(job.isolationKey);

      void job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active.delete(job.id);
          this.activeIsolationKeys.delete(job.isolationKey);
          this.drain();
        });
    }
  }
}
