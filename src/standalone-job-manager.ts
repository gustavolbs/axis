import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  isCancellationError,
  throwIfCancelled,
  withCancellationSignal
} from './cancellation.js';
import type { ExecutionBackend } from './execution-runtime.js';
import { JobWorktreeManager, type ManagedJobWorktree } from './job-worktree-manager.js';
import type { LocalEngineerResult } from './local-engineer.js';
import type { EngineeringProgress } from './engineering-progress.js';
import type { PremiumDecisionRequest, PremiumEngineerResult } from './premium-agent.js';
import type {
  AgentDecisionRequest,
  AgentDecisionResolution,
  AgentMessage,
  AgentSessionContext
} from './agent-runtime/index.js';
import type { MutationStatus } from './agent-runtime/contracts.js';
import type {
  ProjectEngineerInput,
  ProjectEscalationChoice,
  ProjectEscalationGuidance,
  ProjectEscalationPlan
} from './project-engineer-backend.js';
import type { ModelSelection } from './project-store.js';
import type { ReasoningEffort } from './providers/types.js';
import { withProgressReporter } from './progress-context.js';

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
  companyId?: string;
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

export interface StandaloneJobTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface StandaloneJobActivity {
  action: string;
  detail?: string;
  reasoningSummary?: string;
  activityKind?: EngineeringProgress['activityKind'];
  streamState?: EngineeringProgress['streamState'];
  providerId?: string;
  model?: string;
  eventCount?: number;
  outputChars?: number;
  elapsedMs?: number;
  updatedAt: string;
}

export interface ChatTurnOverrides {
  modelSelection?: ModelSelection;
  reasoningEffort?: StandaloneReasoningEffort;
}

/**
 * Serializable snapshot of the pending session state for durable restart.
 * Captures enough to restore a paused decision session or detect uncertain mutations.
 *
 * Invariants:
 * - decisionRequest is present only when the session is paused waiting for a decision.
 * - resolution is present only when the decision has been resolved by the user.
 * - mutationLedger tracks every tool call with mutation risk across the session.
 */
export interface PendingSessionCheckpoint {
  readonly sessionId: string;
  readonly companyId: string;
  readonly projectId?: string;
  readonly connectionId: string;
  readonly modelId: string;
  /** Snapshot of the immutable session context at checkpoint time. */
  readonly sessionContext: AgentSessionContext;
  /** Transcript messages at the time of checkpoint. */
  readonly transcript: readonly AgentMessage[];
  readonly turnIndex: number;
  /** Decision request when paused; absent when running or resolved. */
  readonly decisionRequest?: AgentDecisionRequest;
  /** Resolution applied by user before checkpoint; undefined means awaiting user. */
  readonly resolution?: AgentDecisionResolution;
  /** All tool calls with mutation risk that were executed up to this checkpoint. */
  readonly mutationLedger: readonly MutationLedgerEntry[];
  /** Guidance accumulated across the conversation. */
  readonly guidance?: string;
  readonly checkpointAt: string;
}

/**
 * Tracks one tool call's mutation lifecycle. Persisted so restart can distinguish
 * committed/rolled-back mutations (safe to skip) from started-unknown mutations
 * (must not be auto-retried without user confirmation).
 */
export interface MutationLedgerEntry {
  readonly callId: string;
  readonly toolName: string;
  readonly mutationStatus: MutationStatus;
  readonly startedAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: 'user' | 'agent' | 'unknown';
  readonly retryDecision?: 'retry-confirmed' | 'accept-committed' | 'cancel';
}

export interface StandaloneJobSnapshot {
  id: string;
  status: StandaloneJobStatus;
  createdAt: string;
  updatedAt: string;
  /** User-chosen name. The goal is the fallback title, not the name. */
  title?: string;
  /** Set while the conversation is archived; hidden from the sidebar. */
  archivedAt?: string;
  input: StandaloneJobInput;
  turns: StandaloneJobTurn[];
  /** Ephemeral safe progress metadata. Hidden reasoning text is never stored here. */
  activity?: StandaloneJobActivity;
  /** Bounded safe activity history used by the inline disclosure UI. */
  activityHistory?: StandaloneJobActivity[];
  decisionRequest?: PremiumDecisionRequest;
  escalationPlan?: ProjectEscalationPlan;
  result?: LocalEngineerResult;
  error?: string;
  rounds: number;
  events: StandaloneJobEvent[];
  /**
   * Durable checkpoint of the pending AgentRuntime session. Restored on app restart
   * to resume paused decision sessions and to surface uncertain mutations instead of
   * silently re-running them.
   */
  pendingCheckpoint?: PendingSessionCheckpoint;
  /**
   * Per-tool-call mutation ledger. Survives restart; used to disambiguate
   * committed/rolled-back from started-unknown mutations on recovery.
   */
  mutationLedger?: MutationLedgerEntry[];
  worktree?: ManagedJobWorktree;
  recoveryState?: {
    readonly kind: 'indeterminate-mutation';
    readonly callIds: readonly string[];
  };
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

/**
 * How many conversations survive on disk. This was 30, which silently destroyed
 * history: the store is rewritten in full on every change, so archiving a 31st
 * conversation removed the oldest one for good. Archived conversations persist
 * without their event log — progress telemetry, not content — which buys back
 * far more room than the higher limit costs.
 */
const PERSISTED_JOB_LIMIT = 200;
const MAX_PERSISTED_TURNS = 200;

function premium(result: LocalEngineerResult): PremiumEngineerResult {
  return result as PremiumEngineerResult;
}

function boundTurns(turns: StandaloneJobTurn[]): StandaloneJobTurn[] {
  return turns.slice(-MAX_PERSISTED_TURNS);
}

function lastUserTurnIndex(turns: StandaloneJobTurn[]): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === 'user') return index;
  }
  return -1;
}

function normalizeRestoredTurns(job: PersistedJob): StandaloneJobTurn[] {
  if (Array.isArray(job.turns)) {
    const turns = job.turns.filter((turn): turn is StandaloneJobTurn =>
      Boolean(turn) &&
      typeof turn.id === 'string' &&
      (turn.role === 'user' || turn.role === 'assistant') &&
      typeof turn.content === 'string' &&
      typeof turn.createdAt === 'string'
    );
    if (turns.length > 0) return boundTurns(turns);
  }

  const turns: StandaloneJobTurn[] = [];
  const first = job.input.goal.trim();
  if (first) {
    turns.push({
      id: randomUUID(),
      role: 'user',
      content: first,
      createdAt: job.createdAt
    });
  }
  // Only Chat renders successful answers from turns. Cowork keeps rendering its
  // result card exactly as before, so synthesizing a Cowork assistant turn here
  // would duplicate result.summary after restoring an old session.
  if (
    job.input.interactionMode === 'chat' &&
    job.status === 'success' &&
    job.result?.summary?.trim()
  ) {
    turns.push({
      id: randomUUID(),
      role: 'assistant',
      content: job.result.summary.trim(),
      createdAt: job.updatedAt
    });
  }
  return turns;
}

function snapshot(job: JobInternal): StandaloneJobSnapshot {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    title: job.title,
    archivedAt: job.archivedAt,
    input: job.input,
    turns: [...job.turns],
    activity: job.activity,
    activityHistory: job.activityHistory ? [...job.activityHistory] : [],
    decisionRequest: job.decisionRequest,
    escalationPlan: job.escalationPlan,
    result: job.result,
    error: job.error,
    rounds: job.rounds,
    events: [...job.events],
    pendingCheckpoint: job.pendingCheckpoint,
    mutationLedger: job.mutationLedger ? [...job.mutationLedger] : undefined,
    worktree: job.worktree,
    recoveryState: job.recoveryState
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
  private readonly lastActivityPublish = new Map<string, { action: string; at: number }>();
  private readonly worktrees: JobWorktreeManager;

  constructor(
    private execution: Pick<
      ExecutionBackend,
      'executeEngineer' | 'prepareEscalation' | 'consultEscalation'
    >,
    private readonly stateDir?: string
  ) {
    this.worktrees = new JobWorktreeManager(
      stateDir ? path.join(stateDir, 'worktrees') : undefined
    );
  }

  /**
   * Complete the jobs → product execution → AgentRuntime cycle after all objects
   * exist. Wiring is intentionally explicit so checkpoint calls and job execution
   * always use this same manager instance.
   */
  setExecution(
    execution: Pick<ExecutionBackend, 'executeEngineer' | 'prepareEscalation' | 'consultEscalation'>
  ): void {
    this.execution = execution;
  }

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

    for (const raw of parsed.slice(0, PERSISTED_JOB_LIMIT)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const job = raw as PersistedJob;
      if (typeof job.id !== 'string' || !job.input || typeof job.input.goal !== 'string') continue;
      this.jobs.set(job.id, {
        ...job,
        turns: normalizeRestoredTurns(job),
        events: Array.isArray(job.events) ? job.events.slice(-200) : []
      });
    }

    for (const job of this.jobs.values()) {
      const unresolved = job.mutationLedger?.filter((entry) =>
        (entry.mutationStatus === 'started' || entry.mutationStatus === 'unknown') && !entry.resolvedAt
      ) ?? [];
      if (unresolved.length > 0) {
        job.status = 'waiting-guidance';
        job.recoveryState = { kind: 'indeterminate-mutation', callIds: unresolved.map((entry) => entry.callId) };
        this.emit(job, 'guidance', 'App restarted after an indeterminate mutation; explicit recovery confirmation is required', {
          callIds: unresolved.map((entry) => entry.callId)
        });
        continue;
      }
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

  /**
   * Durable checkpoint of the pending session. Persisted to disk so the
   * paused decision request can be restored verbatim after a restart and
   * the mutation ledger is available to distinguish committed from uncertain
   * mutations on recovery.
   */
  setPendingCheckpoint(id: string, checkpoint: PendingSessionCheckpoint | undefined): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return Promise.resolve();
    job.pendingCheckpoint = checkpoint;
    job.updatedAt = new Date().toISOString();
    return this.schedulePersist();
  }

  getPendingCheckpoint(id: string): PendingSessionCheckpoint | undefined {
    return this.jobs.get(id)?.pendingCheckpoint;
  }

  /**
   * Append or update a mutation ledger entry. Used by AgentProductRuntime to
   * track the mutation status of each potentially-mutating tool call. Persisted
   * on every update so a restart can distinguish committed/rolled-back from
   * started-unknown mutations instead of auto-retrying uncertain ones.
   */
  recordMutation(jobId: string, entry: MutationLedgerEntry): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (!job.mutationLedger) job.mutationLedger = [];
    const existing = job.mutationLedger.findIndex((item) => item.callId === entry.callId);
    if (existing >= 0) {
      job.mutationLedger[existing] = entry;
    } else {
      job.mutationLedger.push(entry);
    }
    job.updatedAt = new Date().toISOString();
    void this.schedulePersist();
  }

  getMutationLedger(id: string): readonly MutationLedgerEntry[] {
    return this.jobs.get(id)?.mutationLedger ?? [];
  }

  /**
   * Find persisted jobs whose pending session was paused (waiting for a decision)
   * or whose mutations are still uncertain. Used by AgentProductRuntime to rebuild
   * a resume queue after restart.
   */
  listRestorablePausedJobs(): readonly StandaloneJobSnapshot[] {
    return this.list().filter((job) => {
      if (job.status === 'waiting-decision') return true;
      if (job.mutationLedger?.some((entry) =>
        (entry.mutationStatus === 'started' || entry.mutationStatus === 'unknown') && !entry.resolvedAt
      )) {
        return true;
      }
      return false;
    });
  }

  create(input: StandaloneJobInput): StandaloneJobSnapshot {
    // Chat is a single inference that reads no files, so it needs no folder.
    // Only the engineering pipeline does.
    if ((input.interactionMode ?? 'cowork') !== 'chat' && !input.workspace.trim()) {
      throw new Error('workspace is required.');
    }
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
      turns: [{
        id: randomUUID(),
        role: 'user',
        content: input.goal.trim(),
        createdAt: now
      }],
      activityHistory: [],
      rounds: 0,
      events: [],
      controller: new AbortController()
    };
    this.jobs.set(job.id, job);
    this.emit(job, 'status', input.interactionMode === 'chat' ? 'Chat queued' : 'Job queued');
    void this.run(job);
    return snapshot(job);
  }

  /**
   * A conversation's displayed name. Stored separately from the goal so the
   * prompt that started it is never rewritten.
   */
  async rename(id: string, title: string): Promise<StandaloneJobSnapshot> {
    const job = this.requireJob(id);
    const clean = title.trim();
    if (!clean) throw new Error('title is required.');
    job.title = clean;
    job.updatedAt = new Date().toISOString();
    this.emit(job, 'status', 'Renamed');
    await this.persistTail;
    return snapshot(job);
  }

  /** Archiving only hides a conversation; nothing is discarded. */
  async setArchived(id: string, archived: boolean): Promise<StandaloneJobSnapshot> {
    const job = this.requireJob(id);
    job.archivedAt = archived ? new Date().toISOString() : undefined;
    job.updatedAt = new Date().toISOString();
    this.emit(job, 'status', archived ? 'Archived' : 'Restored');
    await this.persistTail;
    return snapshot(job);
  }

  /** Stops a running job first: deleting one mid-flight would leak the run. */
  async remove(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'running' || job.status === 'queued') {
      job.controller?.abort();
      job.waiting?.resolve('');
    }
    if (job.worktree) {
      await this.worktrees.cleanup(job.worktree, new AbortController().signal);
    }
    this.jobs.delete(id);
    this.schedulePersist();
    await this.persistTail;
    return true;
  }

  async followUp(
    id: string,
    message: string,
    overrides: ChatTurnOverrides = {}
  ): Promise<StandaloneJobSnapshot> {
    const job = this.requireJob(id);
    this.assertChatCanRun(job);
    const content = message.trim();
    if (!content) throw new Error('message is required.');

    if (overrides.modelSelection !== undefined) job.input.modelSelection = overrides.modelSelection;
    if (overrides.reasoningEffort !== undefined) job.input.reasoningEffort = overrides.reasoningEffort;

    job.turns = boundTurns([
      ...job.turns,
      {
        id: randomUUID(),
        role: 'user',
        content,
        createdAt: new Date().toISOString()
      }
    ]);
    this.restartChat(job, 'Chat follow-up queued');
    return snapshot(job);
  }

  /**
   * Replays a prior user turn inside the same conversation. Editing replaces
   * that turn; resend keeps its text. In both cases later turns are discarded,
   * matching a linear Claude-style retry rather than inventing hidden branches.
   */
  async retryTurn(
    id: string,
    turnId: string,
    message?: string,
    overrides: ChatTurnOverrides = {}
  ): Promise<StandaloneJobSnapshot> {
    const job = this.requireJob(id);
    this.assertChatCanRun(job);
    const index = job.turns.findIndex((turn) => turn.id === turnId);
    const turn = index >= 0 ? job.turns[index] : undefined;
    if (!turn || turn.role !== 'user') throw new Error('User turn not found.');

    const content = message === undefined ? turn.content : message.trim();
    if (!content) throw new Error('message is required.');
    const edited = content !== turn.content;
    if (overrides.modelSelection !== undefined) job.input.modelSelection = overrides.modelSelection;
    if (overrides.reasoningEffort !== undefined) job.input.reasoningEffort = overrides.reasoningEffort;
    job.turns = boundTurns([
      ...job.turns.slice(0, index),
      {
        ...turn,
        content,
        createdAt: new Date().toISOString()
      }
    ]);
    this.restartChat(job, edited ? 'Edited chat message queued' : 'Chat message queued again');
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
    job.activity = undefined;
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
    if (job.recoveryState?.kind === 'indeterminate-mutation') {
      throw new Error('Indeterminate mutations require an explicit recovery decision before the job can resume.');
    }
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

  resolveIndeterminateMutation(
    id: string,
    decision: 'retry-confirmed' | 'accept-committed' | 'cancel'
  ): StandaloneJobSnapshot {
    const job = this.requireJob(id);
    if (job.recoveryState?.kind !== 'indeterminate-mutation') {
      throw new Error('Job has no indeterminate mutation recovery pending.');
    }
    const now = new Date().toISOString();
    const affected = new Set(job.recoveryState.callIds);
    job.mutationLedger = (job.mutationLedger ?? []).map((entry) => affected.has(entry.callId)
      ? {
          ...entry,
          mutationStatus: decision === 'accept-committed' ? 'committed' : entry.mutationStatus,
          resolvedAt: now,
          resolvedBy: 'user',
          retryDecision: decision
        }
      : entry);
    job.recoveryState = undefined;
    if (decision === 'cancel') {
      job.status = 'cancelled';
      this.emit(job, 'cancelled', 'Job cancelled during indeterminate mutation recovery');
      return snapshot(job);
    }
    job.guidance = mergeGuidance(
      job.guidance,
      decision === 'accept-committed'
        ? 'The user confirmed the previously indeterminate mutation committed. Inspect current state and do not repeat it.'
        : 'The user explicitly confirmed retry after an indeterminate mutation. Inspect current state before making further changes.'
    );
    job.status = 'running';
    job.controller = new AbortController();
    this.emit(job, 'guidance', decision === 'accept-committed'
      ? 'User confirmed the indeterminate mutation committed'
      : 'User explicitly authorized recovery retry');
    void this.run(job);
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

  private assertChatCanRun(job: JobInternal): void {
    if (job.input.interactionMode !== 'chat') {
      throw new Error('Chat turn actions are available only for Chat conversations.');
    }
    if (['queued', 'running', 'waiting-decision', 'waiting-guidance'].includes(job.status)) {
      throw new Error(`Cannot run a chat turn while the chat status is ${job.status}.`);
    }
  }

  private restartChat(job: JobInternal, title: string): void {
    job.status = 'running';
    job.error = undefined;
    job.result = undefined;
    job.decisionRequest = undefined;
    job.escalationPlan = undefined;
    job.activity = undefined;
    job.activityHistory = [];
    job.archivedAt = undefined;
    job.rounds = 0;
    job.controller = new AbortController();
    this.emit(job, 'status', title);
    void this.run(job);
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
        .slice(0, PERSISTED_JOB_LIMIT)
        .map((publicJob) => {
          const internal = this.jobs.get(publicJob.id)!;
          return {
            ...publicJob,
            events: publicJob.archivedAt ? [] : publicJob.events,
            turns: boundTurns(publicJob.turns),
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

  private publishActivity(job: JobInternal, progress: Partial<EngineeringProgress>): void {
    const action = progress.action?.trim();
    if (!action) return;
    const now = Date.now();
    const previous = this.lastActivityPublish.get(job.id);
    const previousActivity = job.activity;
    job.activity = {
      action,
      detail: progress.detail?.trim() || undefined,
      reasoningSummary: progress.reasoningSummary?.trim() || undefined,
      activityKind: progress.activityKind ?? (
        progress.streamState === 'waiting-response' ? 'connecting'
          : progress.streamState === 'reasoning' ? 'thinking'
            : progress.streamState === 'generating' ? 'writing'
              : progress.phase === 'research' ? 'searching-web'
                : progress.phase === 'validation' || progress.phase === 'quality-gate' ? 'validating'
                  : progress.phase === 'implementation' ? 'tool'
                    : progress.phase === 'report' ? 'writing'
                      : progress.phase ? 'thinking' : 'working'
      ),
      streamState: progress.streamState,
      providerId: progress.providerId,
      model: progress.model,
      eventCount: progress.eventCount,
      outputChars: progress.outputChars,
      elapsedMs: progress.elapsedMs,
      updatedAt: new Date(now).toISOString()
    };
    const isStreamTelemetry = progress.streamState !== undefined;
    const isMeaningful = isStreamTelemetry
      ? previousActivity?.streamState !== job.activity.streamState
      : previousActivity?.action !== job.activity.action || previousActivity?.detail !== job.activity.detail;
    if (isMeaningful) {
      job.activityHistory = [...(job.activityHistory ?? []), job.activity].slice(-40);
      void this.schedulePersist();
    }
    if (previous?.action === action && now - previous.at < 350) return;
    this.lastActivityPublish.set(job.id, { action, at: now });
    const event: StandaloneJobEvent = {
      id: randomUUID(),
      jobId: job.id,
      type: 'status',
      timestamp: job.activity.updatedAt,
      title: action,
      data: { detail: job.activity.detail, reasoningSummary: job.activity.reasoningSummary }
    };
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
        await this.ensureCoworkWorktree(job, controller.signal);
        this.emit(job, 'status', isChat
          ? 'Direct chat started'
          : job.rounds > 0 ? 'Local agent resumed' : 'Local agent started');

        if (isChat) {
          const currentIndex = lastUserTurnIndex(job.turns);
          const currentTurn = currentIndex >= 0 ? job.turns[currentIndex] : undefined;
          if (!currentTurn) throw new Error('Chat has no user turn to answer.');

          job.rounds = 1;
          const input: ProjectEngineerInput = {
            ...job.input,
            managedWorktree: job.worktree,
            goal: currentTurn.content,
            userGuidance: job.guidance,
            budgetJobId: job.id,
            chatHistory: job.turns.slice(0, currentIndex).map((turn) => ({
              role: turn.role,
              content: turn.content
            }))
          };
          this.emit(job, 'status', 'Generating chat response');
          const result = await withProgressReporter(
            (progress) => this.publishActivity(job, progress),
            () => this.execution.executeEngineer(input),
            job.id
          );
          throwIfCancelled();
          job.result = result;

          if (result.status !== 'success') {
            throw new Error('Chat mode returned an engineering checkpoint instead of a direct response.');
          }

          job.turns = boundTurns([
            ...job.turns,
            {
              id: randomUUID(),
              role: 'assistant',
              content: result.summary.trim(),
              createdAt: new Date().toISOString()
            }
          ]);
          job.status = 'success';
          job.activity = undefined;
          job.escalationPlan = undefined;
          this.emit(job, 'result', 'Chat response completed', {
            changedFiles: result.changedFiles.length,
            quality: null
          });
          return;
        }

        for (let round = Math.max(1, job.rounds + 1); round <= 6; round += 1) {
          throwIfCancelled();
          job.rounds = round;
          const input: ProjectEngineerInput = {
            ...job.input,
            managedWorktree: job.worktree,
            userGuidance: job.guidance,
            budgetJobId: job.id
          };
          this.emit(job, 'status', `Agent round ${round} running`);
          const result = await withProgressReporter(
            (progress) => this.publishActivity(job, progress),
            () => this.execution.executeEngineer(input),
            job.id
          );
          throwIfCancelled();
          job.result = result;

          if (result.status === 'success') {
            job.status = 'success';
            job.activity = undefined;
            job.escalationPlan = undefined;
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
      job.activity = undefined;
      job.error = error instanceof Error ? error.message : String(error);
      this.emit(job, 'error', isChat ? 'Chat failed' : 'Local agent failed', { error: job.error });
    } finally {
      job.waiting = undefined;
      job.controller = undefined;
      void this.schedulePersist();
    }
  }

  private async ensureCoworkWorktree(job: JobInternal, signal: AbortSignal): Promise<void> {
    if (job.input.interactionMode === 'chat') return;
    if (!this.worktrees.enabled) return;
    const companyId = job.input.companyId?.trim();
    if (!companyId) {
      throw new Error('Cowork job is missing canonical Company ownership for managed worktree creation.');
    }
    const worktree = await this.worktrees.prepare({
      jobId: job.id,
      companyId,
      projectId: job.input.projectId,
      sourceWorkspace: job.worktree?.sourceWorkspace ?? job.input.workspace,
      existing: job.worktree,
      signal
    });
    if (!worktree) return;
    job.worktree = worktree;
    job.input.workspace = worktree.workspace;
    await this.schedulePersist();
  }
}
