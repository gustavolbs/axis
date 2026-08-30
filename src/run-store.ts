import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type RunKind = 'task' | 'plan';
export type RunView = 'summary' | 'diff' | 'validation' | 'full';

export interface StoredRun<T = unknown> {
  runId: string;
  kind: RunKind;
  createdAt: string;
  summary: Record<string, unknown>;
  result: T;
}

export interface RunChunk {
  runId: string;
  view: RunView;
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
  content: string;
}

function assertRunId(runId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('Invalid runId.');
}

function clampChars(value: number | undefined): number {
  return Math.max(1_000, Math.min(value ?? 12_000, 24_000));
}

export class RunStore {
  private readonly baseDirectory: string;

  constructor(baseDirectory?: string) {
    this.baseDirectory = baseDirectory ?? path.join(process.cwd(), '.local-coder-mcp', 'runs');
  }

  async save<T>(kind: RunKind, summary: Record<string, unknown>, result: T): Promise<string> {
    const runId = randomUUID();
    const directory = path.join(this.baseDirectory, runId);
    await fs.mkdir(directory, { recursive: true });

    const stored: StoredRun<T> = {
      runId,
      kind,
      createdAt: new Date().toISOString(),
      summary,
      result
    };

    await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify(stored, null, 2), 'utf8');

    const resultRecord = result as Record<string, unknown>;
    if (typeof resultRecord.diff === 'string') {
      await fs.writeFile(path.join(directory, 'diff.patch'), resultRecord.diff, 'utf8');
    }

    return runId;
  }

  async get(runId: string): Promise<StoredRun> {
    assertRunId(runId);
    const raw = await fs.readFile(path.join(this.baseDirectory, runId, 'run.json'), 'utf8');
    return JSON.parse(raw) as StoredRun;
  }

  async read(
    runId: string,
    view: RunView,
    options: { offset?: number; maxChars?: number } = {}
  ): Promise<RunChunk> {
    const stored = await this.get(runId);
    let payload: unknown;

    if (view === 'summary') {
      payload = {
        runId: stored.runId,
        kind: stored.kind,
        createdAt: stored.createdAt,
        ...stored.summary
      };
    } else if (view === 'diff') {
      payload = (stored.result as Record<string, unknown>).diff ?? '';
    } else if (view === 'validation') {
      const result = stored.result as Record<string, unknown>;
      payload = stored.kind === 'plan'
        ? {
            taskValidation: Array.isArray(result.taskResults)
              ? (result.taskResults as Array<Record<string, unknown>>).map((task) => ({
                  id: task.id,
                  validation: (task.execution as Record<string, unknown> | undefined)?.validation
                }))
              : [],
            finalValidation: result.finalValidation ?? []
          }
        : { validation: result.validation ?? [] };
    } else {
      payload = stored;
    }

    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    const maxChars = clampChars(options.maxChars);
    const offset = Math.max(0, options.offset ?? 0);
    const content = text.slice(offset, offset + maxChars);
    const nextOffset = offset + content.length < text.length ? offset + content.length : null;

    return {
      runId,
      view,
      offset,
      nextOffset,
      truncated: nextOffset !== null,
      content
    };
  }
}
