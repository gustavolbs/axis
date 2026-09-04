import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

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
  | 'terminated'
  | 'orphaned';

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
  readonly stdinOpen: boolean;
  readonly error?: string;
  readonly terminalMode: 'pipes' | 'pty';
  readonly columns?: number;
  readonly rows?: number;
  readonly restartState?: 'live' | 'orphaned-indeterminate';
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
  readonly terminal?: { readonly columns: number; readonly rows: number; readonly name?: string };
}

export interface ManagedProcessRegistryOptions {
  readonly outputLimitBytes?: number;
  readonly killGraceMs?: number;
  /** Durable metadata journal. Live processes restore as indeterminate orphans, never as reattached handles. */
  readonly stateFile?: string;
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

  persist(): { readonly totalBytes: number; readonly retainedBase64: string } {
    return {
      totalBytes: this.totalBytes,
      retainedBase64: Buffer.concat(this.chunks.map((chunk) => chunk.data)).toString('base64')
    };
  }

  restore(value: { readonly totalBytes: number; readonly retainedBase64: string }): void {
    const data = Buffer.from(value.retainedBase64, 'base64');
    const retained = data.byteLength > this.limitBytes ? data.subarray(data.byteLength - this.limitBytes) : data;
    this.totalBytes = Math.max(value.totalBytes, retained.byteLength);
    this.retainedBytes = retained.byteLength;
    this.chunks.length = 0;
    if (retained.byteLength > 0) {
      const start = this.totalBytes - retained.byteLength;
      this.chunks.push({ start, end: this.totalBytes, data: retained });
    }
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
  readonly child?: ChildProcess;
  readonly terminal?: IPty;
  readonly terminalMode: 'pipes' | 'pty';
  readonly pid: number;
  readonly completion: Promise<void>;
  resolveCompletion: () => void;
  status: ManagedProcessStatus;
  completedAt?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  terminationRequested: boolean;
  stdinClosed: boolean;
  columns?: number;
  rows?: number;
}

const DEFAULT_OUTPUT_LIMIT_BYTES = 2_000_000;
const DEFAULT_KILL_GRACE_MS = 250;
const MAX_STDIN_CHUNK_BYTES = 64 * 1024;

interface PersistedManagedProcessRecord {
  readonly processId: string;
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly rootId: string;
  readonly executionTargetId: string;
  readonly mutation: ProcessMutationIntent;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly pid: number;
  readonly status: ManagedProcessStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
  readonly terminalMode: 'pipes' | 'pty';
  readonly columns?: number;
  readonly rows?: number;
  readonly stdout: { readonly totalBytes: number; readonly retainedBase64: string };
  readonly stderr: { readonly totalBytes: number; readonly retainedBase64: string };
}

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

async function waitForCompletion(completion: Promise<void>, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new OperationCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void completion.then(finish, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
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
  private readonly stateFile?: string;

  constructor(options: ManagedProcessRegistryOptions = {}) {
    this.outputLimitBytes = Math.max(1, options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES);
    this.killGraceMs = Math.max(0, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    this.stateFile = options.stateFile ? path.resolve(options.stateFile) : undefined;
    this.restorePersistedRecords();
  }

  async start(request: ManagedProcessStartRequest): Promise<ManagedProcessSnapshot> {
    throwIfCancelled(request.signal);
    const invocation = resolveSpawnInvocation(request.command, [...request.args]);
    let resolveCompletion = () => {};
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    let child: ChildProcess | undefined;
    let terminal: IPty | undefined;
    if (request.terminal) {
      terminal = pty.spawn(invocation.command, invocation.args, {
        cwd: request.cwdPath,
        env: Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        cols: request.terminal.columns,
        rows: request.terminal.rows,
        name: request.terminal.name ?? 'xterm-256color'
      });
    } else {
      child = spawn(invocation.command, invocation.args, {
        cwd: request.cwdPath,
        shell: false,
        env: request.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    }
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
      terminal,
      terminalMode: terminal ? 'pty' : 'pipes',
      pid: terminal?.pid ?? child?.pid ?? 0,
      completion,
      resolveCompletion,
      status: 'starting',
      exitCode: null,
      signal: null,
      terminationRequested: false,
      stdinClosed: false,
      columns: request.terminal?.columns,
      rows: request.terminal?.rows
    };
    this.records.set(record.processId, record);
    this.persistRecords();

    if (terminal) {
      terminal.onData((data) => {
        record.stdout.append(data);
        this.persistRecords();
      });
      terminal.onExit(({ exitCode }) => {
        record.exitCode = exitCode;
        record.status = record.terminationRequested ? 'terminated' : 'exited';
        record.completedAt = new Date().toISOString();
        record.stdinClosed = true;
        this.persistRecords();
        record.resolveCompletion();
      });
      record.status = 'running';
      this.persistRecords();
      if (request.signal.aborted) {
        record.terminationRequested = true;
        record.status = 'terminating';
        terminal.kill();
        throw new OperationCancelledError(`PTY start cancelled: ${request.command}`);
      }
      return this.snapshot(record, {});
    }

    const spawned = child!;
    spawned.stdout?.on('data', (chunk: Buffer | string) => {
      record.stdout.append(chunk);
      this.persistRecords();
    });
    spawned.stderr?.on('data', (chunk: Buffer | string) => {
      record.stderr.append(chunk);
      this.persistRecords();
    });
    spawned.once('error', (error) => {
      record.status = record.terminationRequested ? 'terminated' : 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = new Date().toISOString();
      record.stdinClosed = true;
      this.persistRecords();
      record.resolveCompletion();
    });
    spawned.once('close', (exitCode, signal) => {
      if (record.status === 'failed') return;
      record.exitCode = exitCode;
      record.signal = signal;
      record.status = record.terminationRequested ? 'terminated' : 'exited';
      record.completedAt = new Date().toISOString();
      record.stdinClosed = true;
      this.persistRecords();
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
        this.persistRecords();
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
        void terminateProcessTree(spawned, this.killGraceMs).finally(() =>
          fail(new OperationCancelledError(`Background process start cancelled: ${request.command}`))
        );
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      spawned.once('spawn', succeed);
      spawned.once('error', fail);
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
    if (record.status === 'starting' || record.status === 'running' || record.status === 'terminating') {
      await waitForCompletion(record.completion, signal);
    } else {
      throwIfCancelled(signal);
    }
    return this.snapshot(record, cursor);
  }

  async writeStdin(
    session: AgentSessionContext,
    processId: string,
    data: string,
    end = false,
    cursor: ManagedProcessCursor = {}
  ): Promise<ManagedProcessSnapshot> {
    const record = this.requireOwned(session, processId);
    if (record.status !== 'running') {
      throw new Error(`Process ${processId} is ${record.status}; stdin is available only while running.`);
    }
    if (record.stdinClosed || (!record.terminal && (!record.child?.stdin || record.child.stdin.destroyed))) {
      throw new Error(`Process ${processId} stdin is already closed.`);
    }
    if (Buffer.byteLength(data, 'utf8') > MAX_STDIN_CHUNK_BYTES) {
      throw new Error(`Process stdin chunk exceeds ${MAX_STDIN_CHUNK_BYTES} bytes.`);
    }

    if (record.terminal) {
      record.terminal.write(data);
      if (end) {
        record.stdinClosed = true;
        record.terminal.write(process.platform === 'win32' ? '\x1a' : '\x04');
      }
      this.persistRecords();
      return this.snapshot(record, cursor);
    }

    await new Promise<void>((resolve, reject) => {
      const stdin = record.child?.stdin;
      if (!stdin) {
        reject(new Error(`Process ${processId} has no writable stdin.`));
        return;
      }
      const afterWrite = (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        if (!end) {
          resolve();
          return;
        }
        record.stdinClosed = true;
        this.persistRecords();
        stdin.end(resolve);
      };
      if (data) stdin.write(data, 'utf8', afterWrite);
      else afterWrite();
    });

    return this.snapshot(record, cursor);
  }

  sendSignal(
    session: AgentSessionContext,
    processId: string,
    signal: NodeJS.Signals,
    cursor: ManagedProcessCursor = {}
  ): ManagedProcessSnapshot {
    const record = this.requireOwned(session, processId);
    if (record.status !== 'running') {
      throw new Error(`Process ${processId} is ${record.status}; signals require a running process.`);
    }
    const pid = record.pid;
    if (!pid) throw new Error(`Process ${processId} has no operating-system pid.`);

    let sent = false;
    try {
      if (record.terminal) {
        record.terminal.kill(signal);
        sent = true;
      } else if (process.platform === 'win32') sent = record.child!.kill(signal);
      else {
        process.kill(-pid, signal);
        sent = true;
      }
    } catch (error) {
      throw new Error(
        `Could not send ${signal} to process ${processId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!sent) throw new Error(`Could not send ${signal} to process ${processId}.`);
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
      record.stdinClosed = true;
      this.persistRecords();
      if (record.terminal) record.terminal.kill();
      else await terminateProcessTree(record.child!, this.killGraceMs);
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
      record.stdinClosed = true;
      this.persistRecords();
      if (record.terminal) record.terminal.kill();
      else await terminateProcessTree(record.child!, this.killGraceMs);
      await Promise.race([record.completion, delay(this.killGraceMs + 1_000)]);
    }));
    return owned.length;
  }

  removeCompleted(session: AgentSessionContext, processId: string): boolean {
    const record = this.requireOwned(session, processId);
    if (record.status === 'starting' || record.status === 'running' || record.status === 'terminating') {
      throw new Error(`Process ${processId} is still running and cannot be removed.`);
    }
    const removed = this.records.delete(processId);
    if (removed) this.persistRecords();
    return removed;
  }

  resize(
    session: AgentSessionContext,
    processId: string,
    columns: number,
    rows: number,
    cursor: ManagedProcessCursor = {}
  ): ManagedProcessSnapshot {
    const record = this.requireOwned(session, processId);
    if (!record.terminal) throw new Error(`Process ${processId} is not a PTY terminal.`);
    if (record.status !== 'running') throw new Error(`PTY ${processId} is ${record.status}; resize requires a running terminal.`);
    if (!Number.isInteger(columns) || columns < 20 || columns > 500 || !Number.isInteger(rows) || rows < 5 || rows > 300) {
      throw new Error('PTY dimensions must be columns 20..500 and rows 5..300.');
    }
    record.terminal.resize(columns, rows);
    record.columns = columns;
    record.rows = rows;
    this.persistRecords();
    return this.snapshot(record, cursor);
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
      pid: record.pid,
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
      stdinOpen: !record.stdinClosed && (Boolean(record.terminal) || (Boolean(record.child?.stdin) && !record.child?.stdin?.destroyed)),
      error: record.error,
      terminalMode: record.terminalMode,
      columns: record.columns,
      rows: record.rows,
      restartState: record.status === 'orphaned' ? 'orphaned-indeterminate' : 'live',
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

  private restorePersistedRecords(): void {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { records?: PersistedManagedProcessRecord[] };
    if (!Array.isArray(parsed.records)) throw new Error(`Invalid managed-process journal: ${this.stateFile}`);
    for (const item of parsed.records) {
      if (!item || typeof item.processId !== 'string' || typeof item.ownerKey !== 'string') {
        throw new Error(`Invalid managed-process record in ${this.stateFile}`);
      }
      let resolveCompletion = () => {};
      const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
      const wasLive = item.status === 'starting' || item.status === 'running' || item.status === 'terminating';
      const stdout = new BoundedOutputLog(this.outputLimitBytes);
      const stderr = new BoundedOutputLog(this.outputLimitBytes);
      stdout.restore(item.stdout);
      stderr.restore(item.stderr);
      const record: ManagedProcessRecord = {
        processId: item.processId,
        ownerKey: item.ownerKey,
        sessionId: item.sessionId,
        command: item.command,
        cwd: item.cwd,
        rootId: item.rootId,
        executionTargetId: item.executionTargetId,
        mutation: item.mutation,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        stdout,
        stderr,
        pid: item.pid,
        completion,
        resolveCompletion,
        status: wasLive ? 'orphaned' : item.status,
        exitCode: item.exitCode,
        signal: item.signal,
        error: wasLive
          ? 'Axis restarted while this process was live; attachment and mutation outcome are indeterminate.'
          : item.error,
        terminationRequested: false,
        stdinClosed: true,
        terminalMode: item.terminalMode,
        columns: item.columns,
        rows: item.rows
      };
      resolveCompletion();
      this.records.set(record.processId, record);
    }
    this.persistRecords();
  }

  private persistRecords(): void {
    if (!this.stateFile) return;
    const records: PersistedManagedProcessRecord[] = [...this.records.values()].map((record) => ({
      processId: record.processId,
      ownerKey: record.ownerKey,
      sessionId: record.sessionId,
      command: record.command,
      cwd: record.cwd,
      rootId: record.rootId,
      executionTargetId: record.executionTargetId,
      mutation: record.mutation,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      pid: record.pid,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      error: record.error,
      terminalMode: record.terminalMode,
      columns: record.columns,
      rows: record.rows,
      stdout: record.stdout.persist(),
      stderr: record.stderr.persist()
    }));
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, records })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
  }
}
