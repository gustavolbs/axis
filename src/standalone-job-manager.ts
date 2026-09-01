import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  isCancellationError,
  throwIfCancelled,
  withCancellationSignal
} from './cancellation.js';
import type { ExecutionBackend } from './execution-runtime.js';
import type { LocalEngineerResult } from './local-engineer.js';
import type { PremiumDecisionRequest, PremiumEngineerResult } from './premium-agent.js';
import type {
  ProjectEngineerInput,
  ProjectEscalationChoice,
  ProjectEscalationGuidance,
  ProjectEscalationPlan
} from './project-engineer-backend.js';
import type { ModelSelection } from './project-store.js';
import type { ReasoningEffort } from './providers/types.js';

export type StandaloneJobStatus =
  | 'queued'
  | 'running'
  | 'waiting-decision'
  | 'waiting-guidance'
  | 'success'
  | 'cancelled'
  | 'error';

export type StandaloneReasoningEffort = 'auto' | ReasoningEffort;
export type StandaloneInteractionMode = 'chat' | 'cowork';

export interface StandaloneJobInput {
  projectId?: string;
  workspace: string;
  goal: string;
  context?: string;
  constraints?: string[];
  language?: string;
  maxRepairRounds?: number;
  /** Chat is a single conversational inference; Cowork runs the engineering pipeline. */
  interactionMode?: StandaloneInteractionMode;
  /** Optional standalone override. Auto preserves the Project/agent stage policy. */
  modelSelection?: ModelSelection;
  /** Optional standalone override applied to every routed cognitive stage. */
  reasoningEffort?: StandaloneReasoningEffort;
}

export interface StandaloneJobEvent {
  id: string;
  jobId: string;
  type: 'status' | 'decision' | 'result' | 'error' | 'guidance' | 'cancelled';
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
  escalationPlan?: ProjectEscalationPlan;
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
  controller?: AbortController;
};

type PersistedJob = Omit<JobInternal, 'waiting' | 'controller'>;

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
    escalationPlan: job.escalationPlan,
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
    if (!option) throw new Error(`Invalid selection for decision ${question.id}.`);
    lines.push(`- ${question.id}: ${option.id} — ${option.label}.`);
  }
  return lines.join('\n');
}

function renderEscalationGuidance(guidance: ProjectEscalationGuidance): string {
  return [
    '# CLOUD ESCALATION GUIDANCE (bounded consultation)',
    `Provider: ${guidance.providerId}`,
    `Model: ${guidance.modelId}`,
    `Reasoning effort: ${guidance.reasoningEffort}`,
    '',
    guidance.content.trim()
  ].join('\n');
}

export class StandaloneJobManager {
  private readonly jobs = new Map<string, JobInternal>();
  private readonly listeners = new Set<JobListener>();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly execution: Pick<
      ExecutionBackend,
      'executeEngineer' | 'prepareEscalation' | 'consultEscalation'
    >,
    private readonly stateDir?: string
  ) {}

  async restore(): Promise<void> {
    if (!this.stateDir) return;
    const file = this.stateFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(
        `Could not restore Local Coder sessions from ${file}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!Array.isArray(parsed)) throw new Error(`Standalone job store ${file} must contain an array.`);

    for (const raw of parsed.slice(0, 30)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const job = raw as PersistedJob;
      if (typeof job.id !== 'string' || !job.input || typeof job.input.goal !== 'string') continue;
      this.jobs.set(job.id, {
        ...job,
        events: Array.isArray(job.events) ? job.events.slice(-200) : []
      });
    }

    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'queued';
        this.emit(job, 'status', 'App restarted; resuming job from durable checkpoint');
        void this.run(job);
      }
    }
  }

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
        projectId: input.projectId?.trim() || undefined,
        workspace: input.workspace.trim(),
        goal: input.goal.trim(),
        interactionMode: input.interactionMode ?? 'cowork',
        reasoningEffort: input.reasoningEffort ?? 'auto'
      },
      rounds: 0,
      events: [],
      controller: new AbortController()
    };
    this.jobs.set(job.id, job);
    this.emit(job, 'status', input.interactionMode === 'chat' ? 'Chat queued' : 'Job queued');
    void this.run(job);
    return snapshot(job);
  }

  async cancel(id: string): Promise<StandaloneJobSnapshot> {
    const job = this.requireJob(id);
    if (job.status === 'cancelled') {
      await this.persistTail;
      return snapshot(job);
    }
    if (job.status === 'success' || job.status === 'error') {
      throw new Error(`Cannot cancel a completed job with status ${job.status}.`);
    }

    job.status = 'cancelled';
    job.error = undefined;
    job.decisionRequest = undefined;
    job.escalationPlan = undefined;
    job.controller?.abort();
    const waiting = job.waiting;
    job.waiting = undefined;
    this.emit(job, 'cancelled', 'Job cancelled by user');
    await this.persistTail;
    waiting?.resolve('');
    return snapshot(job);
  }

  submitDecision(id: string, selections: Record<string, string>): StandaloneJobSnapshot {
    const job = this.requireJob(id);
    if (job.status !== 'waiting-decision') throw new Error('Job is not waiting for a decision.');
    if (!job.decisionRequest) throw new Error('Decision request is missing.');
    const guidance = renderSelections(job.decisionRequest, selections);
    job.guidance = mergeGuidance(job.guidance, guidance);
    job.decisionRequest = undefined;
    const waiting = job.waiting?.kind === 'decision' ? job.waiting : undefined;
    job.waiting = undefined;
    job.status = 'running';
    this.emit(job, 'decision', 'User decision received', { selections });
    if (waiting) waiting.resolve(guidance);
    else {
      job.controller = new AbortController();
      void this.run(job);
    }
    return snapshot(job);
  }

  submitGuidance(id: string, guidance: string): StandaloneJobSnapshot {
    const job = this.requireJob(id);
    if (job.status !== 'waiting-guidance') throw new Error('Job is not waiting for guidance.');
    if (!guidance.trim()) throw new Error('guidance is required.');
    job.guidance = mergeGuidance(job.guidance, guidance);
    job.escalationPlan = undefined;
    const waiting = job.waiting?.kind === 'guidance' ? job.waiting : undefined;
    job.waiting = undefined;
    job.status = 'running';
    this.emit(job, 'guidance', 'Additional guidance received');
    if (waiting) waiting.resolve(guidance.trim());
    else {
      job.controller = new AbortController();
      void this.run(job);
    }
    return snapshot(job);
  }

  async submitEscalation(
    id: string,
    choice: ProjectEscalationChoice
  ): Promise<StandaloneJobSnapshot> {
    const job = this.requireJob(id);
    if (job.status !== 'waiting-guidance') throw new Error('Job is not waiting for guidance.');
    if (job.input.modelSelection?.mode !== 'local-first') {
      throw new Error('Cloud consultation is only available for Local-first jobs.');
    }
    const escalation = job.result?.escalation;
    if (!escalation) throw new Error('Escalation request is missing.');
    if (!job.escalationPlan?.options.some(
      (option) => option.providerId === choice.providerId && option.modelId === choice.modelId
    )) {
      throw new Error(`Escalation target ${choice.providerId}/${choice.modelId} is not available for this job.`);
    }
    if (!this.execution.consultEscalation) throw new Error('Cloud escalation broker is unavailable.');

    const waiting = job.waiting?.kind === 'guidance' ? job.waiting : undefined;
    job.status = 'running';
    this.emit(job, 'guidance', `Escalating bounded question to ${choice.providerId}/${choice.modelId}`, {
      providerId: choice.providerId,
      modelId: choice.modelId,
      reasoningEffort: choice.reasoningEffort ?? null
    });

    try {
      const input: ProjectEngineerInput = {
        ...job.input,
        userGuidance: job.guidance,
        budgetJobId: job.id
      };
      const consultation = await this.execution.consultEscalation(input, escalation, choice);
      const rendered = renderEscalationGuidance(consultation);
      job.guidance = mergeGuidance(job.guidance, rendered);
      job.escalationPlan = undefined;
      job.waiting = undefined;
      job.status = 'running';
      this.emit(job, 'guidance', `Cloud guidance received from ${consultation.providerId}/${consultation.modelId}; resuming Ollama`, {
        providerId: consultation.providerId,
        modelId: consultation.modelId,
        reasoningEffort: consultation.reasoningEffort,
        latencyMs: consultation.latencyMs,
        usage: consultation.usage
      });
      if (waiting) waiting.resolve(rendered);
      else {
        job.controller = new AbortController();
        void this.run(job);
      }
      return snapshot(job);
    } catch (error) {
      job.status = 'waiting-guidance';
      this.emit(job, 'guidance', 'Cloud escalation failed; choose another target or provide guidance manually', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private requireJob(id: string): JobInternal {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found.');
    return job;
  }

  private stateFile(): string {
    return path.join(this.stateDir!, 'jobs.json');
  }

  private schedulePersist(): Promise<void> {
    if (!this.stateDir) return Promise.resolve();
    this.persistTail = this.persistTail.then(async () => {
      const jobs: PersistedJob[] = this.list()
        .slice(0, 30)
        .map((publicJob) => {
          const internal = this.jobs.get(publicJob.id)!;
          return {
            ...publicJob,
            guidance: internal.guidance
          };
        });
      await fs.mkdir(this.stateDir!, { recursive: true });
      const file = this.stateFile();
      const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await fs.writeFile(temp, `${JSON.stringify(jobs, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
    }).catch((error) => {
      console.error(`Local Coder session persistence failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.persistTail;
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
    job.events.splice(0, Math.max(0, job.events.length - 200));
    void this.schedulePersist();
    const publicJob = snapshot(job);
    for (const listener of this.listeners) listener(event, publicJob);
  }

  private wait(job: JobInternal, kind: WaitingInput['kind']): Promise<string> {
    return new Promise((resolve) => {
      job.waiting = { kind, resolve };
      void this.schedulePersist();
    });
  }

  private async run(job: JobInternal): Promise<void> {
    if (job.status === 'cancelled') return;
    const controller = job.controller ?? new AbortController();
    job.controller = controller;
    const isChat = job.input.interactionMode === 'chat';

    try {
      await withCancellationSignal(controller.signal, async () => {
        throwIfCancelled();
        job.status = 'running';
        this.emit(job, 'status', isChat
          ? 'Direct chat started'
          : job.rounds > 0 ? 'Local agent resumed' : 'Local agent started');

        for (let round = Math.max(1, job.rounds + 1); round <= 6; round += 1) {
          throwIfCancelled();
          job.rounds = round;
          const input: ProjectEngineerInput = {
            ...job.input,
            userGuidance: job.guidance,
            budgetJobId: job.id
          };
          this.emit(job, 'status', isChat ? 'Generating chat response' : `Agent round ${round} running`);
          const result = await this.execution.executeEngineer(input);
          throwIfCancelled();
          job.result = result;

          if (result.status === 'success') {
            job.status = 'success';
            job.escalationPlan = undefined;
            this.emit(job, 'result', isChat ? 'Chat response completed' : 'Local agent completed', {
              changedFiles: result.changedFiles.length,
              quality: isChat ? null : premium(result).quality ?? null
            });
            return;
          }

          if (isChat) {
            throw new Error('Chat mode returned an engineering checkpoint instead of a direct response.');
          }

          const decisionRequest = premium(result).decisionRequest;
          if (decisionRequest?.questions.length) {
            job.status = 'waiting-decision';
            job.decisionRequest = decisionRequest;
            job.escalationPlan = undefined;
            this.emit(job, 'decision', 'Material user decision required', {
              questions: decisionRequest.questions.map((question) => question.id)
            });
            await this.wait(job, 'decision');
            throwIfCancelled();
            continue;
          }

          if (result.escalation) {
            job.status = 'waiting-guidance';
            job.escalationPlan = undefined;
            if (
              job.input.modelSelection?.mode === 'local-first' &&
              this.execution.prepareEscalation
            ) {
              try {
                job.escalationPlan = await this.execution.prepareEscalation(input, result.escalation);
              } catch (error) {
                job.escalationPlan = {
                  stage: 'other',
                  options: [],
                  reasons: [
                    `Could not prepare cloud escalation: ${error instanceof Error ? error.message : String(error)}`,
                    'Manual guidance is still available.'
                  ]
                };
              }
            }
            this.emit(job, 'guidance', job.escalationPlan?.recommended
              ? `Ollama needs bounded help; recommended escalation is ${job.escalationPlan.recommended.providerId}/${job.escalationPlan.recommended.modelId}`
              : 'The local agent needs bounded external guidance', {
              kind: result.escalation.kind,
              questions: result.escalation.questions,
              researchRequests: result.escalation.researchRequests,
              recommended: job.escalationPlan?.recommended ?? null,
              options: job.escalationPlan?.options ?? []
            });
            await this.wait(job, 'guidance');
            throwIfCancelled();
            continue;
          }

          throw new Error(`Agent stopped with status ${result.status} without a resumable checkpoint.`);
        }

        throw new Error('Standalone agent exceeded the six-round resume safety limit.');
      });
    } catch (error) {
      if (controller.signal.aborted || isCancellationError(error)) {
        const alreadyCancelled = job.events.at(-1)?.type === 'cancelled';
        if (!alreadyCancelled) {
          job.status = 'cancelled';
          job.error = undefined;
          job.decisionRequest = undefined;
          job.escalationPlan = undefined;
          this.emit(job, 'cancelled', 'Job cancelled');
        }
        return;
      }
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
      this.emit(job, 'error', isChat ? 'Chat failed' : 'Local agent failed', { error: job.error });
    } finally {
      job.waiting = undefined;
      job.controller = undefined;
      void this.schedulePersist();
    }
  }
}
