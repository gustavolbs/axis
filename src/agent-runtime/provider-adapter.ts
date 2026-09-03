import { randomUUID } from 'node:crypto';

import { withCancellationSignal } from '../cancellation.js';
import type {
  InferenceProvider,
  InferenceUsage
} from '../providers/types.js';
import type {
  AgentAttachment,
  AgentDecisionRequest,
  AgentMessage,
  AgentProgress,
  AgentSessionContext,
  ToolCall,
  ToolDefinition
} from './contracts.js';

export type AgentToolProtocol = 'native' | 'structured-fallback' | 'none';

export interface AgentProviderAdapterCapabilities {
  readonly streaming: boolean;
  readonly toolProtocol: AgentToolProtocol;
}

export interface AgentProviderRequest {
  readonly context: AgentSessionContext;
  readonly turnId: string;
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly timeoutMs: number;
}

export interface AgentProviderResponse {
  readonly text?: string;
  /** Summary only; adapters must not expose raw provider chain-of-thought. */
  readonly reasoningSummary?: string;
  readonly attachments?: readonly AgentAttachment[];
  readonly toolCalls: readonly ToolCall[];
  readonly decisionRequest?: AgentDecisionRequest;
  readonly stopReason: string;
  readonly usage?: InferenceUsage;
  readonly responseId?: string;
}

export interface AgentProviderControl {
  readonly signal: AbortSignal;
  readonly reportProgress: (progress: AgentProgress) => void;
}

/**
 * Provider-specific protocols terminate here. The runtime only sees canonical
 * messages, tool definitions/calls, decision requests and progress.
 *
 * `connectionId` and `modelId` identify one exact already-resolved session
 * selection. Adapters must never choose another connection/model as fallback.
 * Provider-managed tools that execute outside Axis must be disabled or adapted
 * into canonical ToolCall/ToolResult traffic before this boundary is used.
 */
export interface AgentProviderAdapter {
  readonly connectionId: string;
  readonly providerFamily: string;
  readonly modelId: string;
  readonly capabilities: AgentProviderAdapterCapabilities;
  invoke(
    request: AgentProviderRequest,
    control: AgentProviderControl
  ): Promise<AgentProviderResponse>;
}

export class AgentProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProviderProtocolError';
  }
}

const TOOL_LOOP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['complete', 'toolCalls'],
  properties: {
    complete: { type: 'boolean' },
    text: { type: 'string' },
    reasoningSummary: { type: 'string' },
    decisionRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'prompt'],
      properties: {
        id: { type: 'string' },
        kind: { type: 'string' },
        prompt: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label'],
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' }
            }
          }
        }
      }
    },
    toolCalls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'arguments'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          arguments: { type: 'object', additionalProperties: true }
        }
      }
    }
  }
};

function canonicalToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) throw new AgentProviderProtocolError('Provider toolCalls must be an array.');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AgentProviderProtocolError(`Provider tool call ${index} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) throw new AgentProviderProtocolError(`Provider tool call ${index} has no tool name.`);
    const args = record.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new AgentProviderProtocolError(`Provider tool call ${index} arguments must be an object.`);
    }
    const rawId = typeof record.id === 'string' ? record.id.trim() : '';
    return {
      id: rawId || `tool-${randomUUID()}`,
      name,
      arguments: args as Record<string, unknown>
    };
  });
}

function canonicalDecisionRequest(value: unknown): AgentDecisionRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentProviderProtocolError('Provider decisionRequest must be an object.');
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!kind || !prompt) {
    throw new AgentProviderProtocolError('Provider decisionRequest requires kind and prompt.');
  }
  let options: AgentDecisionRequest['options'];
  if (record.options !== undefined) {
    if (!Array.isArray(record.options)) {
      throw new AgentProviderProtocolError('Provider decisionRequest options must be an array.');
    }
    options = record.options.map((option, index) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) {
        throw new AgentProviderProtocolError(`Provider decision option ${index} must be an object.`);
      }
      const candidate = option as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
      if (!id || !label) {
        throw new AgentProviderProtocolError(`Provider decision option ${index} requires id and label.`);
      }
      return {
        id,
        label,
        description: typeof candidate.description === 'string' ? candidate.description : undefined
      };
    });
  }
  const rawId = typeof record.id === 'string' ? record.id.trim() : '';
  return {
    id: rawId || `decision-${randomUUID()}`,
    kind,
    prompt,
    options
  };
}

function transcript(messages: readonly AgentMessage[]): string {
  return JSON.stringify(messages.map((message) => ({
    role: message.role,
    content: message.content,
    reasoningSummary: message.reasoningSummary,
    attachments: message.attachments,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    error: message.error,
    decisionRequest: message.decisionRequest,
    decisionResolution: message.decisionResolution
  })));
}

function structuredSystemPrompt(
  systemPrompt: string,
  tools: readonly ToolDefinition[]
): string {
  return [
    systemPrompt.trim(),
    '',
    '# AXIS AGENT RUNTIME PROTOCOL',
    'Respond only with the requested JSON object. Set complete=true when the turn is finished. Otherwise request one or more tools from the exact catalog below, or emit decisionRequest when user input/approval is required before continuing. Never invent a tool name. Tool results will be appended to the transcript and you will be invoked again.',
    'If reasoningSummary is supplied, include only a concise reasoning summary, never hidden chain-of-thought.',
    '',
    '# TOOL CATALOG',
    JSON.stringify(tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    })))
  ].join('\n');
}

/**
 * Structured-output compatibility adapter for an existing `InferenceProvider`.
 *
 * This bridge is intentionally fail-closed: callers may construct it only when
 * provider-managed tool execution has already been disabled by that provider's
 * invocation path. This is naturally true for the current direct API inference
 * providers. Subscription-account CLIs that can execute filesystem/shell/MCP
 * tools internally need a dedicated AgentProviderAdapter (or a future explicit
 * no-tools invocation mode) before they can enter the canonical Axis loop.
 *
 * That restriction prevents an apparently unified run from hiding reads,
 * commands or mutations outside Axis permission/lifecycle handling.
 */
export class InferenceProviderAgentAdapter implements AgentProviderAdapter {
  readonly connectionId: string;
  readonly providerFamily: string;
  readonly modelId: string;
  readonly capabilities: AgentProviderAdapterCapabilities;

  constructor(
    private readonly provider: InferenceProvider,
    input: {
      connectionId: string;
      providerFamily: string;
      modelId: string;
      /** Composition must prove that no provider-managed tool can execute outside Axis. */
      providerManagedToolExecution: 'disabled' | 'uncontrolled';
    }
  ) {
    if (input.providerManagedToolExecution !== 'disabled') {
      throw new AgentProviderProtocolError(
        `Connection ${input.connectionId} cannot use the generic inference bridge while provider-managed tool execution is uncontrolled. Disable hidden provider tools or implement a dedicated AgentProviderAdapter.`
      );
    }
    this.connectionId = input.connectionId;
    this.providerFamily = input.providerFamily;
    this.modelId = input.modelId;
    this.capabilities = Object.freeze({
      streaming: provider.capabilities.streaming,
      toolProtocol: provider.capabilities.structuredOutput ? 'structured-fallback' : 'none'
    });
  }

  async invoke(
    request: AgentProviderRequest,
    control: AgentProviderControl
  ): Promise<AgentProviderResponse> {
    if (request.context.connection.id !== this.connectionId) {
      throw new AgentProviderProtocolError(
        `Adapter connection ${this.connectionId} does not match session connection ${request.context.connection.id}.`
      );
    }
    if (request.context.modelId !== this.modelId) {
      throw new AgentProviderProtocolError(
        `Adapter model ${this.modelId} does not match session model ${request.context.modelId}.`
      );
    }

    const usesTools = request.tools.length > 0;
    if (usesTools && this.capabilities.toolProtocol === 'none') {
      throw new AgentProviderProtocolError(
        `Connection ${this.connectionId} cannot participate in the Axis tool loop because structured tool output is unavailable.`
      );
    }

    const result = await withCancellationSignal(control.signal, async () => await this.provider.invoke({
      model: this.modelId,
      systemPrompt: usesTools
        ? structuredSystemPrompt(request.systemPrompt, request.tools)
        : request.systemPrompt,
      userPrompt: usesTools ? transcript(request.messages) : request.messages.at(-1)?.content ?? '',
      stage: 'agent-runtime',
      output: usesTools
        ? { type: 'json_schema', schema: TOOL_LOOP_SCHEMA, name: 'axis_agent_turn', strict: true }
        : { type: 'text' },
      timeoutMs: request.timeoutMs,
      onProgress: (progress) => control.reportProgress({
        phase: 'provider',
        state: progress.state,
        completed: progress.outputChars,
        metadata: {
          providerId: progress.providerId,
          model: progress.model,
          eventCount: progress.eventCount,
          timestamp: progress.timestamp
        }
      })
    }));

    if (!usesTools) {
      return {
        text: result.content,
        toolCalls: [],
        stopReason: result.stopReason ?? 'complete',
        usage: result.usage,
        responseId: result.responseId
      };
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(result.content);
    } catch (error) {
      throw new AgentProviderProtocolError(
        `Connection ${this.connectionId} returned invalid structured tool output: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new AgentProviderProtocolError('Provider structured tool output must be an object.');
    }
    const record = envelope as Record<string, unknown>;
    if (typeof record.complete !== 'boolean') {
      throw new AgentProviderProtocolError('Provider structured tool output must contain boolean complete.');
    }
    const toolCalls = canonicalToolCalls(record.toolCalls);
    const decisionRequest = canonicalDecisionRequest(record.decisionRequest);
    if (!record.complete && toolCalls.length === 0 && !decisionRequest) {
      throw new AgentProviderProtocolError('Provider requested continuation without tool calls or a decision request.');
    }
    if (record.complete && (toolCalls.length > 0 || decisionRequest)) {
      throw new AgentProviderProtocolError('Provider marked the turn complete while also requesting tools or a decision.');
    }
    if (toolCalls.length > 0 && decisionRequest) {
      throw new AgentProviderProtocolError('Provider cannot request tools and a user decision in the same canonical cycle.');
    }
    const text = typeof record.text === 'string' ? record.text : undefined;
    const reasoningSummary = typeof record.reasoningSummary === 'string'
      ? record.reasoningSummary.trim() || undefined
      : undefined;
    return {
      text,
      reasoningSummary,
      toolCalls,
      decisionRequest,
      stopReason: decisionRequest ? 'decision_required' : record.complete ? result.stopReason ?? 'complete' : 'tool_calls',
      usage: result.usage,
      responseId: result.responseId
    };
  }
}
