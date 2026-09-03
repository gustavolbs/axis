import type { AgentSessionContext } from '../../agent-runtime/index.js';
import { assertPathArgumentWithinRoot, type ResolvedProcessScope } from './scope.js';

export type ProcessMutationIntent = 'read-only' | 'workspace';

export interface ProcessPolicyRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly mutation: ProcessMutationIntent;
  readonly session: AgentSessionContext;
  readonly scope: ResolvedProcessScope;
}

export interface ProcessExecutionPolicy {
  authorize(request: ProcessPolicyRequest): void;
}

const DEFAULT_ALLOWED_EXECUTABLES = new Set([
  'awk', 'bun', 'cargo', 'cat', 'cmake', 'dotnet', 'find', 'git', 'go', 'gradle',
  'grep', 'head', 'java', 'javac', 'make', 'mvn', 'ninja', 'node', 'npm', 'npx',
  'pnpm', 'printf', 'pytest', 'python', 'python3', 'rg', 'rustc', 'sed', 'sort',
  'tail', 'tsc', 'tsx', 'uniq', 'wc', 'where', 'yarn'
]);

const SHELL_EXECUTABLES = new Set([
  'bash', 'cmd', 'command', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'sh', 'zsh'
]);

const READ_ONLY_EXECUTABLES = new Set([
  'awk', 'cat', 'find', 'grep', 'head', 'printf', 'rg', 'sed', 'sort', 'tail', 'uniq', 'wc', 'where'
]);

const VERSION_ARGUMENTS = new Set(['--help', '--version', '-h', '-v']);

function normalizedExecutable(command: string): string {
  const lower = command.trim().toLowerCase();
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower;
}

function isReadOnlyInvocation(command: string, args: readonly string[]): boolean {
  const executable = normalizedExecutable(command);
  if (READ_ONLY_EXECUTABLES.has(executable)) return true;
  return args.length === 1 && VERSION_ARGUMENTS.has(args[0] ?? '');
}

function assertCommandName(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('Process command must not be empty.');
  if (trimmed.includes('\0')) throw new Error('Process command must not contain NUL bytes.');
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Process command must be an allowlisted executable name, not a path.');
  }
  if (/\.(?:cmd|bat|ps1)$/i.test(trimmed)) {
    throw new Error('Shell scripts are not accepted by process_exec; provide an executable and argv directly.');
  }
}

export interface StaticProcessExecutionPolicyOptions {
  readonly allowedExecutables?: readonly string[];
}

/**
 * The native process tool is intentionally argv-only. A configurable executable
 * allowlist keeps policy separate from execution while explicit shell interpreters
 * stay blocked so callers cannot silently recover `shell: true` semantics.
 */
export class StaticProcessExecutionPolicy implements ProcessExecutionPolicy {
  private readonly allowedExecutables: ReadonlySet<string>;

  constructor(options: StaticProcessExecutionPolicyOptions = {}) {
    this.allowedExecutables = new Set(
      (options.allowedExecutables ?? [...DEFAULT_ALLOWED_EXECUTABLES]).map(normalizedExecutable)
    );
  }

  authorize(request: ProcessPolicyRequest): void {
    assertCommandName(request.command);
    const executable = normalizedExecutable(request.command);

    if (SHELL_EXECUTABLES.has(executable)) {
      throw new Error(
        `Shell interpreter ${request.command} is blocked. process_exec requires an executable plus argv.`
      );
    }
    if (!this.allowedExecutables.has(executable)) {
      throw new Error(`Process executable ${request.command} is not allowed by the current policy.`);
    }

    for (const arg of request.args) {
      if (arg.includes('\0')) throw new Error('Process arguments must not contain NUL bytes.');
      assertPathArgumentWithinRoot(request.scope.rootPath, arg);
    }

    if (request.mutation === 'read-only' && !isReadOnlyInvocation(request.command, request.args)) {
      throw new Error(
        `Invocation ${request.command} cannot be proven read-only; declare workspace mutation intent.`
      );
    }
  }
}

export const DEFAULT_PROCESS_EXECUTABLES = Object.freeze([...DEFAULT_ALLOWED_EXECUTABLES].sort());
