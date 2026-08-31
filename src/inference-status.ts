import { randomUUID } from 'node:crypto';

export type InferenceStage =
  | 'investigation'
  | 'planning'
  | 'implementation'
  | 'review'
  | 'repo-learning'
  | 'other';

export interface InferenceSnapshot {
  id: string;
  stage: InferenceStage;
  model: string;
  startedAt: string;
  runningMs: number;
}

export interface CompletedInferenceSnapshot {
  id: string;
  stage: InferenceStage;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'success' | 'error';
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

interface ActiveInference {
  id: string;
  stage: InferenceStage;
  model: string;
  startedAtMs: number;
}

export function classifyInferenceStage(systemPrompt: string): InferenceStage {
  const prompt = systemPrompt.toLowerCase();
  if (prompt.includes('investigation stage of a local software-engineering agent')) {
    return 'investigation';
  }
  if (prompt.includes('reasoning/planning stage of a local software-engineering agent')) {
    return 'planning';
  }
  if (prompt.includes('adversarial software-engineering reviewer')) {
    return 'review';
  }
  if (prompt.includes('durable repository intelligence')) {
    return 'repo-learning';
  }
  if (prompt.includes('local coding execution model')) {
    return 'implementation';
  }
  return 'other';
}

export class WorkerInferenceTracker {
  private current?: ActiveInference;
  private readonly recent: CompletedInferenceSnapshot[] = [];

  begin(stage: InferenceStage, model: string): string {
    const id = randomUUID();
    this.current = { id, stage, model, startedAtMs: Date.now() };
    return id;
  }

  complete(
    id: string,
    status: 'success' | 'error',
    metadata: {
      promptTokens?: number;
      completionTokens?: number;
      error?: string;
    } = {}
  ): void {
    if (!this.current || this.current.id !== id) return;
    const current = this.current;
    const finishedAtMs = Date.now();
    this.current = undefined;
    this.recent.unshift({
      id: current.id,
      stage: current.stage,
      model: current.model,
      startedAt: new Date(current.startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - current.startedAtMs),
      status,
      promptTokens: metadata.promptTokens,
      completionTokens: metadata.completionTokens,
      error: metadata.error
    });
    this.recent.splice(24);
  }

  snapshot(): { current: InferenceSnapshot | null; recent: CompletedInferenceSnapshot[] } {
    const current = this.current
      ? {
          id: this.current.id,
          stage: this.current.stage,
          model: this.current.model,
          startedAt: new Date(this.current.startedAtMs).toISOString(),
          runningMs: Math.max(0, Date.now() - this.current.startedAtMs)
        }
      : null;
    return { current, recent: [...this.recent] };
  }
}
