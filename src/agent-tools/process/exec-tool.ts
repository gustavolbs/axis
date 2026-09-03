import type {
  AxisTool,
  MutationStatus,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutput
} from '../../agent-runtime/index.js';
import { sanitizeProcessEnvironment } from './environment.js';
import {
  StaticProcessExecutionPolicy,
  type ProcessExecutionPolicy,
  type ProcessMutationIntent
} from './policy.js';
import { runProcess } from './runner.js';
import { resolveProcessScope } from './scope.js';

export const PROCESS_EXEC_TOOL_NAME = 'process_exec';
export const PROCESS_EXEC_CAPABILITY = 'axis.process.exec';
export const PROCESS_EXEC_PERMISSION = 'process.exec';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1_000_000;
const MAX_ARGUMENT_COUNT = 512;
const MAX_ARGUMENT_LENGTH = 32_768;
const MAX_ENVIRONMENT_VARIABLES = 128;
const MAX_ENVIRONMENT_VALUE_LENGTH = 65_536;
const MAX_PROGRESS_CHUNK_CHARS = 8_192;

export interface ProcessExecInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly rootId: string;
  /** Root-relative working directory. Absolute cwd values are never accepted. */
  readonly cwd: string;
  readonly mutation: ProcessMutationIntent;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProcessExecOutput {
  readonly command: string;
  readonly cwd: string;
  readonly executionTargetId: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

export interface ProcessExecToolOptions {
  readonly policy?: ProcessExecutionPolicy;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
  readonly killGraceMs?: number;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  if (value.includes('\0')) throw new Error(`${label} must not contain NUL bytes.`);
  return value;
}

function parseArguments(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Process args must be an array of strings.');
  if (value.length > MAX_ARGUMENT_COUNT) {
    throw new Error(`Process args exceed the ${MAX_ARGUMENT_COUNT}-argument limit.`);
  }
  return value.map((arg, index) => {
    if (typeof arg !== 'string') throw new Error(`Process arg ${index} must be a string.`);
    if (arg.length > MAX_ARGUMENT_LENGTH) {
      throw new Error(`Process arg ${index} exceeds ${MAX_ARGUMENT_LENGTH} characters.`);
    }
    if (arg.includes('\0')) throw new Error(`Process arg ${index} must not contain NUL bytes.`);
    return arg;
  });
}

function parseMutation(value: unknown): ProcessMutationIntent {
  if (value !== 'read-only' && value !== 'workspace') {
    throw new Error('Process mutation must be either "read-only" or "workspace".');
  }
  return value;
}

function parseEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Process env must be an object of string values.');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENVIRONMENT_VARIABLES) {
    throw new Error(`Process env exceeds the ${MAX_ENVIRONMENT_VARIABLES}-variable limit.`);
  }
  return Object.fromEntries(entries.map(([name, item]) => {
    if (typeof item !== 'string') throw new Error(`Process env ${name} must be a string.`);
    if (item.length > MAX_ENVIRONMENT_VALUE_LENGTH) {
      throw new Error(`Process env ${name} exceeds ${MAX_ENVIRONMENT_VALUE_LENGTH} characters.`);
    }
    return [name, item];
  }));
}

export function parseProcessExecInput(value: Readonly<Record<string, unknown>>): ProcessExecInput {
  return {
    command: requiredString(value.command, 'Process command'),
    args: Object.freeze(parseArguments(value.args)),
    rootId: requiredString(value.rootId, 'Process rootId'),
    cwd: requiredString(value.cwd, 'Process cwd'),
    mutation: parseMutation(value.mutation),
    env: Object.freeze(parseEnvironment(value.env))
  };
}

function redactDisplayArgument(arg: string): string {
  if (/^(?:--?[^=]*(?:token|secret|password|api[-_]?key)[^=]*)=/i.test(arg)) {
    return `${arg.slice(0, arg.indexOf('=') + 1)}[REDACTED]`;
  }
  if (/^(?:token|secret|password|api[-_]?key)=/i.test(arg)) {
    return `${arg.slice(0, arg.indexOf('=') + 1)}[REDACTED]`;
  }
  return arg.length > 200 ? `${arg.slice(0, 197)}...` : arg;
}

function commandDisplay(command: string, args: readonly string[]): string {
  return [command, ...args.map(redactDisplayArgument)].join(' ').trim();
}

function mutationStatus(input: ProcessExecInput, exitCode: number | null, signal: NodeJS.Signals | null): MutationStatus {
  if (input.mutation === 'read-only') return 'not-applicable';
  return exitCode === 0 && signal === null ? 'committed' : 'unknown';
}

function definition(timeoutMs: number): ToolDefinition {
  return {
    name: PROCESS_EXEC_TOOL_NAME,
    description:
      'Execute one allowlisted executable with argv inside an authorized session root. No shell is used; cwd, environment, cancellation and mutation intent are explicit.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'args', 'rootId', 'cwd', 'mutation'],
      properties: {
        command: { type: 'string', minLength: 1 },
        args: { type: 'array', items: { type: 'string' }, maxItems: MAX_ARGUMENT_COUNT },
        rootId: { type: 'string', minLength: 1 },
        cwd: { type: 'string', minLength: 1, description: 'Working directory relative to rootId.' },
        mutation: { type: 'string', enum: ['read-only', 'workspace'] },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          maxProperties: MAX_ENVIRONMENT_VARIABLES
        }
      }
    },
    requiredCapabilities: [PROCESS_EXEC_CAPABILITY],
    requiredPermissions: [PROCESS_EXEC_PERMISSION],
    effect: 'command',
    mutationRisk: 'possible',
    retryOnFailure: 'after-confirmation',
    timeoutMs
  };
}

export class ProcessExecTool implements AxisTool {
  readonly definition: ToolDefinition;
  private readonly policy: ProcessExecutionPolicy;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly outputLimitBytes: number;
  private readonly killGraceMs: number | undefined;

  constructor(options: ProcessExecToolOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Process timeoutMs must be positive.');
    const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    if (!Number.isFinite(outputLimitBytes) || outputLimitBytes <= 0) {
      throw new Error('Process outputLimitBytes must be positive.');
    }
    if (options.killGraceMs !== undefined && (!Number.isFinite(options.killGraceMs) || options.killGraceMs < 0)) {
      throw new Error('Process killGraceMs must be non-negative.');
    }

    this.definition = Object.freeze(definition(timeoutMs));
    this.policy = options.policy ?? new StaticProcessExecutionPolicy();
    this.environment = options.environment ?? process.env;
    this.outputLimitBytes = outputLimitBytes;
    this.killGraceMs = options.killGraceMs;
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const input = parseProcessExecInput(context.call.arguments);
    const scope = await resolveProcessScope(context.session, input.rootId, input.cwd, input.mutation);
    this.policy.authorize({
      command: input.command,
      args: input.args,
      mutation: input.mutation,
      session: context.session,
      scope
    });

    const environment = sanitizeProcessEnvironment(this.environment, input.env);
    const display = commandDisplay(input.command, input.args);
    const commonMetadata = {
      command: input.command,
      rootId: input.rootId,
      cwd: scope.cwd,
      executionTargetId: context.session.executionTarget.id,
      mutationIntent: input.mutation
    } as const;

    context.reportProgress({
      message: `Running ${display}`,
      metadata: { ...commonMetadata, phase: 'started' }
    });

    const result = await runProcess({
      command: input.command,
      args: input.args,
      cwd: scope.cwdPath,
      env: environment.env,
      signal: context.signal,
      outputLimitBytes: this.outputLimitBytes,
      killGraceMs: this.killGraceMs,
      onOutput: ({ stream, chunk }) => context.reportProgress({
        message: `${stream}: ${chunk.slice(0, MAX_PROGRESS_CHUNK_CHARS)}`,
        metadata: {
          ...commonMetadata,
          phase: 'output',
          stream,
          chunk: chunk.slice(0, MAX_PROGRESS_CHUNK_CHARS),
          chunkTruncated: chunk.length > MAX_PROGRESS_CHUNK_CHARS
        }
      })
    });

    const output: ProcessExecOutput = {
      command: input.command,
      cwd: scope.cwd,
      executionTargetId: context.session.executionTarget.id,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      durationMs: result.durationMs
    };
    const status = mutationStatus(input, result.exitCode, result.signal);

    context.reportActivity({
      kind: 'command',
      detail: display,
      metadata: {
        ...commonMetadata,
        phase: 'completed',
        exitCode: result.exitCode,
        signal: result.signal,
        mutationStatus: status
      }
    });
    context.reportProgress({
      message: result.exitCode === 0
        ? `${input.command} completed successfully.`
        : `${input.command} exited with code ${String(result.exitCode)}.`,
      metadata: {
        ...commonMetadata,
        phase: 'completed',
        exitCode: result.exitCode,
        signal: result.signal,
        mutationStatus: status
      }
    });

    return {
      output,
      mutationStatus: status,
      retry: input.mutation === 'read-only' ? 'safe' : 'after-confirmation',
      metadata: {
        pid: result.pid,
        rootId: input.rootId,
        cwd: scope.cwd,
        executionTargetId: context.session.executionTarget.id,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        inheritedEnvironmentKeyCount: environment.inheritedKeys.length,
        droppedEnvironmentKeyCount: environment.droppedKeys.length,
        overriddenEnvironmentKeys: environment.overriddenKeys
      }
    };
  }
}
