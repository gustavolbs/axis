import fs from 'node:fs/promises';
import path from 'node:path';

import type { EngineeringProgress } from './engineering-progress.js';
import type { WorkerJobKind } from './worker-scheduler.js';

export type WorkerHistoryRunStatus = 'running' | 'success' | 'error';
export type WorkerHistoryEventType =
  | 'job-start'
  | 'request'
  | 'progress'
  | 'model-input'
  | 'model-output'
  | 'error'
  | 'job-finish';

export interface WorkerHistoryRunSummary {
  id: string;
  kind: WorkerJobKind;
  isolationKey: string;
  status: WorkerHistoryRunStatus;
  startedAt: string;
  finishedAt?: string;
  goal?: string;
  repositoryUrl?: string;
  phase?: string;
  action?: string;
  error?: string;
}

export interface WorkerHistoryEvent {
  timestamp: string;
  type: WorkerHistoryEventType;
  title?: string;
  stage?: string;
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  output?: string;
  promptTruncated?: boolean;
  originalUserPromptChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  error?: string;
  progress?: EngineeringProgress;
  data?: Record<string, unknown>;
}

export interface WorkerHistoryRun {
  summary: WorkerHistoryRunSummary;
  events: WorkerHistoryEvent[];
}

const MAX_EVENT_TEXT = 262_144;
const SAFE_ID = /^[A-Za-z0-9-]{1,100}$/;

function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= MAX_EVENT_TEXT) return value;
  return `${value.slice(0, MAX_EVENT_TEXT)}\n\n[history field truncated at ${MAX_EVENT_TEXT} characters]`;
}

function cloneProgress(progress: EngineeringProgress): EngineeringProgress {
  return {
    ...progress,
    files: progress.files ? [...progress.files] : undefined,
    completedSteps: progress.completedSteps ? [...progress.completedSteps] : undefined
  };
}

export class WorkerHistoryStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly maxRuns = 200
  ) {}

  async startRun(input: {
    id: string;
    kind: WorkerJobKind;
    isolationKey: string;
    startedAt: string;
  }): Promise<void> {
    await this.enqueue(async () => {
      this.assertId(input.id);
      await fs.mkdir(this.root, { recursive: true });
      const summary: WorkerHistoryRunSummary = {
        id: input.id,
        kind: input.kind,
        isolationKey: input.isolationKey,
        status: 'running',
        startedAt: input.startedAt
      };
      await fs.writeFile(this.eventPath(input.id), '', 'utf8');
      await this.appendEventUnlocked(input.id, {
        timestamp: input.startedAt,
        type: 'job-start',
        title: `${input.kind} job started`
      });
      await this.upsertSummaryUnlocked(summary);
    });
  }

  async annotateRun(
    id: string,
    patch: Pick<WorkerHistoryRunSummary, 'goal' | 'repositoryUrl'>
  ): Promise<void> {
    await this.enqueue(async () => {
      const summary = await this.findSummaryUnlocked(id);
      if (!summary) return;
      await this.upsertSummaryUnlocked({
        ...summary,
        goal: bounded(patch.goal),
        repositoryUrl: bounded(patch.repositoryUrl)
      });
    });
  }

  async recordProgress(id: string, progress: EngineeringProgress): Promise<void> {
    await this.enqueue(async () => {
      const summary = await this.findSummaryUnlocked(id);
      if (!summary) return;
      const cloned = cloneProgress(progress);
      await this.appendEventUnlocked(id, {
        timestamp: progress.updatedAt ?? new Date().toISOString(),
        type: 'progress',
        title: progress.action ?? progress.phase ?? 'Worker progress',
        progress: cloned
      });
      await this.upsertSummaryUnlocked({
        ...summary,
        phase: progress.phase ?? summary.phase,
        action: bounded(progress.action) ?? summary.action
      });
    });
  }

  async appendEvent(
    id: string,
    event: Omit<WorkerHistoryEvent, 'timestamp'> & { timestamp?: string }
  ): Promise<void> {
    await this.enqueue(async () => {
      const summary = await this.findSummaryUnlocked(id);
      if (!summary) return;
      await this.appendEventUnlocked(id, {
        ...event,
        timestamp: event.timestamp ?? new Date().toISOString(),
        title: bounded(event.title),
        systemPrompt: bounded(event.systemPrompt),
        userPrompt: bounded(event.userPrompt),
        output: bounded(event.output),
        error: bounded(event.error)
      });
    });
  }

  async finishRun(id: string, status: 'success' | 'error', error?: string): Promise<void> {
    await this.enqueue(async () => {
      const summary = await this.findSummaryUnlocked(id);
      if (!summary) return;
      const finishedAt = new Date().toISOString();
      await this.appendEventUnlocked(id, {
        timestamp: finishedAt,
        type: 'job-finish',
        title: status === 'success' ? 'Worker job completed' : 'Worker job failed',
        error: bounded(error)
      });
      await this.upsertSummaryUnlocked({
        ...summary,
        status,
        finishedAt,
        error: bounded(error)
      });
    });
  }

  async listRuns(limit = 50): Promise<WorkerHistoryRunSummary[]> {
    await this.tail;
    const summaries = await this.readIndexUnlocked();
    return summaries.slice(0, Math.max(1, Math.min(limit, this.maxRuns)));
  }

  async readRun(id: string): Promise<WorkerHistoryRun | null> {
    this.assertId(id);
    await this.tail;
    const summary = await this.findSummaryUnlocked(id);
    if (!summary) return null;
    let raw = '';
    try {
      raw = await fs.readFile(this.eventPath(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const events = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as WorkerHistoryEvent];
        } catch {
          return [];
        }
      });
    return { summary, events };
  }

  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async appendEventUnlocked(id: string, event: WorkerHistoryEvent): Promise<void> {
    this.assertId(id);
    await fs.mkdir(this.root, { recursive: true });
    await fs.appendFile(this.eventPath(id), `${JSON.stringify(event)}\n`, 'utf8');
  }

  private async findSummaryUnlocked(id: string): Promise<WorkerHistoryRunSummary | undefined> {
    this.assertId(id);
    return (await this.readIndexUnlocked()).find((item) => item.id === id);
  }

  private async upsertSummaryUnlocked(summary: WorkerHistoryRunSummary): Promise<void> {
    const index = await this.readIndexUnlocked();
    const next = [summary, ...index.filter((item) => item.id !== summary.id)]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, this.maxRuns);
    await this.writeIndexUnlocked(next);
  }

  private async readIndexUnlocked(): Promise<WorkerHistoryRunSummary[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath(), 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as WorkerHistoryRunSummary[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async writeIndexUnlocked(index: WorkerHistoryRunSummary[]): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const temporary = `${this.indexPath()}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(index, null, 2), 'utf8');
    await fs.rename(temporary, this.indexPath());
  }

  private indexPath(): string {
    return path.join(this.root, 'index.json');
  }

  private eventPath(id: string): string {
    return path.join(this.root, `${id}.jsonl`);
  }

  private assertId(id: string): void {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid worker history id: ${id}`);
  }
}
