import { randomUUID } from 'node:crypto';

import {
  AgentProviderProtocolError,
  type AgentDecisionRequest,
  type AgentMessage,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type ToolDefinition
} from '../agent-runtime/index.js';
import type { InferenceUsage } from '../providers/types.js';
import { assertVisibleToolCalls, canonicalToolCall } from './common.js';

/** Provider-neutral structured envelope used by native Account adapters. */
export const AXIS_AGENT_TURN_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
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
});

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

function toolCatalog(tools: readonly ToolDefinition[]): string {
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  })));
}

/**
 * Account CLIs receive one model-only prompt. They are instructed to describe
 * Axis tool calls in JSON; the CLI itself must run with its own tools disabled.
 */
export function buildStructuredAgentPrompt(request: AgentProviderRequest): string {
  return [
    request.systemPrompt.trim(),
    '',
    '# AXIS AGENT RUNTIME PROTOCOL',
    'Return only the JSON object required by the supplied schema.',
    'Set complete=true only when this turn is finished.',
    'If work requires a tool, set complete=false and request only tools from the exact TOOL CATALOG below. Do not execute, simulate, substitute, or invent any filesystem, shell, browser, MCP, plugin, skill, or other provider-managed tool.',
    'Tool results appear later in TRANSCRIPT as role=tool messages. Use those results on the next invocation.',
    'If user input or approval is required before continuing, emit decisionRequest instead of a tool call.',
    'If reasoningSummary is supplied, include only a concise summary; never expose hidden chain-of-thought.',
    '',
    '# TOOL CATALOG',
    toolCatalog(request.tools),
    '',
    '# TRANSCRIPT',
    transcript(request.messages)
  ].join('\n');
}

function decisionRequest(value: unknown): AgentDecisionRequest | undefined {
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
        description: typeof candidate.description === 'string'
          ? candidate.description
          : undefined
      };
    });
  }

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  return {
    id: id || `decision-${randomUUID()}`,
    kind,
    prompt,
    options
  };
}

export interface StructuredAgentResponseMetadata {
  readonly usage?: InferenceUsage;
  readonly responseId?: string;
  readonly providerStopReason?: string;
}

export function parseStructuredAgentResponse(
  request: AgentProviderRequest,
  content: string,
  metadata: StructuredAgentResponseMetadata = {}
): AgentProviderResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new AgentProviderProtocolError(
      `Connection ${request.context.connection.id} returned invalid structured agent output: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentProviderProtocolError('Provider structured agent output must be an object.');
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.complete !== 'boolean') {
    throw new AgentProviderProtocolError('Provider structured agent output must contain boolean complete.');
  }
  if (!Array.isArray(record.toolCalls)) {
    throw new AgentProviderProtocolError('Provider structured agent output must contain toolCalls array.');
  }

  const toolCalls = record.toolCalls.map((call, index) =>
    canonicalToolCall(call, index, () => `tool-${randomUUID()}`)
  );
  const requestedDecision = decisionRequest(record.decisionRequest);
  if (!record.complete && toolCalls.length === 0 && !requestedDecision) {
    throw new AgentProviderProtocolError(
      'Provider requested continuation without tool calls or a decision request.'
    );
  }
  if (record.complete && (toolCalls.length > 0 || requestedDecision)) {
    throw new AgentProviderProtocolError(
      'Provider marked the turn complete while also requesting tools or a decision.'
    );
  }
  if (toolCalls.length > 0 && requestedDecision) {
    throw new AgentProviderProtocolError(
      'Provider cannot request tools and a user decision in the same canonical cycle.'
    );
  }

  const response: AgentProviderResponse = {
    text: typeof record.text === 'string' ? record.text : undefined,
    reasoningSummary: typeof record.reasoningSummary === 'string'
      ? record.reasoningSummary.trim() || undefined
      : undefined,
    toolCalls,
    decisionRequest: requestedDecision,
    stopReason: requestedDecision
      ? 'decision_required'
      : record.complete
        ? metadata.providerStopReason ?? 'complete'
        : 'tool_calls',
    usage: metadata.usage,
    responseId: metadata.responseId
  };
  assertVisibleToolCalls(request, response);
  return response;
}
