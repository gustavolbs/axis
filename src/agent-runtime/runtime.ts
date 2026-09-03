import { randomUUID } from 'node:crypto';

import {
  callerCancelled,
  isCancellationError,
  requestAbortSignal,
  throwIfCancelled,
  withCancellationSignal
} from '../cancellation.js';
import { ProviderError } from '../providers/types.js';
import { capabilityUnavailableReason } from './capabilities.js';
import {
  AgentRuntimeError,
  freezeAgentSessionContext,
  type AgentLifecycleEvent,
  type AgentLifecycleSink,
  type AgentMessage,
  type AgentRuntimeFailure,
  type AgentSessionContext,
  type AgentTurn,
  type RetryEligibility,
  type ToolActivity,
  type ToolCall,
  type ToolDefinition,
  type ToolResult
} from './contracts.js';
import {
  AgentProviderProtocolError,
  type AgentProviderAdapter
} from './provider-adapter.js';
import {
  ExecutionTargetRegistry,
  LocalAgentExecutionTarget,
  StaticToolPermissionGate,
  ToolRegistry,
  type AgentExecutionTarget,
  type AxisTool,
  type ToolExecutionOutput,
  type ToolPermissionGate
} from './tools.js';

type LifecyclePayload = AgentLifecycleEvent extends infer Event
  ? Event extends AgentLifecycleEvent
    ? Omit<Event, 'id' | 'sequence' | 'timestamp' | 'sessionId' | 'turnId'>
    : never
  : never;

class LifecycleEmitter {
  private sequence = 0;

  constructor(
    private readonly sessionId: string,
    private readonly sinks: readonly AgentLifecycleSink[]
  ) {}

  emit(payload: LifecyclePayload, turnId?: string): void {
    const event = {
      ...payload,
      id: randomUUID(),
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      ...(turnId ? { turnId } : {})
    } as AgentLifecycleEvent;
    for (const sink of this.sinks) {
      try {
        sink(event);
      } catch (error) {
        // Lifecycle consumers are observers. A tracing/memory failure must not
        // duplicate or corrupt an already-running local/provider operation.
        console.error(
          `Agent lifecycle consumer failed for ${event.type}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}

export interface AgentRuntimeLimits {
  readonly maxModelCycles: number;
  readonly maxToolCalls: number;
  readonly providerTimeoutMs: number;
  readonly toolTimeoutMs: number;
}

export interface AgentRunInput {
  readonly context: AgentSessionContext;
  readonly provider: AgentProviderAdapter;
  readonly userInput: string;
  readonly systemPrompt?: string;
  readonly transcript?: readonly AgentMessage[];
  readonly turnIndex?: number;
  readonly requiredCapabilities?: readonly string[];
  readonly requireToolUse?: boolean;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<AgentRuntimeLimits>;
}

export interface AgentRunResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly context: AgentSessionContext;
  readonly turn: AgentTurn;
  readonly messages: readonly AgentMessage[];
  readonly toolResults: readonly ToolResult[];
  readonly finalText?: string;
  readonly error?: AgentRuntimeFailure;
}

export interface AgentRuntimeOptions {
  readonly tools?: ToolRegistry | readonly AxisTool[];
  readonly executionTargets?: ExecutionTargetRegistry | readonly AgentExecutionTarget[];
  readonly permissionGate?: ToolPermissionGate;
  readonly lifecycle?: readonly AgentLifecycleSink[];
  readonly limits?: Partial<AgentRuntimeLimits>;
}

const DEFAULT_LIMITS: AgentRuntimeLimits = Object.freeze({
  maxModelCycles: 32,
  maxToolCalls: 64,
  providerTimeoutMs: 120_000,
  toolTimeoutMs: 120_000
});

function limits(
  defaults: Partial<AgentRuntimeLimits> | undefined,
  override: Partial<AgentRuntimeLimits> | undefined
): AgentRuntimeLimits {
  const merged = { ...DEFAULT_LIMITS, ...defaults, ...override };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  }
  return merged;
}

function failure(
  kind: AgentRuntimeFailure['kind'],
  code: string,
  message: string,
  retry: RetryEligibility = 'never',
  details?: Readonly<Record<string, unknown>>
): AgentRuntimeFailure {
  return { kind, code, message, retry, details };
}

function providerFailure(error: unknown): AgentRuntimeFailure {
  if (error instanceof AgentRuntimeError) return error.failure;
  if (error instanceof AgentProviderProtocolError) {
    return failure('protocol', 'provider_protocol_error', error.message);
  }
  if (error instanceof ProviderError) {
    return failure(
      'provider',
      error.options.code ?? 'provider_error',
      error.message,
      error.options.retryable ? 'provider' : 'never',
      {
        providerId: error.providerId,
        status: error.options.status,
        rateLimited: error.options.rateLimited,
        retryAfterMs: error.options.retryAfterMs
      }
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout/i.test(message)) return failure('timeout', 'provider_timeout', message, 'provider');
  return failure('provider', 'provider_error', message, 'provider');
}

function unavailableCapabilities(
  context: AgentSessionContext,
  required: readonly string[]
): string[] {
  return [...new Set(required.map((id) => id.trim()).filter(Boolean))]
    .map((id) => capabilityUnavailableReason(context.capabilities, id))
    .filter((reason): reason is string => Boolean(reason));
}

function toolAvailable(context: AgentSessionContext, definition: ToolDefinition): boolean {
  return unavailableCapabilities(context, definition.requiredCapabilities).length === 0;
}

function mutationStatusOnFailure(tool: ToolDefinition): ToolResult['mutationStatus'] {
  return tool.mutationRisk === 'none' ? 'not-applicable' : 'unknown';
}

function mutationStatusOnSuccess(
  tool: ToolDefinition,
  output: ToolExecutionOutput
): ToolResult['mutationStatus'] {
  if (tool.mutationRisk === 'none') return 'not-applicable';
  return output.mutationStatus ?? 'unknown';
}

function resultMessage(result: ToolResult): string {
  try {
    return JSON.stringify(result);
  } catch {
    return JSON.stringify({
      callId: result.callId,
      toolName: result.toolName,
      status: 'error',
      error: {
        kind: 'protocol',
        code: 'tool_result_not_serializable',
        message: 'Tool result could not be serialized for the provider.',
        retry: 'never'
      },
      mutationStatus: result.mutationStatus
    });
  }
}

export class AgentRuntime {
  readonly tools: ToolRegistry;
  readonly executionTargets: ExecutionTargetRegistry;
  readonly permissionGate: ToolPermissionGate;
  private readonly lifecycle: readonly AgentLifecycleSink[];
  private readonly defaultLimits?: Partial<AgentRuntimeLimits>;

  constructor(options: AgentRuntimeOptions = {}) {
    this.tools = options.tools instanceof ToolRegistry
      ? options.tools
      : new ToolRegistry(options.tools ?? []);
    this.executionTargets = options.executionTargets instanceof ExecutionTargetRegistry
      ? options.executionTargets
      : new ExecutionTargetRegistry(options.executionTargets ?? [new LocalAgentExecutionTarget()]);
    this.permissionGate = options.permissionGate ?? new StaticToolPermissionGate();
    this.lifecycle = options.lifecycle ?? [];
    this.defaultLimits = options.limits;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const context = freezeAgentSessionContext(input.context);
    const emitter = new LifecycleEmitter(context.sessionId, this.lifecycle);
    const runLimits = limits(this.defaultLimits, input.limits);
    const turnId = randomUUID();
    const startedAt = new Date().toISOString();
    let toolCallCount = 0;
    let finalText: string | undefined;
    const messages: AgentMessage[] = [...(input.transcript ?? [])];
    const toolResults: ToolResult[] = [];

    const runningTurn = (): AgentTurn => ({
      id: turnId,
      index: input.turnIndex ?? 0,
      startedAt,
      status: 'running',
      toolCallCount
    });

    const finish = (
      status: AgentRunResult['status'],
      error?: AgentRuntimeFailure
    ): AgentRunResult => {
      const turn: AgentTurn = {
        ...runningTurn(),
        completedAt: new Date().toISOString(),
        status,
        finalText
      };
      emitter.emit({ type: 'turn.completed', turn }, turnId);
      emitter.emit({ type: 'session.completed', status, error });
      return {
        status,
        context,
        turn,
        messages: Object.freeze([...messages]),
        toolResults: Object.freeze([...toolResults]),
        finalText,
        error
      };
    };

    emitter.emit({ type: 'session.started', context });
    emitter.emit({ type: 'turn.started', turn: runningTurn() }, turnId);

    const userMessage: AgentMessage = {
      id: randomUUID(),
      role: 'user',
      content: input.userInput
    };
    messages.push(userMessage);
    emitter.emit({ type: 'user.input', message: userMessage }, turnId);

    if (
      input.provider.connectionId !== context.connection.id ||
      input.provider.modelId !== context.modelId ||
      input.provider.providerFamily !== context.connection.providerFamily
    ) {
      const error = failure(
        'provider',
        'provider_selection_mismatch',
        `Resolved adapter ${input.provider.connectionId}/${input.provider.modelId} does not match session selection ${context.connection.id}/${context.modelId}. Axis will not substitute another connection or model.`
      );
      emitter.emit({ type: 'error', error }, turnId);
      return finish('failed', error);
    }

    const missingRequired = unavailableCapabilities(context, input.requiredCapabilities ?? []);
    if (missingRequired.length > 0) {
      const error = failure('capability', 'capability_unavailable', missingRequired.join(' '));
      emitter.emit({ type: 'error', error }, turnId);
      return finish('failed', error);
    }

    let target: AgentExecutionTarget;
    try {
      target = this.executionTargets.resolve(context.executionTarget.id);
    } catch (caught) {
      const error = failure(
        'execution',
        'execution_target_unavailable',
        caught instanceof Error ? caught.message : String(caught)
      );
      emitter.emit({ type: 'error', error }, turnId);
      return finish('failed', error);
    }

    const availableTools = this.tools.list().filter((tool) => toolAvailable(context, tool.definition));
    if (input.requireToolUse && input.provider.capabilities.toolProtocol === 'none') {
      const error = failure(
        'capability',
        'provider_tool_protocol_unavailable',
        `Connection ${context.connection.id} cannot use Axis tools with model ${context.modelId}.`
      );
      emitter.emit({ type: 'error', error }, turnId);
      return finish('failed', error);
    }
    if (input.requireToolUse && availableTools.length === 0) {
      const error = failure(
        'capability',
        'no_effective_tools',
        'This session has no effective Axis tools after capability negotiation.'
      );
      emitter.emit({ type: 'error', error }, turnId);
      return finish('failed', error);
    }
    const providerTools = input.provider.capabilities.toolProtocol === 'none'
      ? []
      : availableTools.map((tool) => tool.definition);

    const emitActivity = (
      activity: ToolActivity,
      call: ToolCall,
      tool: ToolDefinition,
      status: ToolResult['status'] = 'success',
      mutationStatus: ToolResult['mutationStatus'] = tool.mutationRisk === 'none' ? 'not-applicable' : 'started'
    ): void => {
      if (activity.kind === 'read') {
        emitter.emit({
          type: 'read', callId: call.id, toolName: tool.name, status,
          detail: activity.detail, metadata: activity.metadata
        }, turnId);
      } else if (activity.kind === 'mutation') {
        emitter.emit({
          type: 'mutation', callId: call.id, toolName: tool.name, status, mutationStatus,
          detail: activity.detail, metadata: activity.metadata
        }, turnId);
      } else if (activity.kind === 'command') {
        emitter.emit({
          type: 'command', callId: call.id, toolName: tool.name, status, mutationStatus,
          detail: activity.detail, metadata: activity.metadata
        }, turnId);
      } else {
        emitter.emit({
          type: 'validation', callId: call.id, toolName: tool.name, status,
          detail: activity.detail, metadata: activity.metadata
        }, turnId);
      }
    };

    const emitFinalEffect = (tool: ToolDefinition, call: ToolCall, result: ToolResult): void => {
      if (tool.effect === 'read') {
        emitActivity({ kind: 'read' }, call, tool, result.status, result.mutationStatus);
      } else if (tool.effect === 'mutation') {
        emitActivity({ kind: 'mutation' }, call, tool, result.status, result.mutationStatus);
      } else if (tool.effect === 'command') {
        emitActivity({ kind: 'command' }, call, tool, result.status, result.mutationStatus);
      } else if (tool.effect === 'validation') {
        emitActivity({ kind: 'validation' }, call, tool, result.status, result.mutationStatus);
      }
    };

    const executeTool = async (call: ToolCall): Promise<ToolResult> => {
      const started = Date.now();
      const tool = this.tools.get(call.name);
      emitter.emit({ type: 'tool.call', call, definition: tool?.definition }, turnId);
      if (!tool) {
        const result: ToolResult = {
          callId: call.id,
          toolName: call.name,
          status: 'error',
          error: {
            kind: 'protocol',
            code: 'unknown_tool',
            message: `Tool ${call.name} is not registered in Axis.`,
            retry: 'never'
          },
          mutationStatus: 'not-applicable',
          durationMs: Date.now() - started
        };
        emitter.emit({ type: 'tool.result', result }, turnId);
        return result;
      }

      const missing = unavailableCapabilities(context, tool.definition.requiredCapabilities);
      if (missing.length > 0) {
        const result: ToolResult = {
          callId: call.id,
          toolName: call.name,
          status: 'error',
          error: {
            kind: 'capability',
            code: 'capability_unavailable',
            message: missing.join(' '),
            retry: 'never'
          },
          mutationStatus: mutationStatusOnFailure(tool.definition),
          durationMs: Date.now() - started
        };
        emitter.emit({ type: 'tool.result', result }, turnId);
        emitFinalEffect(tool.definition, call, result);
        return result;
      }

      emitter.emit({
        type: 'permission.requested',
        call,
        permissions: tool.definition.requiredPermissions
      }, turnId);
      const permission = await this.permissionGate.authorize({
        session: context,
        tool: tool.definition,
        call
      });
      emitter.emit({
        type: 'permission.resolved',
        callId: call.id,
        allowed: permission.allowed,
        reason: permission.reason
      }, turnId);
      if (!permission.allowed) {
        const result: ToolResult = {
          callId: call.id,
          toolName: call.name,
          status: 'error',
          error: {
            kind: 'permission',
            code: permission.requiresApproval ? 'permission_requires_approval' : 'permission_denied',
            message: permission.reason ?? `Tool ${call.name} is not permitted in this session.`,
            retry: 'never'
          },
          mutationStatus: mutationStatusOnFailure(tool.definition),
          durationMs: Date.now() - started
        };
        emitter.emit({ type: 'tool.result', result }, turnId);
        emitFinalEffect(tool.definition, call, result);
        return result;
      }

      const timeoutMs = tool.definition.timeoutMs ?? runLimits.toolTimeoutMs;
      const abort = requestAbortSignal(timeoutMs, input.signal);
      try {
        const output = await withCancellationSignal(abort.signal, async () => {
          throwIfCancelled(abort.signal);
          const value = await target.execute(tool, {
            session: context,
            call,
            signal: abort.signal,
            reportProgress: (progress) => emitter.emit({
              type: 'tool.progress',
              callId: call.id,
              toolName: call.name,
              progress
            }, turnId),
            reportActivity: (activity) => emitActivity(activity, call, tool.definition)
          });
          throwIfCancelled(abort.signal);
          return value;
        });
        const result: ToolResult = {
          callId: call.id,
          toolName: call.name,
          status: 'success',
          output: output.output,
          mutationStatus: mutationStatusOnSuccess(tool.definition, output),
          durationMs: Date.now() - started,
          metadata: output.metadata
        };
        emitter.emit({ type: 'tool.result', result }, turnId);
        emitFinalEffect(tool.definition, call, result);
        return result;
      } catch (caught) {
        const cancelledByCaller = callerCancelled(abort.callerSignals);
        const timedOut = !cancelledByCaller && abort.signal.aborted && isCancellationError(caught);
        const result: ToolResult = cancelledByCaller
          ? {
              callId: call.id,
              toolName: call.name,
              status: 'cancelled',
              error: {
                kind: 'cancelled',
                code: 'tool_cancelled',
                message: `Tool ${call.name} was cancelled.`,
                retry: 'never'
              },
              mutationStatus: mutationStatusOnFailure(tool.definition),
              durationMs: Date.now() - started
            }
          : timedOut
            ? {
                callId: call.id,
                toolName: call.name,
                status: 'error',
                error: {
                  kind: 'timeout',
                  code: 'tool_timeout',
                  message: `Tool ${call.name} timed out after ${timeoutMs} ms.`,
                  retry: tool.definition.mutationRisk === 'none'
                    ? tool.definition.retryOnFailure
                    : 'after-confirmation'
                },
                mutationStatus: mutationStatusOnFailure(tool.definition),
                durationMs: Date.now() - started
              }
            : {
                callId: call.id,
                toolName: call.name,
                status: 'error',
                error: {
                  kind: 'tool',
                  code: 'tool_error',
                  message: caught instanceof Error ? caught.message : String(caught),
                  retry: tool.definition.mutationRisk === 'none'
                    ? tool.definition.retryOnFailure
                    : 'after-confirmation'
                },
                mutationStatus: mutationStatusOnFailure(tool.definition),
                durationMs: Date.now() - started
              };
        emitter.emit({ type: 'tool.result', result }, turnId);
        emitFinalEffect(tool.definition, call, result);
        if (result.status === 'cancelled') {
          emitter.emit({
            type: 'cancelled', source: 'tool', callId: call.id, toolName: call.name
          }, turnId);
        } else if (result.error) {
          emitter.emit({
            type: 'error',
            error: failure(
              result.error.kind === 'timeout' ? 'timeout' : 'tool',
              result.error.code,
              result.error.message,
              result.error.retry,
              { mutationStatus: result.mutationStatus }
            ),
            callId: call.id,
            toolName: call.name
          }, turnId);
        }
        return result;
      }
    };

    for (let cycle = 0; cycle < runLimits.maxModelCycles; cycle += 1) {
      if (input.signal?.aborted) {
        const error = failure('cancelled', 'session_cancelled', 'Agent session was cancelled.');
        emitter.emit({ type: 'cancelled', source: 'caller' }, turnId);
        return finish('cancelled', error);
      }

      emitter.emit({
        type: 'provider.started',
        connectionId: context.connection.id,
        modelId: context.modelId
      }, turnId);
      const abort = requestAbortSignal(runLimits.providerTimeoutMs, input.signal);
      let response;
      try {
        response = await withCancellationSignal(abort.signal, async () => {
          throwIfCancelled(abort.signal);
          const value = await input.provider.invoke({
            context,
            turnId,
            systemPrompt: input.systemPrompt ?? '',
            messages,
            tools: providerTools,
            timeoutMs: runLimits.providerTimeoutMs
          }, {
            signal: abort.signal,
            reportProgress: (progress) => emitter.emit({ type: 'provider.progress', progress }, turnId)
          });
          throwIfCancelled(abort.signal);
          return value;
        });
      } catch (caught) {
        if (callerCancelled(abort.callerSignals)) {
          const error = failure('cancelled', 'provider_cancelled', 'Provider invocation was cancelled.');
          emitter.emit({ type: 'cancelled', source: 'provider' }, turnId);
          return finish('cancelled', error);
        }
        const error = abort.signal.aborted && isCancellationError(caught)
          ? failure(
              'timeout',
              'provider_timeout',
              `Provider ${context.connection.id} timed out after ${runLimits.providerTimeoutMs} ms.`,
              'provider'
            )
          : providerFailure(caught);
        emitter.emit({ type: 'error', error }, turnId);
        return finish('failed', error);
      }

      emitter.emit({
        type: 'provider.completed',
        stopReason: response.stopReason,
        toolCallCount: response.toolCalls.length
      }, turnId);
      const assistantMessage: AgentMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: response.text ?? '',
        toolCalls: response.toolCalls
      };
      messages.push(assistantMessage);

      if (response.toolCalls.length === 0) {
        finalText = response.text ?? '';
        return finish('completed');
      }

      for (const call of response.toolCalls) {
        toolCallCount += 1;
        if (toolCallCount > runLimits.maxToolCalls) {
          const error = failure(
            'limit',
            'tool_call_limit',
            `Agent turn exceeded the ${runLimits.maxToolCalls} tool-call limit.`
          );
          emitter.emit({ type: 'error', error }, turnId);
          return finish('failed', error);
        }
        const result = await executeTool(call);
        toolResults.push(result);
        messages.push({
          id: randomUUID(),
          role: 'tool',
          content: resultMessage(result),
          toolCallId: call.id,
          toolName: call.name
        });
        if (result.status === 'cancelled') {
          const error = failure('cancelled', 'tool_cancelled', result.error?.message ?? 'Tool was cancelled.');
          return finish('cancelled', error);
        }
      }
    }

    const error = failure(
      'limit',
      'model_cycle_limit',
      `Agent turn exceeded the ${runLimits.maxModelCycles} model-cycle limit.`
    );
    emitter.emit({ type: 'error', error }, turnId);
    return finish('failed', error);
  }
}
