import { spawn } from 'node:child_process';

import {
  OperationCancelledError,
  currentCancellationSignal,
  throwIfCancelled
} from './cancellation.js';
import { resolveSpawnInvocation } from './platform-command.js';
import { reportProgress } from './progress-context.js';

export interface ValidationCommand {
  command: string;
  args?: string[];
}

export interface ValidationResult {
  command: string;
  args: string[];
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

const SAFE_PACKAGE_MANAGER_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(['test', 'run']),
  pnpm: new Set(['test', 'run', 'exec']),
  yarn: new Set(['test', 'run']),
  bun: new Set(['test', 'run'])
};

function appendBounded(current: string, chunk: Buffer | string, limit: number): string {
  if (current.length >= limit) return current;
  return `${current}${String(chunk)}`.slice(0, limit);
}

function assertValidationAllowed(
  validation: ValidationCommand,
  allowedCommands: Set<string>
): void {
  if (!allowedCommands.has(validation.command)) {
    throw new Error(
      `Validation command "${validation.command}" is not allowed. Allowed: ${[...allowedCommands].join(', ')}`
    );
  }

  if (validation.command.includes('/') || validation.command.includes('\\')) {
    throw new Error('Validation command must be an executable name, not a path.');
  }

  const guardedSubcommands = SAFE_PACKAGE_MANAGER_SUBCOMMANDS[validation.command];
  if (!guardedSubcommands) return;

  const firstArg = validation.args?.[0];
  if (!firstArg || !guardedSubcommands.has(firstArg)) {
    throw new Error(
      `Unsafe ${validation.command} validation invocation. Allowed first arguments: ${[
        ...guardedSubcommands
      ].join(', ')}`
    );
  }
}

export async function runValidationCommand(
  workspace: string,
  validation: ValidationCommand,
  allowedCommands: Set<string>,
  timeoutMs: number,
  outputLimit = 20_000
): Promise<ValidationResult> {
  throwIfCancelled();
  assertValidationAllowed(validation, allowedCommands);

  const args = validation.args ?? [];
  const display = `${validation.command} ${args.join(' ')}`.trim();
  reportProgress({
    phase: 'validation',
    action: 'Running deterministic validation',
    detail: display,
    validation: display
  });

  const invocation = resolveSpawnInvocation(validation.command, args);
  const startedAt = Date.now();
  const cancellation = currentCancellationSignal();

  const result = await new Promise<ValidationResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: workspace,
      shell: false,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let settled = false;
    let timer: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(timer);
      cancellation?.removeEventListener('abort', onAbort);
    };
    const finish = (value: ValidationResult) => {
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
      if (settled) return;
      child.kill('SIGTERM');
      fail(new OperationCancelledError(`Validation cancelled: ${display}`));
    };

    child.stdout.on('data', (chunk) => {
      output = appendBounded(output, chunk, outputLimit);
    });
    child.stderr.on('data', (chunk) => {
      output = appendBounded(output, chunk, outputLimit);
    });
    child.on('error', fail);
    child.on('close', (exitCode) => {
      finish({
        command: validation.command,
        args,
        ok: exitCode === 0,
        exitCode,
        output: output.trim(),
        durationMs: Date.now() - startedAt
      });
    });

    if (cancellation) {
      if (cancellation.aborted) onAbort();
      else cancellation.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        command: validation.command,
        args,
        ok: false,
        exitCode: null,
        output: `${output.trim()}\nValidation timed out after ${timeoutMs}ms.`.trim(),
        durationMs: Date.now() - startedAt
      });
    }, timeoutMs);
  });

  throwIfCancelled();
  reportProgress({
    phase: 'validation',
    action: result.ok ? 'Validation passed' : 'Validation failed',
    detail: `${display} · ${result.durationMs}ms${result.exitCode === null ? '' : ` · exit ${result.exitCode}`}`,
    validation: display,
    reasoningSummary: result.ok
      ? 'The current deterministic check passed.'
      : 'The current deterministic check failed; the local repair/execution loop will use this evidence.'
  });

  return result;
}

export async function runValidations(
  workspace: string,
  validations: ValidationCommand[],
  allowedCommands: Set<string>,
  timeoutMs: number
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const validation of validations) {
    throwIfCancelled();
    const result = await runValidationCommand(
      workspace,
      validation,
      allowedCommands,
      timeoutMs
    );
    results.push(result);

    if (!result.ok) break;
  }

  return results;
}
