import {
  AgentProviderProtocolError,
  InferenceProviderAgentAdapter,
  type AgentProviderAdapter,
  type AgentProviderAdapterCapabilities,
  type AgentProviderControl,
  type AgentProviderRequest,
  type AgentProviderResponse
} from '../agent-runtime/index.js';
import type { InferenceProvider } from '../providers/types.js';
import {
  assertExpectedProviderFamily,
  assertProviderBinding,
  assertVisibleToolCalls,
  normalizeProviderBinding,
  type AgentProviderBinding
} from './common.js';

const ANTHROPIC_AGENT_TURN_SCHEMA_NAME = 'axis_agent_turn';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneSchema(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneSchema(child)])
  );
}

function closeAnthropicObjectSchemas(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => closeAnthropicObjectSchemas(item));
  if (!isRecord(value)) return value;

  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, closeAnthropicObjectSchemas(child)])
  ) as Record<string, unknown>;
  if (result.type === 'object') result.additionalProperties = false;
  return result;
}

/**
 * Anthropic structured outputs require every object schema to be closed. Older
 * Axis agent envelopes exposed tool arguments as an open object; newer strict
 * envelopes already encode them as JSON text for all providers. Accept both
 * shapes here so the Anthropic compatibility boundary remains forward-compatible
 * while preserving canonical arbitrary tool arguments.
 */
function anthropicAgentTurnSchema(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const cloned = cloneSchema(schema);
  if (!isRecord(cloned)) {
    throw new AgentProviderProtocolError('Axis agent turn schema must be an object.');
  }

  const properties = isRecord(cloned.properties) ? cloned.properties : undefined;
  const toolCalls = properties && isRecord(properties.toolCalls) ? properties.toolCalls : undefined;
  const items = toolCalls && isRecord(toolCalls.items) ? toolCalls.items : undefined;
  const itemProperties = items && isRecord(items.properties) ? items.properties : undefined;
  const argumentsSchema = itemProperties && isRecord(itemProperties.arguments)
    ? itemProperties.arguments
    : undefined;

  const alreadyJsonEncoded = argumentsSchema?.type === 'string';
  const legacyOpenObject = argumentsSchema?.type === 'object' && argumentsSchema.additionalProperties === true;
  if (!argumentsSchema || (!alreadyJsonEncoded && !legacyOpenObject)) {
    throw new AgentProviderProtocolError(
      'Axis agent turn schema exposes tool arguments in an unsupported shape.'
    );
  }

  if (legacyOpenObject) {
    itemProperties!.arguments = {
      type: 'string',
      description: 'JSON-encoded object containing the exact arguments for the selected Axis tool.'
    };
  }

  return closeAnthropicObjectSchemas(cloned) as Record<string, unknown>;
}

function restoreAnthropicAgentTurnContent(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return content;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.toolCalls)) return content;

  for (const [index, rawCall] of parsed.toolCalls.entries()) {
    if (!isRecord(rawCall) || typeof rawCall.arguments !== 'string') continue;

    let decoded: unknown;
    try {
      decoded = JSON.parse(rawCall.arguments) as unknown;
    } catch (error) {
      throw new AgentProviderProtocolError(
        `Anthropic structured tool call ${index} returned invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isRecord(decoded)) {
      throw new AgentProviderProtocolError(
        `Anthropic structured tool call ${index} arguments must decode to an object.`
      );
    }
    rawCall.arguments = decoded;
  }

  return JSON.stringify(parsed);
}

/** Provider wrapper that terminates the Anthropic-only structured-output wire quirk. */
class AnthropicAgentInferenceProvider implements InferenceProvider {
  readonly id: string;
  readonly kind: InferenceProvider['kind'];
  readonly capabilities: InferenceProvider['capabilities'];

  constructor(private readonly delegate: InferenceProvider) {
    this.id = delegate.id;
    this.kind = delegate.kind;
    this.capabilities = delegate.capabilities;
  }

  listModels() {
    return this.delegate.listModels();
  }

  health() {
    return this.delegate.health();
  }

  async invoke(request: Parameters<InferenceProvider['invoke']>[0]) {
    if (
      request.output?.type !== 'json_schema' ||
      request.output.name !== ANTHROPIC_AGENT_TURN_SCHEMA_NAME
    ) {
      return await this.delegate.invoke(request);
    }

    const result = await this.delegate.invoke({
      ...request,
      systemPrompt: [
        request.systemPrompt,
        '',
        '# ANTHROPIC STRUCTURED OUTPUT COMPATIBILITY',
        'For each tool call, encode toolCalls[].arguments as a JSON object serialized into a string. Axis will decode it before tool dispatch.'
      ].join('\n'),
      output: {
        ...request.output,
        schema: anthropicAgentTurnSchema(request.output.schema)
      }
    });

    return {
      ...result,
      content: restoreAnthropicAgentTurnContent(result.content)
    };
  }
}

/**
 * Hardened adapter for inference providers whose current invoke protocol cannot
 * execute provider-managed filesystem/shell/MCP tools at all. The underlying
 * generic bridge supplies the structured Axis tool envelope; this wrapper adds
 * exact provider-family/Company binding and rejects hidden tool calls.
 */
export class DirectInferenceAgentAdapter implements AgentProviderAdapter {
  readonly connectionId: string;
  readonly providerFamily: string;
  readonly modelId: string;
  readonly capabilities: AgentProviderAdapterCapabilities;

  private readonly binding: AgentProviderBinding;
  private readonly delegate: InferenceProviderAgentAdapter;

  constructor(
    provider: InferenceProvider,
    binding: AgentProviderBinding
  ) {
    this.binding = normalizeProviderBinding(binding);
    this.connectionId = this.binding.connectionId;
    this.providerFamily = this.binding.providerFamily;
    this.modelId = this.binding.modelId;
    this.delegate = new InferenceProviderAgentAdapter(provider, {
      connectionId: this.connectionId,
      providerFamily: this.providerFamily,
      modelId: this.modelId,
      providerManagedToolExecution: 'disabled'
    });
    this.capabilities = this.delegate.capabilities;
  }

  async invoke(
    request: AgentProviderRequest,
    control: AgentProviderControl
  ): Promise<AgentProviderResponse> {
    assertProviderBinding(this.binding, request);
    const response = await this.delegate.invoke(request, control);
    assertVisibleToolCalls(request, response);
    return response;
  }
}

function assertProviderIdentity(
  provider: InferenceProvider,
  binding: AgentProviderBinding,
  expectedFamily: string
): void {
  if (provider.id !== expectedFamily && provider.id !== binding.connectionId) {
    throw new AgentProviderProtocolError(
      `Expected ${expectedFamily} provider or resolved connection alias ${binding.connectionId}, received ${provider.id}.`
    );
  }
}

/** OpenAI API-key connections use the same canonical adapter contract as Accounts. */
export function createOpenAiApiKeyAgentAdapter(
  provider: InferenceProvider,
  binding: AgentProviderBinding
): DirectInferenceAgentAdapter {
  assertExpectedProviderFamily(binding, 'openai');
  assertProviderIdentity(provider, binding, 'openai');
  return new DirectInferenceAgentAdapter(provider, binding);
}

/**
 * Anthropic API-key connections keep the canonical Axis contract while adapting
 * the agent envelope to Anthropic's closed structured-output requirements.
 */
export function createAnthropicApiKeyAgentAdapter(
  provider: InferenceProvider,
  binding: AgentProviderBinding
): DirectInferenceAgentAdapter {
  assertExpectedProviderFamily(binding, 'anthropic');
  assertProviderIdentity(provider, binding, 'anthropic');
  return new DirectInferenceAgentAdapter(
    new AnthropicAgentInferenceProvider(provider),
    binding
  );
}

/**
 * Ollama exposes no provider-managed tool execution in its current Axis
 * inference path; tool requests, when structured output is available, are only
 * descriptions consumed by the canonical Axis runtime.
 */
export function createOllamaAgentAdapter(
  provider: InferenceProvider,
  binding: AgentProviderBinding
): DirectInferenceAgentAdapter {
  assertExpectedProviderFamily(binding, 'ollama');
  assertProviderIdentity(provider, binding, 'ollama');
  if (binding.companyId !== undefined && binding.companyId !== null) {
    throw new AgentProviderProtocolError('Ollama is a shared local connection and must use companyId=null.');
  }
  return new DirectInferenceAgentAdapter(provider, binding);
}
