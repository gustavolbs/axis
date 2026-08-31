import { AsyncLocalStorage } from 'node:async_hooks';

import type { EngineeringProgress, ProgressReporter } from './engineering-progress.js';

const storage = new AsyncLocalStorage<ProgressReporter>();

export async function withProgressReporter<T>(reporter: ProgressReporter, run: () => Promise<T>): Promise<T> {
  return await storage.run(reporter, run);
}

export function reportProgress(progress: Partial<EngineeringProgress>): void {
  storage.getStore()?.(progress);
}
