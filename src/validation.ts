import { spawn } from 'node:child_process';

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

function validationExecutable(command: string): string {
  if (process.platform !== 'win32') return command;
  if (['npm', 'pnpm', 'yarn'].includes(command)) return `${command}.cmd`;
  return command;
}

export async function runValidationCommand(
  workspace: string,
  validation: ValidationCommand,
  allowedCommands: Set<string>,
  timeoutMs: number,
  outputLimit = 20_000
): Promise<ValidationResult> {
  assertValidationAllowed(validation, allowedCommands);

  const args = validation.args ?? [];
  const startedAt = Date.now();

  return await new Promise<ValidationResult>((resolve, reject) => {
    const child = spawn(validationExecutable(validation.command), args, {
      cwd: workspace,
      shell: false,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (result: ValidationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk) => {
      output = appendBounded(output, chunk, outputLimit);
    });
    child.stderr.on('data', (chunk) => {
      output = appendBounded(output, chunk, outputLimit);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
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
}

export async function runValidations(
  workspace: string,
  validations: ValidationCommand[],
  allowedCommands: Set<string>,
  timeoutMs: number
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const validation of validations) {
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
