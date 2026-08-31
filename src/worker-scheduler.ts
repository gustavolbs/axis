import { createHash, randomUUID } from 'node:crypto';

import type { EngineeringProgress } from './engineering-progress.js';
import { withProgressReporter } from './progress-context.js';

export type WorkerJobKind = 'chat' | 'task' | 'plan' | 'engineer';
export type WorkerJobProgress = EngineeringProgress;

export interface WorkerJobContext {
  id: string;
  update(progress: Partial<WorkerJobProgress>): void;
}

interface PendingJob<T> {
  id: string;
  kind: WorkerJobKind;
  isolationKey: string;
  enqueuedAt: number;
  run: (context: WorkerJobContext) => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface ActiveJob {
  id: string;
  kind: WorkerJobKind;
  isolationKey: string;
  startedAt: number;
  progress: WorkerJobProgress;
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
    progress: WorkerJobProgress;
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

function cloneProgress(progress: WorkerJobProgress): WorkerJobProgress {
  return {
    ...progress,
    files: progress.files ? [...progress.files] : undefined,
    completedSteps: progress.completedSteps ? [...progress.completedSteps] : undefined
  };
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
    run: (context: WorkerJobContext) => Promise<T>
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
        runningMs: Math.max(0, now - job.startedAt),
        progress: cloneProgress(job.progress)
      })),
      queued: this.pending.slice(0, 20).map((job) => ({
        id: job.id,
        kind: job.kind,
        isolationKey: job.isolationKey,
        waitingMs: Math.max(0, now - job.enqueuedAt)
      }))
    };
  }

  private updateProgress(id: string, patch: Partial<WorkerJobProgress>): void {
    const job = this.active.get(id);
    if (!job) return;
    job.progress = {
      ...job.progress,
      ...patch,
      files: patch.files ? [...patch.files] : job.progress.files,
      completedSteps: patch.completedSteps ? [...patch.completedSteps] : job.progress.completedSteps,
      updatedAt: new Date().toISOString()
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
        startedAt: Date.now(),
        progress: {
          phase: 'workspace',
          action: 'Starting worker job',
          detail: 'The request left the Mac control plane and is now executing on Windows.',
          completedSteps: [],
          updatedAt: new Date().toISOString()
        }
      });
      this.activeIsolationKeys.add(job.isolationKey);

      const context: WorkerJobContext = {
        id: job.id,
        update: (progress) => this.updateProgress(job.id, progress)
      };

      void withProgressReporter(context.update, () => job.run(context))
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active.delete(job.id);
          this.activeIsolationKeys.delete(job.isolationKey);
          this.drain();
        });
    }
  }
}
