import { AsyncLocalStorage } from 'node:async_hooks';

import type { EngineeringProgress, ProgressReporter } from './engineering-progress.js';

interface ProgressContext {
  reporter: ProgressReporter;
  jobId?: string;
}

const storage = new AsyncLocalStorage<ProgressContext>();

export async function withProgressReporter<T>(
  reporter: ProgressReporter,
  run: () => Promise<T>,
  jobId?: string
): Promise<T> {
  return await storage.run({ reporter, jobId }, run);
}

export function reportProgress(progress: Partial<EngineeringProgress>): void {
  storage.getStore()?.reporter(progress);
}

export function currentProgressJobId(): string | undefined {
  return storage.getStore()?.jobId;
}
