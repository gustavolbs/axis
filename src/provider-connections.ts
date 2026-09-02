import { createHash } from 'node:crypto';

import { ClaudeAccountProfileStore, ClaudeAccountRuntime } from './claude-account-profiles.js';
import { CodexAccountProfileStore, CodexAccountRuntime } from './codex-account-profiles.js';
import { CredentialManager, type CredentialProfile } from './credential-store.js';
import { ProviderBudgetManager } from './provider-budget.js';
import { ProviderCapabilityPolicyManager } from './provider-capability-policy.js';
import { ProviderSettingsStore } from './provider-settings.js';
import { AnthropicInferenceProvider } from './providers/anthropic-provider.js';
import { withSafeModelLimits } from './providers/model-limits.js';
import { OpenAIInferenceProvider } from './providers/openai-provider.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth
} from './providers/types.js';

export type ProviderConnectionAuth = 'local' | 'api-key' | 'claude-account' | 'chatgpt-account';
export type ProviderConnectionBilling = 'local' | 'api' | 'subscription';

export interface ProviderConnectionView {
  id: string;
  providerFamily: 'ollama' | 'anthropic' | 'openai';
  label: string;
  auth: ProviderConnectionAuth;
  billing: ProviderConnectionBilling;
  organizationId?: string;
  organizationLabel?: string;
  credentialId?: string;
  accountProfileId?: string;
  available: boolean;
  reason?: string;
  supportsMcpSources: boolean;
}

export interface ProviderConnectionRuntimeOptions {
  localProvider?: InferenceProvider;
  credentials?: CredentialManager;
  settings?: ProviderSettingsStore;
  budget?: ProviderBudgetManager;
  capabilityPolicy?: ProviderCapabilityPolicyManager;
  claudeProfiles?: ClaudeAccountProfileStore;
  claudeRuntime?: ClaudeAccountRuntime;
  codexProfiles?: CodexAccountProfileStore;
  codexRuntime?: CodexAccountRuntime;
}

const ACCOUNT_CAPABILITIES: ProviderCapabilities = {
  modelDiscovery: false,
  streaming: false,
  structuredOutput: false,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

function stableSuffix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function apiCredentialConnectionId(providerId: string, credentialId: string): string {
  return `${providerId}-api-${stableSuffix(`${providerId}\0${credentialId}`)}`;
}

export function claudeAccountConnectionId(profileId: string): string {
  return `claude-account-${stableSuffix(profileId)}`;
}

export function chatGptAccountConnectionId(profileId: string): string {
  return `chatgpt-account-${stableSuffix(profileId)}`;
}

function accountPrompt(request: InferenceRequest): string {
  return [
    '# SYSTEM INSTRUCTIONS',
    request.systemPrompt.trim(),
    '',
    '# USER MESSAGE',
    request.userPrompt.trim(),
    '',
    '# EXECUTION BOUNDARY',
    'This is an ordinary Local Coder chat turn. Do not call MCP servers, connectors, plugins, shell commands, files, or other external tools. Answer from the conversation/model context only.'
  ].join('\n');
}

function accountModel(providerId: string, family: 'anthropic' | 'openai', label: string): ModelDefinition {
  return {
    providerId,
    id: 'default',
    displayName: label,
    capabilities: ACCOUNT_CAPABILITIES,
    metadata: {
      connectionAuth: family === 'anthropic' ? 'claude-account' : 'chatgpt-account',
      accountManagedModel: true
    }
  };
}

function aliasProvider(aliasId: string, inner: InferenceProvider): InferenceProvider {
  return {
    id: aliasId,
    kind: inner.kind,
    capabilities: inner.capabilities,
    async listModels() {
      return (await inner.listModels()).map((model) => ({ ...model, providerId: aliasId }));
    },
    async health() {
      const health = await inner.health();
      return { ...health, providerId: aliasId };
    },
    async invoke(request) {
      const result = await inner.invoke(request);
      return { ...result, providerId: aliasId };
    }
  };
}

class ClaudeAccountInferenceProvider implements InferenceProvider {
  readonly kind = 'cloud' as const;
  readonly capabilities = ACCOUNT_CAPABILITIES;
  constructor(
    readonly id: string,
    private readonly profileId: string,
    private readonly label: string,
    private readonly runtime: ClaudeAccountRuntime
  ) {}

  async listModels(): Promise<ModelDefinition[]> {
    const status = await this.runtime.status(this.profileId);
    return status.authenticated ? [accountModel(this.id, 'anthropic', `${this.label} · account default`)] : [];
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    const status = await this.runtime.status(this.profileId);
    return {
      providerId: this.id,
      ok: status.authenticated,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      modelsAvailable: status.authenticated ? 1 : 0,
      message: status.authenticated ? undefined : status.error ?? 'Claude account is not authenticated.'
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    if (request.capabilityRequests?.length) {
      throw new Error('Claude account chat does not allow external capabilities. Use a configured Work Hub source for MCP data.');
    }
    if (request.output?.type === 'json_schema') {
      throw new Error('Structured output is not exposed by the Claude account chat adapter.');
    }
    const started = Date.now();
    const result = await this.runtime.invoke(this.profileId, accountPrompt(request), {
      timeoutMs: request.timeoutMs
    });
    if (result.cancelled) throw new Error('Claude account invocation was cancelled.');
    if (result.timedOut) throw new Error('Claude account invocation timed out.');
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Claude account invocation failed.');
    return {
      providerId: this.id,
      model: request.model,
      content: result.stdout,
      latencyMs: Date.now() - started,
      usage: {}
    };
  }
}

class ChatGptAccountInferenceProvider implements InferenceProvider {
  readonly kind = 'cloud' as const;
  readonly capabilities = ACCOUNT_CAPABILITIES;
  constructor(
    readonly id: string,
    private readonly profileId: string,
    private readonly label: string,
    private readonly runtime: CodexAccountRuntime
  ) {}

  async listModels(): Promise<ModelDefinition[]> {
    const status = await this.runtime.status(this.profileId);
    return status.authenticated ? [accountModel(this.id, 'openai', `${this.label} · account default`)] : [];
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    const status = await this.runtime.status(this.profileId);
    return {
      providerId: this.id,
      ok: status.authenticated,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      modelsAvailable: status.authenticated ? 1 : 0,
      message: status.authenticated ? undefined : status.error ?? 'ChatGPT/Codex account is not authenticated.'
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    if (request.capabilityRequests?.length) {
      throw new Error('ChatGPT account chat does not allow external capabilities. Use a configured Work Hub source for MCP data.');
    }
    if (request.output?.type === 'json_schema') {
      throw new Error('Structured output is not exposed by the ChatGPT account chat adapter.');
    }
    const started = Date.now();
    const result = await this.runtime.invoke(this.profileId, accountPrompt(request), {
      timeoutMs: request.timeoutMs,
      model: request.model
    });
    if (result.cancelled) throw new Error('ChatGPT account invocation was cancelled.');
    if (result.timedOut) throw new Error('ChatGPT account invocation timed out.');
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'ChatGPT account invocation failed.');
    return {
      providerId: this.id,
      model: request.model,
      content: result.stdout,
      latencyMs: Date.now() - started,
      usage: {}
    };
  }
}

function credentialAvailability(manager: CredentialManager, credential: CredentialProfile): { available: boolean; reason?: string } {
  try {
    return manager.resolve(credential.id)
      ? { available: true }
      : { available: false, reason: 'Credential secret is unavailable.' };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * First-class connection instances. A provider family can have many connection identities:
 * API credentials, subscription accounts and a local runtime. Chat selects an instance,
 * never an ambiguous provider family. Account credentials remain opaque to Local Coder.
 */
export class ProviderConnectionRuntime {
  private readonly localProvider?: InferenceProvider;
  private readonly credentials: CredentialManager;
  private readonly settings: ProviderSettingsStore;
  private readonly budget: ProviderBudgetManager;
  private readonly capabilities: ProviderCapabilityPolicyManager;
  private readonly claudeProfiles: ClaudeAccountProfileStore;
  private readonly claudeRuntime: ClaudeAccountRuntime;
  private readonly codexProfiles: CodexAccountProfileStore;
  private readonly codexRuntime: CodexAccountRuntime;

  constructor(options: ProviderConnectionRuntimeOptions = {}) {
    this.localProvider = options.localProvider;
    this.credentials = options.credentials ?? new CredentialManager();
    this.settings = options.settings ?? new ProviderSettingsStore();
    this.budget = options.budget ?? new ProviderBudgetManager({ settings: this.settings });
    this.capabilities = options.capabilityPolicy ?? new ProviderCapabilityPolicyManager(this.settings);
    this.claudeProfiles = options.claudeProfiles ?? new ClaudeAccountProfileStore();
    this.claudeRuntime = options.claudeRuntime ?? new ClaudeAccountRuntime(this.claudeProfiles);
    this.codexProfiles = options.codexProfiles ?? new CodexAccountProfileStore();
    this.codexRuntime = options.codexRuntime ?? new CodexAccountRuntime(this.codexProfiles);
  }

  list(): ProviderConnectionView[] {
    const views: ProviderConnectionView[] = [];
    if (this.localProvider) {
      const enabled = this.settings.get(this.localProvider.id)?.enabled !== false;
      views.push({
        id: this.localProvider.id,
        providerFamily: 'ollama',
        label: 'Ollama local',
        auth: 'local',
        billing: 'local',
        available: enabled,
        reason: enabled ? undefined : 'Ollama is disabled in Model routing.',
        supportsMcpSources: false
      });
    }

    for (const credential of this.credentials.list()) {
      if (credential.providerId !== 'openai' && credential.providerId !== 'anthropic') continue;
      const availability = credentialAvailability(this.credentials, credential);
      views.push({
        id: apiCredentialConnectionId(credential.providerId, credential.id),
        providerFamily: credential.providerId,
        label: `${credential.providerId === 'openai' ? 'GPT' : 'Claude'} · ${credential.label}`,
        auth: 'api-key',
        billing: 'api',
        organizationId: credential.organizationId,
        credentialId: credential.id,
        available: availability.available,
        reason: availability.reason,
        supportsMcpSources: false
      });
    }

    for (const profile of this.claudeProfiles.list()) {
      views.push({
        id: claudeAccountConnectionId(profile.id),
        providerFamily: 'anthropic',
        label: `Claude · ${profile.name}`,
        auth: 'claude-account',
        billing: 'subscription',
        organizationLabel: profile.organizationLabel,
        accountProfileId: profile.id,
        available: true,
        supportsMcpSources: true
      });
    }

    for (const profile of this.codexProfiles.list()) {
      views.push({
        id: chatGptAccountConnectionId(profile.id),
        providerFamily: 'openai',
        label: `GPT · ${profile.name}`,
        auth: 'chatgpt-account',
        billing: 'subscription',
        organizationLabel: profile.organizationLabel,
        accountProfileId: profile.id,
        available: true,
        supportsMcpSources: true
      });
    }

    return views.sort((left, right) => left.label.localeCompare(right.label));
  }

  handles(connectionId: string): boolean {
    return this.list().some((view) => view.id === connectionId && view.id !== this.localProvider?.id);
  }

  view(connectionId: string): ProviderConnectionView | undefined {
    return this.list().find((view) => view.id === connectionId);
  }

  async resolve(connectionId: string, modelId: string): Promise<{ provider: InferenceProvider; model: ModelDefinition }> {
    const view = this.view(connectionId);
    if (!view || view.id === this.localProvider?.id) throw new Error(`Unknown provider connection: ${connectionId}`);
    if (!view.available) throw new Error(view.reason ?? `Provider connection ${connectionId} is unavailable.`);
    const provider = this.provider(view);
    const models = await provider.listModels();
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Model ${modelId} is not available through ${view.label}.`);
    return { provider, model };
  }

  async catalogProviders(): Promise<Array<{
    id: string;
    kind: 'cloud';
    ready: boolean;
    reason?: string;
    models: Array<ModelDefinition & { providerDefault: boolean; projectDefault: false; available: boolean }>;
  }>> {
    const results = [];
    for (const view of this.list()) {
      if (view.id === this.localProvider?.id) continue;
      let models: ModelDefinition[] = [];
      let reason = view.reason;
      if (view.available) {
        try {
          models = await this.provider(view).listModels();
          if (models.length === 0) reason = `${view.label} is not authenticated or has no available models.`;
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      results.push({
        id: view.id,
        kind: 'cloud' as const,
        ready: view.available && models.length > 0,
        reason: view.available && models.length > 0 ? undefined : reason ?? `${view.label} is unavailable.`,
        models: models.map((model) => ({
          ...model,
          available: true,
          providerDefault: false,
          projectDefault: false as const
        }))
      });
    }
    return results;
  }

  private provider(view: ProviderConnectionView): InferenceProvider {
    if (view.auth === 'api-key') {
      const secret = view.credentialId ? this.credentials.resolve(view.credentialId) : undefined;
      if (!secret) throw new Error(`Credential for ${view.label} is unavailable.`);
      const raw = view.providerFamily === 'openai'
        ? new OpenAIInferenceProvider({ apiKey: secret })
        : new AnthropicInferenceProvider({ apiKey: secret });
      // API connections preserve the existing base-provider dollar budget. The alias is
      // applied only after that guard, then capability policy is keyed to the connection.
      const guarded = this.budget.wrap(withSafeModelLimits(raw));
      return this.capabilities.wrap(aliasProvider(view.id, guarded));
    }
    if (view.auth === 'claude-account' && view.accountProfileId) {
      return this.capabilities.wrap(withSafeModelLimits(
        new ClaudeAccountInferenceProvider(view.id, view.accountProfileId, view.label, this.claudeRuntime)
      ));
    }
    if (view.auth === 'chatgpt-account' && view.accountProfileId) {
      return this.capabilities.wrap(withSafeModelLimits(
        new ChatGptAccountInferenceProvider(view.id, view.accountProfileId, view.label, this.codexRuntime)
      ));
    }
    throw new Error(`Connection ${view.id} cannot be used for inference.`);
  }
}
