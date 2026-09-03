import type {
  AxisTool,
  MutationStatus,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutput
} from '../../agent-runtime/index.js';
import { sanitizeProcessEnvironment } from './environment.js';
import { parseProcessExecInput, type ProcessExecInput } from './exec-tool.js';
import {
  ManagedProcessRegistry,
  type ManagedProcessCursor,
  type ManagedProcessSnapshot
} from './managed-process.js';
import {
  StaticProcessExecutionPolicy,
  type ProcessExecutionPolicy
} from './policy.js';
import { resolveProcessScope } from './scope.js';

export const PROCESS_START_TOOL_NAME = 'process_start';
export const PROCESS_POLL_TOOL_NAME = 'process_poll';
export const PROCESS_WAIT_TOOL_NAME = 'process_wait';
export const PROCESS_STDIN_TOOL_NAME = 'process_stdin';
export const PROCESS_SIGNAL_TOOL_NAME = 'process_signal';
export const PROCESS_TERMINATE_TOOL_NAME = 'process_terminate';
export const PROCESS_LIST_TOOL_NAME = 'process_list';
export const PROCESS_EXEC_CAPABILITY = 'axis.process.exec';
export const PROCESS_EXEC_PERMISSION = 'process.exec';

const START_TIMEOUT_MS = 15_000;
const CONTROL_TIMEOUT_MS = 30_000;
const MAX_STDIN_CHARS = 64 * 1024;

export interface BackgroundProcessToolOptions {
  readonly registry?: ManagedProcessRegistry;
  readonly policy?: ProcessExecutionPolicy;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ProcessControlInput extends ManagedProcessCursor {
  readonly processId: string;
}

export interface BackgroundProcessOutput extends ManagedProcessSnapshot {
  readonly processMutationStatus: MutationStatus;
}

function requiredProcessId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('processId must be a non-empty string.');
  return value.trim();
}

function parseOffset(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function parseControlInput(value: Readonly<Record<string, unknown>>): ProcessControlInput {
  return {
    processId: requiredProcessId(value.processId),
    stdoutOffset: parseOffset(value.stdoutOffset, 'stdoutOffset'),
    stderrOffset: parseOffset(value.stderrOffset, 'stderrOffset')
  };
}

function cursorFrom(input: ProcessControlInput): ManagedProcessCursor {
  return {
    stdoutOffset: input.stdoutOffset,
    stderrOffset: input.stderrOffset
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

function processMutationStatus(snapshot: ManagedProcessSnapshot): MutationStatus {
  if (snapshot.mutation === 'read-only') return 'not-applicable';
  if (snapshot.status === 'starting' || snapshot.status === 'running' || snapshot.status === 'terminating') {
    return 'started';
  }
  return snapshot.status === 'exited' && snapshot.exitCode === 0 && snapshot.signal === null
    ? 'committed'
    : 'unknown';
}

function output(snapshot: ManagedProcessSnapshot): BackgroundProcessOutput {
  return { ...snapshot, processMutationStatus: processMutationStatus(snapshot) };
}

const CONTROL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['processId'],
  properties: {
    processId: { type: 'string', minLength: 1 },
    stdoutOffset: { type: 'integer', minimum: 0 },
    stderrOffset: { type: 'integer', minimum: 0 }
  }
} as const;

function controlDefinition(
  name: string,
  description: string,
  effect: 'read' | 'command',
  mutationRisk: 'none' | 'possible',
  timeoutMs: number
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: CONTROL_INPUT_SCHEMA,
    requiredCapabilities: [PROCESS_EXEC_CAPABILITY],
    requiredPermissions: [PROCESS_EXEC_PERMISSION],
    effect,
    mutationRisk,
    retryOnFailure: 'safe',
    timeoutMs
  };
}

abstract class RegistryTool {
  protected readonly registry: ManagedProcessRegistry;

  constructor(registry?: ManagedProcessRegistry) {
    this.registry = registry ?? new ManagedProcessRegistry();
  }
}

/** Starts an authorized command and transfers ownership to a session-bound registry. */
export class ProcessStartTool extends RegistryTool implements AxisTool {
  readonly definition: ToolDefinition = {
    name: PROCESS_START_TOOL_NAME,
    description:
      'Start one allowlisted executable in the background inside an authorized session root. Returns a processId for later poll, wait, stdin, signal, or terminate operations.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'args', 'rootId', 'cwd', 'mutation'],
      properties: {
        command: { type: 'string', minLength: 1 },
        args: { type: 'array', items: { type: 'string' }, maxItems: 512 },
        rootId: { type: 'string', minLength: 1 },
        cwd: { type: 'string', minLength: 1 },
        mutation: { type: 'string', enum: ['read-only', 'workspace'] },
        env: { type: 'object', additionalProperties: { type: 'string' }, maxProperties: 128 }
      }
    },
    requiredCapabilities: [PROCESS_EXEC_CAPABILITY],
    requiredPermissions: [PROCESS_EXEC_PERMISSION],
    effect: 'command',
    mutationRisk: 'possible',
    retryOnFailure: 'after-confirmation',
    timeoutMs: START_TIMEOUT_MS
  };

  private readonly policy: ProcessExecutionPolicy;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: BackgroundProcessToolOptions = {}) {
    super(options.registry);
    this.policy = options.policy ?? new StaticProcessExecutionPolicy();
    this.environment = options.environment ?? process.env;
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const input: ProcessExecInput = parseProcessExecInput(context.call.arguments);
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

    context.reportActivity({
      kind: 'command',
      detail: display,
      metadata: {
        phase: 'background-start',
        rootId: input.rootId,
        cwd: scope.cwd,
        executionTargetId: context.session.executionTarget.id,
        mutationIntent: input.mutation
      }
    });

    const snapshot = await this.registry.start({
      session: context.session,
      command: input.command,
      args: input.args,
      displayCommand: display,
      cwdPath: scope.cwdPath,
      cwd: scope.cwd,
      rootId: input.rootId,
      mutation: input.mutation,
      env: environment.env,
      signal: context.signal
    });
    const status = processMutationStatus(snapshot);

    context.reportProgress({
      message: `Background process ${snapshot.processId} started (pid ${snapshot.pid}).`,
      metadata: {
        processId: snapshot.processId,
        pid: snapshot.pid,
        status: snapshot.status,
        mutationStatus: status,
        executionTargetId: snapshot.executionTargetId
      }
    });

    return {
      output: output(snapshot),
      mutationStatus: status,
      retry: input.mutation === 'read-only' ? 'safe' : 'after-confirmation',
      metadata: {
        processId: snapshot.processId,
        pid: snapshot.pid,
        rootId: snapshot.rootId,
        cwd: snapshot.cwd,
        executionTargetId: snapshot.executionTargetId,
        inheritedEnvironmentKeyCount: environment.inheritedKeys.length,
        droppedEnvironmentKeyCount: environment.droppedKeys.length,
        overriddenEnvironmentKeys: environment.overriddenKeys
      }
    };
  }
}

export class ProcessPollTool extends RegistryTool implements AxisTool {
  readonly definition = controlDefinition(
    PROCESS_POLL_TOOL_NAME,
    'Read current state and incremental stdout/stderr from a background process owned by this exact session.',
    'read',
    'none',
    5_000
  );

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const input = parseControlInput(context.call.arguments);
    const snapshot = this.registry.snapshotFor(context.session, input.processId, cursorFrom(input));
    return {
      output: output(snapshot),
      mutationStatus: 'not-applicable',
      retry: 'safe',
      metadata: {
        processId: snapshot.processId,
        status: snapshot.status,
        executionTargetId: snapshot.executionTargetId
      }
    };
  }
}

export class ProcessWaitTool extends RegistryTool implements AxisTool {
  readonly definition = controlDefinition(
    PROCESS_WAIT_TOOL_NAME,
    'Wait for a background process owned by this exact session to finish. A wait timeout/cancellation does not kill the background process.',
    'command',
    'possible',
    CONTROL_TIMEOUT_MS
  );

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const input = parseControlInput(context.call.arguments);
    const snapshot = await this.registry.wait(
      context.session,
      input.processId,
      context.signal,
      cursorFrom(input)
    );
    const status = processMutationStatus(snapshot);
    return {
      output: output(snapshot),
      mutationStatus: status,
      retry: 'safe',
      metadata: {
        processId: snapshot.processId,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
        executionTargetId: snapshot.executionTargetId
      }
    };
  }
}

export class ProcessStdinTool extends RegistryTool implements AxisTool {
  readonly definition: ToolDefinition = {
    name: PROCESS_STDIN_TOOL_NAME,
    description:
      'Write a bounded UTF-8 chunk to stdin of a running background process owned by this exact session, optionally closing stdin afterwards.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['processId', 'data'],
      properties: {
        processId: { type: 'string', minLength: 1 },
        data: { type: 'string', maxLength: MAX_STDIN_CHARS },
        end: { type: 'boolean' },
        stdoutOffset: { type: 'integer', minimum: 0 },
        stderrOffset: { type: 'integer', minimum: 0 }
      }
    },
    requiredCapabilities: [PROCESS_EXEC_CAPABILITY],
    requiredPermissions: [PROCESS_EXEC_PERMISSION],
    effect: 'command',
    mutationRisk: 'possible',
    retryOnFailure: 'after-confirmation',
    timeoutMs: 5_000
  };

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const control = parseControlInput(context.call.arguments);
    const data = context.call.arguments.data;
    const end = context.call.arguments.end;
    if (typeof data !== 'string') throw new Error('process_stdin data must be a string.');
    if (data.length > MAX_STDIN_CHARS) throw new Error(`process_stdin data exceeds ${MAX_STDIN_CHARS} characters.`);
    if (end !== undefined && typeof end !== 'boolean') throw new Error('process_stdin end must be a boolean.');

    const snapshot = await this.registry.writeStdin(
      context.session,
      control.processId,
      data,
      end === true,
      cursorFrom(control)
    );
    const status = processMutationStatus(snapshot);
    return {
      output: output(snapshot),
      mutationStatus: status,
      retry: 'after-confirmation',
      metadata: {
        processId: snapshot.processId,
        stdinOpen: snapshot.stdinOpen,
        status: snapshot.status,
        executionTargetId: snapshot.executionTargetId
      }
    };
  }
}

function allowedSignals(): readonly NodeJS.Signals[] {
  return process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1', 'SIGUSR2'];
}

export class ProcessSignalTool extends RegistryTool implements AxisTool {
  readonly definition: ToolDefinition = {
    name: PROCESS_SIGNAL_TOOL_NAME,
    description:
      'Send one allowlisted operating-system signal to a running background process owned by this exact session. Use process_terminate for forced tree termination.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['processId', 'signal'],
      properties: {
        processId: { type: 'string', minLength: 1 },
        signal: { type: 'string' },
        stdoutOffset: { type: 'integer', minimum: 0 },
        stderrOffset: { type: 'integer', minimum: 0 }
      }
    },
    requiredCapabilities: [PROCESS_EXEC_CAPABILITY],
    requiredPermissions: [PROCESS_EXEC_PERMISSION],
    effect: 'command',
    mutationRisk: 'possible',
    retryOnFailure: 'after-confirmation',
    timeoutMs: 5_000
  };

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const control = parseControlInput(context.call.arguments);
    const rawSignal = context.call.arguments.signal;
    if (typeof rawSignal !== 'string' || !rawSignal.trim()) {
      throw new Error('process_signal signal must be a non-empty string.');
    }
    const signal = rawSignal.trim().toUpperCase() as NodeJS.Signals;
    if (!allowedSignals().includes(signal)) {
      throw new Error(`Signal ${signal} is not allowed on ${process.platform}.`);
    }

    const snapshot = this.registry.sendSignal(
      context.session,
      control.processId,
      signal,
      cursorFrom(control)
    );
    const status = processMutationStatus(snapshot);
    return {
      output: output(snapshot),
      mutationStatus: status,
      retry: 'after-confirmation',
      metadata: {
        processId: snapshot.processId,
        signal,
        status: snapshot.status,
        executionTargetId: snapshot.executionTargetId
      }
    };
  }
}

export class ProcessTerminateTool extends RegistryTool implements AxisTool {
  readonly definition = controlDefinition(
    PROCESS_TERMINATE_TOOL_NAME,
    'Terminate a background process and its descendants when it is owned by this exact session.',
    'command',
    'possible',
    CONTROL_TIMEOUT_MS
  );

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const input = parseControlInput(context.call.arguments);
    const snapshot = await this.registry.terminate(context.session, input.processId, cursorFrom(input));
    const status = processMutationStatus(snapshot);
    context.reportProgress({
      message: `Background process ${snapshot.processId} is ${snapshot.status}.`,
      metadata: { processId: snapshot.processId, status: snapshot.status }
    });
    return {
      output: output(snapshot),
      mutationStatus: status,
      retry: 'safe',
      metadata: {
        processId: snapshot.processId,
        status: snapshot.status,
        executionTargetId: snapshot.executionTargetId
      }
    };
  }
}

export class ProcessListTool extends RegistryTool implements AxisTool {
  readonly definition: ToolDefinition = {
    name: PROCESS_LIST_TOOL_NAME,
    description: 'List background processes owned by this exact immutable Axis session.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    requiredCapabilities: [PROCESS_EXEC_CAPABILITY],
    requiredPermissions: [PROCESS_EXEC_PERMISSION],
    effect: 'read',
    mutationRisk: 'none',
    retryOnFailure: 'safe',
    timeoutMs: 5_000
  };

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    return {
      output: this.registry.list(context.session).map(output),
      mutationStatus: 'not-applicable',
      retry: 'safe'
    };
  }
}

export interface ProcessBackgroundToolSuite {
  readonly registry: ManagedProcessRegistry;
  readonly tools: readonly AxisTool[];
}

/** Creates all background lifecycle tools with one shared session-bound registry. */
export function createProcessBackgroundTools(
  options: BackgroundProcessToolOptions = {}
): ProcessBackgroundToolSuite {
  const registry = options.registry ?? new ManagedProcessRegistry();
  const shared = { ...options, registry };
  return {
    registry,
    tools: [
      new ProcessStartTool(shared),
      new ProcessPollTool(registry),
      new ProcessWaitTool(registry),
      new ProcessStdinTool(registry),
      new ProcessSignalTool(registry),
      new ProcessTerminateTool(registry),
      new ProcessListTool(registry)
    ]
  };
}
