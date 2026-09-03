import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

import { OperationCancelledError, throwIfCancelled } from '../../cancellation.js';
import type { AgentSessionContext } from '../../agent-runtime/index.js';
import { resolveSpawnInvocation } from '../../platform-command.js';
import type { ProcessMutationIntent } from './policy.js';
import { terminateProcessTree } from './runner.js';

export type ManagedProcessStatus =
  | 'starting'
  | 'running'
  | 'exited'
  | 'failed'
  | 'terminating'
  | 'terminated';

export interface ManagedProcessCursor {
  readonly stdoutOffset?: number;
  readonly stderrOffset?: number;
}

export interface ManagedProcessOutputSlice {
  readonly stdout: string;
  readonly stderr: string;
  readonly nextStdoutOffset: number;
  readonly nextStderrOffset: number;
  readonly stdoutTruncatedBeforeCursor: boolean;
  readonly stderrTruncatedBeforeCursor: boolean;
  readonly stdoutRetainedFromOffset: number;
  readonly stderrRetainedFromOffset: number;
}

export interface ManagedProcessSnapshot extends ManagedProcessOutputSlice {
  readonly processId: string;
  readonly pid: number;
  readonly status: ManagedProcessStatus;
  readonly command: string;
  readonly cwd: string;
  readonly rootId: string;
  readonly executionTargetId: string;
  readonly mutation: ProcessMutationIntent;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

export interface ManagedProcessStartRequest {
  readonly session: AgentSessionContext;
  readonly command: string;
  readonly args: readonly string[];
  readonly displayCommand: string;
  readonly cwdPath: string;
  readonly cwd: string;
  readonly rootId: string;
  readonly mutation: ProcessMutationIntent;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}

export interface ManagedProcessRegistryOptions {
  readonly outputLimitBytes?: number;
  readonly killGraceMs?: number;
}

interface OutputChunk {
  readonly start: number;
  readonly end: number;
  readonly data: Buffer;
}

class BoundedOutputLog {
  private readonly chunks: OutputChunk[] = [];
  private totalBytes = 0;
  private retainedBytes = 0;

  constructor(private readonly limitBytes: number) {}

  append(raw: Buffer | string): void {
    const input = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const absoluteStart = this.totalBytes;
    this.totalBytes += input.byteLength;
    if (input.byteLength === 0) return;

    let data = input;
    let start = absoluteStart;
    if (data.byteLength > this.limitBytes) {
      data = data.subarray(data.byteLength - this.limitBytes);
      start = this.totalBytes - data.byteLength;
      this.chunks.length = 0;
      this.retainedBytes = 0;
    }

    this.chunks.push({ start, end: start + data.byteLength, data });
    this.retainedBytes += data.byteLength;

    while (this.retainedBytes > this.limitBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed) this.retainedBytes -= removed.data.byteLength;
    }
  }

  read(requestedOffset = 0): {
    text: string;
    nextOffset: number;
    retainedFromOffset: number;
    truncatedBeforeCursor: boolean;
  } {
    const retainedFromOffset = this.chunks[0]?.start ?? this.totalBytes;
    const offset = Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0);
    const truncatedBeforeCursor = offset < retainedFromOffset;
    const effectiveOffset = Math.max(offset, retainedFromOffset);
    const buffers: Buffer[] = [];

    for (const chunk of this.chunks) {
      if (chunk.end <= effectiveOffset) continue;
      if (chunk.start >= effectiveOffset) buffers.push(chunk.data);
      else buffers.push(chunk.data.subarray(effectiveOffset - chunk.start));
    }

    return {
      text: Buffer.concat(buffers).toString('utf8'),
      nextOffset: this.totalBytes,
      retainedFromOffset,
      truncatedBeforeCursor
    };
  }
}

interface ManagedProcessRecord {
  readonly processId: string;
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly rootId: string;
  readonly executionTargetId: string;
  readonly mutation: ProcessMutationIntent;
  readonly startedAt: string;
  readonly stdout: BoundedOutputLog;
  readonly stderr: BoundedOutputLog;
  readonly child: ChildProcess;
  readonly completion: Promise<void>;
  resolveCompletion: () => void;
  status: ManagedProcessStatus;
  completedAt?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  terminationRequested: boolean;
}

const DEFAULT_OUTPUT_LIMIT_BYTES = 2_000_000;
const DEFAULT_KILL_GRACE_MS = 250;

function sessionOwnerKey(session: AgentSessionContext): string {
  return [
    session.sessionId,
    session.companyId,
    session.project?.id ?? '',
    session.connection.id,
    session.modelId,
    session.executionTarget.id
  ].join('\u0000');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cancellationPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new OperationCancelledError());
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new OperationCancelledError()),
      { once: true }
    );
  });
}

/**
 * Owns processes that intentionally outlive a single tool call. Records are
 * session-bound and can never be controlled through another session, Company,
 * connection, model, or execution target even when a process id leaks.
 *
 * Session/run integration should call terminateSession() when a session is
 * cancelled, discarded, or cannot be restored with live-process ownership.
 */
export class ManagedProcessRegistry {
  private readonly records = new Map<string, ManagedProcessRecord>();
  private readonly outputLimitBytes: number;
  private readonly killGraceMs: number;

  constructor(options: ManagedProcessRegistryOptions = {}) {
    this.outputLimitBytes = Math.max(1, options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES);
    this.killGraceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  }

  async start(request: ManagedProcessStartRequest): Promise<ManagedProcessSnapshot> {
    throwIfCancelled(request.signal);
    const invocation = resolveSpawnInvocation(request.command, [...request.args]);
    const child = spawn(invocation.command, invocation.args, {
      cwd: request.cwdPath,
      shell: false,
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    });

    let resolveCompletion = () => {};
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const record: ManagedProcessRecord = {
      processId: randomUUID(),
      ownerKey: sessionOwnerKey(request.session),
      sessionId: request.session.sessionId,
      command: request.displayCommand,
      cwd: request.cwd,
      rootId: request.rootId,
      executionTargetId: request.session.executionTarget.id,
      mutation: request.mutation,
      startedAt: new Date().toISOString(),
      stdout: new BoundedOutputLog(this.outputLimitBytes),
      stderr: new BoundedOutputLog(this.outputLimitBytes),
      child,
      completion,
      resolveCompletion,
      status: 'starting',
      exitCode: null,
      signal: null,
      terminationRequested: false
    };
    this.records.set(record.processId, record);

    child.stdout?.on('data', (chunk: Buffer | string) => record.stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => record.stderr.append(chunk));
    child.once('error', (error) => {
      record.status = record.terminationRequested ? 'terminated' : 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = new Date().toISOString();
      record.resolveCompletion();
    });
    child.once('close', (exitCode, signal) => {
      record.exitCode = exitCode;
      record.signal = signal;
      record.status = record.terminationRequested ? 'terminated' : 'exited';
      record.completedAt = new Date().toISOString();
      record.resolveCompletion();
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => request.signal.removeEventListener('abort', onAbort);
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        record.status = 'running';
        resolve();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        if (settled) return;
        record.terminationRequested = true;
        record.status = 'terminating';
        void terminateProcessTree(child, this.killGraceMs).finally(() =>
          fail(new OperationCancelledError(`Background process start cancelled: ${request.command}`))
        );
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      child.once('spawn', succeed);
      child.once('error', fail);
      if (request.signal.aborted) onAbort();
    });

    return this.snapshot(record, {});
  }

  snapshotFor(
    session: AgentSessionContext,
    processId: string,
    cursor: ManagedProcessCursor = {}
  ): ManagedProcessSnapshot {
    return this.snapshot(this.requireOwned(session, processId), cursor);
  }

  list(session: AgentSessionContext): ManagedProcessSnapshot[] {
    const ownerKey = sessionOwnerKey(session);
    return [...this.records.values()]
      .filter((record) => record.ownerKey === ownerKey)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((record) => this.snapshot(record, {
        stdoutOffset: record.stdout.read().nextOffset,
        stderrOffset: record.stderr.read().nextOffset
      }));
  }

  async wait(
    session: AgentSessionContext,
    processId: string,
    signal: AbortSignal,
    cursor: ManagedProcessCursor = {}
  ): Promise<ManagedProcessSnapshot> {
    const record = this.requireOwned(session, processId);
    throwIfCancelled(signal);
    if (record.status === 'starting' || record.status === 'running' || record.status === 'terminating') {
      await Promise.race([record.completion, cancellationPromise(signal)]);
    }
    return this.snapshot(record, cursor);
  }

  async terminate(
    session: AgentSessionContext,
    processId: string,
    cursor: ManagedProcessCursor = {}
  ): Promise<ManagedProcessSnapshot> {
    const record = this.requireOwned(session, processId);
    if (record.status === 'starting' || record.status === 'running') {
      record.terminationRequested = true;
      record.status = 'terminating';
      await terminateProcessTree(record.child, this.killGraceMs);
      await Promise.race([record.completion, delay(this.killGraceMs + 1_000)]);
    }
    return this.snapshot(record, cursor);
  }

  async terminateSession(sessionId: string): Promise<number> {
    const owned = [...this.records.values()].filter((record) =>
      record.sessionId === sessionId && (record.status === 'starting' || record.status === 'running')
    );
    await Promise.all(owned.map(async (record) => {
      record.terminationRequested = true;
      record.status = 'terminating';
      await terminateProcessTree(record.child, this.killGraceMs);
      await Promise.race([record.completion, delay(this.killGraceMs + 1_000)]);
    }));
    return owned.length;
  }

  removeCompleted(session: AgentSessionContext, processId: string): boolean {
    const record = this.requireOwned(session, processId);
    if (record.status === 'starting' || record.status === 'running' || record.status === 'terminating') {
      throw new Error(`Process ${processId} is still running and cannot be removed.`);
    }
    return this.records.delete(processId);
  }

  private requireOwned(session: AgentSessionContext, processId: string): ManagedProcessRecord {
    const record = this.records.get(processId);
    if (!record || record.ownerKey !== sessionOwnerKey(session)) {
      throw new Error(`Process ${processId} is not owned by this immutable Axis session.`);
    }
    return record;
  }

  private snapshot(record: ManagedProcessRecord, cursor: ManagedProcessCursor): ManagedProcessSnapshot {
    const stdout = record.stdout.read(cursor.stdoutOffset);
    const stderr = record.stderr.read(cursor.stderrOffset);
    return {
      processId: record.processId,
      pid: record.child.pid ?? 0,
      status: record.status,
      command: record.command,
      cwd: record.cwd,
      rootId: record.rootId,
      executionTargetId: record.executionTargetId,
      mutation: record.mutation,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      error: record.error,
      stdout: stdout.text,
      stderr: stderr.text,
      nextStdoutOffset: stdout.nextOffset,
      nextStderrOffset: stderr.nextOffset,
      stdoutTruncatedBeforeCursor: stdout.truncatedBeforeCursor,
      stderrTruncatedBeforeCursor: stderr.truncatedBeforeCursor,
      stdoutRetainedFromOffset: stdout.retainedFromOffset,
      stderrRetainedFromOffset: stderr.retainedFromOffset
    };
  }
}
