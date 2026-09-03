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

/** Anthropic API-key connections use the same canonical adapter contract as Accounts. */
export function createAnthropicApiKeyAgentAdapter(
  provider: InferenceProvider,
  binding: AgentProviderBinding
): DirectInferenceAgentAdapter {
  assertExpectedProviderFamily(binding, 'anthropic');
  assertProviderIdentity(provider, binding, 'anthropic');
  return new DirectInferenceAgentAdapter(provider, binding);
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
