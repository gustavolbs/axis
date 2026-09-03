import { spawn, type ChildProcess } from 'node:child_process';

import { OperationCancelledError, throwIfCancelled } from '../../cancellation.js';
import { resolveSpawnInvocation } from '../../platform-command.js';

export type ProcessOutputStream = 'stdout' | 'stderr';

export interface ProcessOutputEvent {
  readonly stream: ProcessOutputStream;
  readonly chunk: string;
}

export interface ProcessRunRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly outputLimitBytes?: number;
  readonly killGraceMs?: number;
  readonly onOutput?: (event: ProcessOutputEvent) => void;
}

export interface ProcessRunResult {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

interface OutputCapture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

const DEFAULT_OUTPUT_LIMIT_BYTES = 1_000_000;
const DEFAULT_KILL_GRACE_MS = 150;

function appendOutput(capture: OutputCapture, chunk: Buffer, limit: number): void {
  if (capture.bytes >= limit) {
    capture.truncated = true;
    return;
  }
  const remaining = limit - capture.bytes;
  if (chunk.length <= remaining) {
    capture.chunks.push(chunk);
    capture.bytes += chunk.length;
    return;
  }
  capture.chunks.push(chunk.subarray(0, remaining));
  capture.bytes += remaining;
  capture.truncated = true;
}

function capturedText(capture: OutputCapture): string {
  return Buffer.concat(capture.chunks, capture.bytes).toString('utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return false;
  }
}

async function taskkillTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    killer.once('error', finish);
    killer.once('close', finish);
    setTimeout(finish, 1_000).unref();
  });
}

/**
 * Terminates the process and descendants, not only the direct child. POSIX
 * children are placed in their own process group; Windows uses taskkill /T.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  graceMs = DEFAULT_KILL_GRACE_MS
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    await taskkillTree(pid);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return;
  }

  const signalled = signalProcessGroup(pid, 'SIGTERM');
  if (!signalled) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    return;
  }

  await delay(Math.max(0, graceMs));
  signalProcessGroup(pid, 'SIGKILL');
}

/**
 * Low-level reusable process primitive. It never invokes a shell, preserves
 * stdout/stderr separately, streams bounded progress, and turns AbortSignal into
 * process-tree termination plus the cancellation error understood by AgentRuntime.
 */
export async function runProcess(request: ProcessRunRequest): Promise<ProcessRunResult> {
  throwIfCancelled(request.signal);
  const outputLimitBytes = Math.max(1, request.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES);
  const killGraceMs = Math.max(0, request.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  const invocation = resolveSpawnInvocation(request.command, [...request.args]);
  const startedAt = Date.now();

  return await new Promise<ProcessRunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: request.cwd,
        shell: false,
        env: request.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout: OutputCapture = { chunks: [], bytes: 0, truncated: false };
    const stderr: OutputCapture = { chunks: [], bytes: 0, truncated: false };
    let settled = false;
    let aborting = false;

    const cleanup = () => request.signal.removeEventListener('abort', onAbort);
    const finish = (value: ProcessRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      if (settled || aborting) return;
      aborting = true;
      void terminateProcessTree(child, killGraceMs).then(
        () => fail(new OperationCancelledError(`Process cancelled: ${request.command}`)),
        () => fail(new OperationCancelledError(`Process cancelled: ${request.command}`))
      );
    };

    child.stdout?.on('data', (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      appendOutput(stdout, chunk, outputLimitBytes);
      request.onOutput?.({ stream: 'stdout', chunk: chunk.toString('utf8') });
    });
    child.stderr?.on('data', (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      appendOutput(stderr, chunk, outputLimitBytes);
      request.onOutput?.({ stream: 'stderr', chunk: chunk.toString('utf8') });
    });
    child.once('error', (error) => {
      if (!aborting) fail(error);
    });
    child.once('close', (exitCode, signal) => {
      if (aborting) return;
      finish({
        pid: child.pid ?? 0,
        exitCode,
        signal,
        stdout: capturedText(stdout),
        stderr: capturedText(stderr),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - startedAt
      });
    });

    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener('abort', onAbort, { once: true });
  });
}
