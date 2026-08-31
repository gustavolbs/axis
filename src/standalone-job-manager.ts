import { randomUUID } from 'node:crypto';

import type { ExecutionBackend } from './execution-runtime.js';
import type { LocalEngineerInput, LocalEngineerResult } from './local-engineer.js';
import type { PremiumDecisionRequest, PremiumEngineerResult } from './premium-agent.js';

export type StandaloneJobStatus =
  | 'queued'
  | 'running'
  | 'waiting-decision'
  | 'waiting-guidance'
  | 'success'
  | 'error';

export interface StandaloneJobInput {
  workspace: string;
  goal: string;
  context?: string;
  constraints?: string[];
  language?: string;
  maxRepairRounds?: number;
}

export interface StandaloneJobEvent {
  id: string;
  jobId: string;
  type: 'status' | 'decision' | 'result' | 'error' | 'guidance';
  timestamp: string;
  title: string;
  data?: Record<string, unknown>;
}

export interface StandaloneJobSnapshot {
  id: string;
  status: StandaloneJobStatus;
  createdAt: string;
  updatedAt: string;
  input: StandaloneJobInput;
  decisionRequest?: PremiumDecisionRequest;
  result?: LocalEngineerResult;
  error?: string;
  rounds: number;
  events: StandaloneJobEvent[];
}

type WaitingInput = {
  kind: 'decision' | 'guidance';
  resolve: (value: string) => void;
};

type JobInternal = StandaloneJobSnapshot & {
  waiting?: WaitingInput;
  guidance?: string;
};

export type JobListener = (event: StandaloneJobEvent, job: StandaloneJobSnapshot) => void;

function premium(result: LocalEngineerResult): PremiumEngineerResult {
  return result as PremiumEngineerResult;
}

function snapshot(job: JobInternal): StandaloneJobSnapshot {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    input: job.input,
    decisionRequest: job.decisionRequest,
    result: job.result,
    error: job.error,
    rounds: job.rounds,
    events: [...job.events]
  };
}

function mergeGuidance(existing: string | undefined, next: string): string {
  return [existing?.trim(), next.trim()].filter(Boolean).join('\n\n');
}

function renderSelections(
  request: PremiumDecisionRequest,
  selections: Record<string, string>
): string {
  const lines: string[] = ['# USER DECISIONS (authoritative)'];
  for (const question of request.questions) {
    const selectedId = selections[question.id];
    const option = question.options.find((candidate) => candidate.id === selectedId);
    if (!option) {
      throw new Error(`Invalid selection for decision ${question.id}.`);
    }
    lines.push(`- ${question.id}: ${option.id} — ${option.label}.`);
  }
  return lines.join('\n');
}

export class StandaloneJobManager {
  private readonly jobs = new Map<string, JobInternal>();
  private readonly listeners = new Set<JobListener>();

  constructor(private readonly execution: Pick<ExecutionBackend, 'executeEngineer'>) {}

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): StandaloneJobSnapshot[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(snapshot);
  }

  get(id: string): StandaloneJobSnapshot | undefined {
    const job = this.jobs.get(id);
    return job ? snapshot(job) : undefined;
  }

  create(input: StandaloneJobInput): StandaloneJobSnapshot {
    if (!input.workspace.trim()) throw new Error('workspace is required.');
    if (!input.goal.trim()) throw new Error('goal is required.');
    const now = new Date().toISOString();
    const job: JobInternal = {
      id: randomUUID(),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      input: {
        ...input,
        workspace: input.workspace.trim(),
        goal: input.goal.trim()
      },
      rounds: 0,
      events: []
    };
    this.jobs.set(job.id, job);
    this.emit(job, 'status', 'Job queued');
    void this.run(job);
    return snapshot(job);
  }

  submitDecision(id: string, selections: Record<string, string>): StandaloneJobSnapshot {
    const job = this.requireJob(id);
    if (job.status !== 'waiting-decision' || !job.waiting || job.waiting.kind !== 'decision') {
      throw new Error('Job is not waiting for a decision.');
    }
    if (!job.decisionRequest) throw new Error('Decision request is missing.');
    const guidance = renderSelections(job.decisionRequest, selections);
    job.guidance = mergeGuidance(job.guidance, guidance);
    job.decisionRequest = undefined;
    const waiting = job.waiting;
    job.waiting = undefined;
    job.status = 'running';
    this.emit(job, 'decision', 'User decision received', { selections });
    waiting.resolve(guidance);
    return snapshot(job);
  }

  submitGuidance(id: string, guidance: string): StandaloneJobSnapshot {
    const job = this.requireJob(id);
    if (job.status !== 'waiting-guidance' || !job.waiting || job.waiting.kind !== 'guidance') {
      throw new Error('Job is not waiting for guidance.');
    }
    if (!guidance.trim()) throw new Error('guidance is required.');
    job.guidance = mergeGuidance(job.guidance, guidance);
    const waiting = job.waiting;
    job.waiting = undefined;
    job.status = 'running';
    this.emit(job, 'guidance', 'Additional guidance received');
    waiting.resolve(guidance.trim());
    return snapshot(job);
  }

  private requireJob(id: string): JobInternal {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found.');
    return job;
  }

  private emit(
    job: JobInternal,
    type: StandaloneJobEvent['type'],
    title: string,
    data?: Record<string, unknown>
  ): void {
    job.updatedAt = new Date().toISOString();
    const event: StandaloneJobEvent = {
      id: randomUUID(),
      jobId: job.id,
      type,
      timestamp: job.updatedAt,
      title,
      data
    };
    job.events.push(event);
    job.events.splice(200);
    const publicJob = snapshot(job);
    for (const listener of this.listeners) listener(event, publicJob);
  }

  private wait(job: JobInternal, kind: WaitingInput['kind']): Promise<string> {
    return new Promise((resolve) => {
      job.waiting = { kind, resolve };
    });
  }

  private async run(job: JobInternal): Promise<void> {
    try {
      job.status = 'running';
      this.emit(job, 'status', 'Local agent started');

      for (let round = 1; round <= 6; round += 1) {
        job.rounds = round;
        const input: LocalEngineerInput = {
          ...job.input,
          claudeGuidance: job.guidance
        };
        this.emit(job, 'status', `Agent round ${round} running`);
        const result = await this.execution.executeEngineer(input);
        job.result = result;

        if (result.status === 'success') {
          job.status = 'success';
          this.emit(job, 'result', 'Local agent completed', {
            changedFiles: result.changedFiles.length,
            quality: premium(result).quality ?? null
          });
          return;
        }

        const decisionRequest = premium(result).decisionRequest;
        if (decisionRequest?.questions.length) {
          job.status = 'waiting-decision';
          job.decisionRequest = decisionRequest;
          this.emit(job, 'decision', 'Material user decision required', {
            questions: decisionRequest.questions.map((question) => question.id)
          });
          await this.wait(job, 'decision');
          continue;
        }

        if (result.escalation) {
          job.status = 'waiting-guidance';
          this.emit(job, 'guidance', 'The local agent needs bounded external guidance', {
            kind: result.escalation.kind,
            questions: result.escalation.questions,
            researchRequests: result.escalation.researchRequests
          });
          await this.wait(job, 'guidance');
          continue;
        }

        throw new Error(`Agent stopped with status ${result.status} without a resumable checkpoint.`);
      }

      throw new Error('Standalone agent exceeded the six-round resume safety limit.');
    } catch (error) {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
      this.emit(job, 'error', 'Local agent failed', { error: job.error });
    }
  }
}
