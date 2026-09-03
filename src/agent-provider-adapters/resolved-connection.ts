import { AgentProviderProtocolError, type AgentProviderAdapter } from '../agent-runtime/index.js';
import { ClaudeAccountProfileStore } from '../claude-account-profiles.js';
import type { ProviderConnectionView } from '../provider-connections.js';
import type { InferenceProvider } from '../providers/types.js';
import { createChatGptAccountAgentAdapter } from './chatgpt-account.js';
import { ClaudeAccountAgentAdapter } from './claude-account.js';
import type { AgentProviderBinding } from './common.js';
import {
  createAnthropicApiKeyAgentAdapter,
  createOllamaAgentAdapter,
  createOpenAiApiKeyAgentAdapter
} from './inference-provider.js';

export interface ResolvedConnectionAgentAdapterInput {
  /** Existing Axis connection selected for this exact session. */
  readonly connection: ProviderConnectionView;
  readonly modelId: string;
  /** Canonical Company owner already resolved by session composition. */
  readonly companyId: string | null;
  /** Required for local/API-key connections; ignored for Account transports. */
  readonly provider?: InferenceProvider;
  /** Required for Claude Account so its exact isolated profile can be reused. */
  readonly claudeProfiles?: ClaudeAccountProfileStore;
  readonly claudeBinary?: string;
  readonly claudeCommandPrefixArgs?: readonly string[];
  readonly baseEnv?: NodeJS.ProcessEnv;
}

function binding(input: ResolvedConnectionAgentAdapterInput): AgentProviderBinding {
  return {
    connectionId: input.connection.id,
    providerFamily: input.connection.providerFamily,
    modelId: input.modelId,
    companyId: input.companyId
  };
}

function provider(input: ResolvedConnectionAgentAdapterInput): InferenceProvider {
  if (!input.provider) {
    throw new AgentProviderProtocolError(
      `Connection ${input.connection.id} requires its exact resolved inference provider.`
    );
  }
  return input.provider;
}

/**
 * Bridge existing ProviderConnectionRuntime selections into one canonical
 * AgentProviderAdapter contract. `auth` chooses transport only; it never
 * changes the AgentRuntime or Axis tool contract.
 */
export function createAgentProviderAdapterForConnection(
  input: ResolvedConnectionAgentAdapterInput
): AgentProviderAdapter {
  if (!input.connection.available) {
    throw new AgentProviderProtocolError(
      input.connection.reason ?? `Provider connection ${input.connection.id} is unavailable.`
    );
  }
  const exactBinding = binding(input);

  if (input.connection.auth === 'local') {
    if (input.connection.providerFamily !== 'ollama') {
      throw new AgentProviderProtocolError(
        `Local connection ${input.connection.id} uses unsupported provider family ${input.connection.providerFamily}.`
      );
    }
    return createOllamaAgentAdapter(provider(input), exactBinding);
  }

  if (input.connection.auth === 'api-key') {
    if (input.connection.providerFamily === 'openai') {
      return createOpenAiApiKeyAgentAdapter(provider(input), exactBinding);
    }
    if (input.connection.providerFamily === 'anthropic') {
      return createAnthropicApiKeyAgentAdapter(provider(input), exactBinding);
    }
    throw new AgentProviderProtocolError(
      `API-key connection ${input.connection.id} uses unsupported provider family ${input.connection.providerFamily}.`
    );
  }

  if (input.connection.auth === 'claude-account') {
    if (input.connection.providerFamily !== 'anthropic') {
      throw new AgentProviderProtocolError(
        `Claude Account connection ${input.connection.id} must use provider family anthropic.`
      );
    }
    const profileId = input.connection.accountProfileId?.trim();
    if (!profileId || !input.claudeProfiles) {
      throw new AgentProviderProtocolError(
        `Claude Account connection ${input.connection.id} requires its exact account profile store and profile id.`
      );
    }
    return new ClaudeAccountAgentAdapter({
      profiles: input.claudeProfiles,
      profileId,
      binding: exactBinding,
      claudeBinary: input.claudeBinary,
      commandPrefixArgs: input.claudeCommandPrefixArgs,
      baseEnv: input.baseEnv
    });
  }

  if (input.connection.auth === 'chatgpt-account') {
    return createChatGptAccountAgentAdapter();
  }

  throw new AgentProviderProtocolError(
    `Unsupported provider connection auth kind: ${String(input.connection.auth)}.`
  );
}
