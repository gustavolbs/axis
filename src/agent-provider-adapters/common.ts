import {
  AgentProviderProtocolError,
  providerModelCapabilityOffer,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type CapabilityOffer,
  type ToolCall
} from '../agent-runtime/index.js';
import type {
  ModelDefinition,
  ProviderCapabilities
} from '../providers/types.js';

/** Exact already-resolved identity owned by one AgentProviderAdapter instance. */
export interface AgentProviderBinding {
  readonly connectionId: string;
  readonly providerFamily: string;
  readonly modelId: string;
  /**
   * Canonical owner of this connection. `null` is reserved for intentionally
   * shared local inference. Omit only when the composition layer cannot yet
   * provide ownership metadata; the AgentRuntime session guard still applies.
   */
  readonly companyId?: string | null;
}

function required(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new AgentProviderProtocolError(`${label} must not be empty.`);
  return clean;
}

export function normalizeProviderBinding(binding: AgentProviderBinding): AgentProviderBinding {
  return Object.freeze({
    connectionId: required(binding.connectionId, 'Adapter connection id'),
    providerFamily: required(binding.providerFamily, 'Adapter provider family'),
    modelId: required(binding.modelId, 'Adapter model id'),
    companyId: binding.companyId
  });
}

/**
 * Defend the provider boundary even when an adapter is invoked outside the
 * normal AgentRuntime composition path. No connection/model/family/Company
 * substitution is allowed here.
 */
export function assertProviderBinding(
  binding: AgentProviderBinding,
  request: AgentProviderRequest
): void {
  const context = request.context;
  if (context.connection.id !== binding.connectionId) {
    throw new AgentProviderProtocolError(
      `Adapter connection ${binding.connectionId} does not match session connection ${context.connection.id}.`
    );
  }
  if (context.connection.providerFamily !== binding.providerFamily) {
    throw new AgentProviderProtocolError(
      `Adapter provider family ${binding.providerFamily} does not match session provider family ${context.connection.providerFamily}.`
    );
  }
  if (context.modelId !== binding.modelId) {
    throw new AgentProviderProtocolError(
      `Adapter model ${binding.modelId} does not match session model ${context.modelId}.`
    );
  }
  if (binding.companyId !== undefined && context.connection.companyId !== binding.companyId) {
    throw new AgentProviderProtocolError(
      `Adapter connection ${binding.connectionId} belongs to Company ${binding.companyId ?? '(shared local)'}, not session connection Company ${context.connection.companyId ?? '(shared local)'}.`
    );
  }
}

/**
 * A provider may request only tools Axis exposed for this exact model cycle.
 * This closes a gap where structured provider output could otherwise name a
 * hidden/unavailable tool and rely on later dispatch to reject it.
 */
export function assertVisibleToolCalls(
  request: AgentProviderRequest,
  response: Pick<AgentProviderResponse, 'toolCalls'>
): void {
  const visible = new Set(request.tools.map((tool) => tool.name));
  const ids = new Set<string>();
  for (const call of response.toolCalls) {
    if (!visible.has(call.name)) {
      throw new AgentProviderProtocolError(
        `Connection ${request.context.connection.id} requested hidden or unavailable Axis tool ${call.name}.`
      );
    }
    if (ids.has(call.id)) {
      throw new AgentProviderProtocolError(`Provider returned duplicate tool call id ${call.id}.`);
    }
    ids.add(call.id);
  }
}

export function assertExpectedProviderFamily(
  binding: AgentProviderBinding,
  expected: string
): void {
  if (binding.providerFamily !== expected) {
    throw new AgentProviderProtocolError(
      `Adapter for ${expected} cannot bind provider family ${binding.providerFamily}.`
    );
  }
}

/** Use only the frozen provider capability taxonomy owned by AgentRuntime. */
export function providerCapabilityOffer(
  binding: AgentProviderBinding,
  capabilities: ProviderCapabilities,
  model?: Pick<ModelDefinition, 'capabilities'>
): CapabilityOffer {
  return providerModelCapabilityOffer(
    `provider:${binding.connectionId}/model:${binding.modelId}`,
    capabilities,
    model
  );
}

function canonicalArguments(value: unknown, index: number): Record<string, unknown> {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch (error) {
      throw new AgentProviderProtocolError(
        `Provider tool call ${index} arguments must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AgentProviderProtocolError(`Provider tool call ${index} arguments must decode to an object.`);
  }
  return candidate as Record<string, unknown>;
}

export function canonicalToolCall(
  item: unknown,
  index: number,
  idFactory: () => string
): ToolCall {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new AgentProviderProtocolError(`Provider tool call ${index} must be an object.`);
  }
  const record = item as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) throw new AgentProviderProtocolError(`Provider tool call ${index} has no tool name.`);
  const rawId = typeof record.id === 'string' ? record.id.trim() : '';
  return {
    id: rawId || idFactory(),
    name,
    arguments: canonicalArguments(record.arguments, index)
  };
}
