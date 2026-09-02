import { ClaudeAccountProfileStore, ClaudeAccountRuntime } from './claude-account-profiles.js';
import { CodexAccountProfileStore, CodexAccountRuntime } from './codex-account-profiles.js';
import {
  LOCAL_ORGANIZATION_ID,
  PERSONAL_ORGANIZATION_ID,
  apiCredentialConnectionId,
  chatGptAccountConnectionId,
  claudeAccountConnectionId,
  organizationIdFromLabel
} from './connection-identity.js';
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

export { apiCredentialConnectionId, chatGptAccountConnectionId, claudeAccountConnectionId } from './connection-identity.js';

export type ProviderFamily = 'ollama' | 'anthropic' | 'openai';
export type ProviderConnectionAuth = 'local' | 'api-key' | 'claude-account' | 'chatgpt-account';
export type ProviderConnectionBilling = 'local' | 'api' | 'subscription';
export type ApiConnectionProviderFactory = (apiKey: string) => InferenceProvider;

export interface ProviderConnectionView {
  id: string;
  providerFamily: ProviderFamily;
  label: string;
  auth: ProviderConnectionAuth;
  billing: ProviderConnectionBilling;
  /** Always populated. Personal and local are explicit virtual organizations. */
  organizationId: string;
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
  apiProviderFactories?: Partial<Record<'anthropic' | 'openai', ApiConnectionProviderFactory>>;
}

const ACCOUNT_CAPABILITIES: ProviderCapabilities = {
  modelDiscovery: false,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

const DEFAULT_API_FACTORIES: Record<'anthropic' | 'openai', ApiConnectionProviderFactory> = {
  anthropic: (apiKey) => new AnthropicInferenceProvider({ apiKey }),
  openai: (apiKey) => new OpenAIInferenceProvider({ apiKey })
};

function accountPrompt(request: InferenceRequest): string {
  return [
    '# SYSTEM INSTRUCTIONS',
    request.systemPrompt.trim(),
    '',
    '# USER MESSAGE',
    request.userPrompt.trim(),
    '',
    '# EXECUTION BOUNDARY',
    'This Local Coder inference turn may not call MCP servers, connectors, plugins, shell commands, files, or other external tools. Answer only from the supplied model context. Work Hub data collection is a separate explicitly-bound capability.'
  ].join('\n');
}

function accountModel(providerId: string, family: 'anthropic' | 'openai', label: string): ModelDefinition {
  return {
    providerId,
    id: 'default',
    displayName: `${label} · account default`,
    capabilities: ACCOUNT_CAPABILITIES,
    metadata: {
      connectionAuth: family === 'anthropic' ? 'claude-account' : 'chatgpt-account',
      accountManagedModel: true
    }
  };
}

function aliasProvider(aliasId: string, label: string, inner: InferenceProvider): InferenceProvider {
  return {
    id: aliasId,
    kind: inner.kind,
    capabilities: inner.capabilities,
    async listModels() {
      return (await inner.listModels()).map((model) => ({
        ...model,
        providerId: aliasId,
        displayName: `${label} · ${model.displayName}`
      }));
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
    return status.authenticated ? [accountModel(this.id, 'anthropic', this.label)] : [];
  }

  async health(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    const status = await this.runtime.status(this.profileId);
    return {
      providerId: this.id,
      ok: status.authenticated,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      modelsAvailable: status.authenticated ? 1 : 0,
      message: status.authenticated ? undefined : status.error ?? 'Claude account is not authenticated.'
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    if (request.capabilityRequests?.length) {
      throw new Error('Claude account inference does not expose external capabilities. Configure an explicit Work Hub source instead.');
    }
    const startedAt = Date.now();
    const result = await this.runtime.invoke(this.profileId, accountPrompt(request), {
      timeoutMs: request.timeoutMs,
      jsonSchema: request.output?.type === 'json_schema' ? request.output.schema : undefined
    });
    if (result.cancelled) throw new Error('Claude account invocation was cancelled.');
    if (result.timedOut) throw new Error('Claude account invocation timed out.');
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Claude account invocation failed.');
    return {
      providerId: this.id,
      model: request.model,
      content: result.stdout,
      latencyMs: Date.now() - startedAt,
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
    return status.authenticated ? [accountModel(this.id, 'openai', this.label)] : [];
  }

  async health(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    const status = await this.runtime.status(this.profileId);
    return {
      providerId: this.id,
      ok: status.authenticated,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      modelsAvailable: status.authenticated ? 1 : 0,
      message: status.authenticated ? undefined : status.error ?? 'ChatGPT/Codex account is not authenticated.'
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    if (request.capabilityRequests?.length) {
      throw new Error('ChatGPT account inference does not expose external capabilities. Configure an explicit Work Hub source instead.');
    }
    const startedAt = Date.now();
    const result = await this.runtime.invoke(this.profileId, accountPrompt(request), {
      timeoutMs: request.timeoutMs,
      model: request.model,
      outputSchema: request.output?.type === 'json_schema' ? request.output.schema : undefined
    });
    if (result.cancelled) throw new Error('ChatGPT account invocation was cancelled.');
    if (result.timedOut) throw new Error('ChatGPT account invocation timed out.');
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'ChatGPT account invocation failed.');
    return {
      providerId: this.id,
      model: request.model,
      content: result.stdout,
      latencyMs: Date.now() - startedAt,
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

function connectionBelongsToOrganization(
  view: ProviderConnectionView,
  organizationId: string,
  legacyCredentialIds: ReadonlySet<string>
): boolean {
  if (view.organizationId === LOCAL_ORGANIZATION_ID) return true;
  if (view.organizationId === organizationId) return true;
  return view.auth === 'api-key' && Boolean(view.credentialId && legacyCredentialIds.has(view.credentialId));
}

/**
 * A provider family can expose many independently authenticated connection identities.
 * Selection and Project binding always operate on the connection id, never on a brand.
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
  private readonly apiFactories: Record<'anthropic' | 'openai', ApiConnectionProviderFactory>;

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
    this.apiFactories = { ...DEFAULT_API_FACTORIES, ...(options.apiProviderFactories ?? {}) };
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
        organizationId: LOCAL_ORGANIZATION_ID,
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
        organizationId: credential.organizationId ?? PERSONAL_ORGANIZATION_ID,
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
        label: profile.name,
        auth: 'claude-account',
        billing: 'subscription',
        organizationId: organizationIdFromLabel(profile.organizationLabel),
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
        label: profile.name,
        auth: 'chatgpt-account',
        billing: 'subscription',
        organizationId: organizationIdFromLabel(profile.organizationLabel),
        organizationLabel: profile.organizationLabel,
        accountProfileId: profile.id,
        available: true,
        supportsMcpSources: true
      });
    }

    return views.sort((left, right) => left.label.localeCompare(right.label));
  }

  handles(connectionId: string): boolean {
    return this.list().some((view) => view.id === connectionId);
  }

  view(connectionId: string): ProviderConnectionView | undefined {
    return this.list().find((view) => view.id === connectionId);
  }

  viewsForOrganization(
    organizationId: string,
    legacyCredentialIds: ReadonlySet<string> = new Set()
  ): ProviderConnectionView[] {
    return this.list().filter((view) => connectionBelongsToOrganization(view, organizationId, legacyCredentialIds));
  }

  async resolve(connectionId: string, modelId: string): Promise<{ provider: InferenceProvider; model: ModelDefinition }> {
    const view = this.view(connectionId);
    if (!view) throw new Error(`Unknown provider connection: ${connectionId}`);
    if (view.organizationId !== PERSONAL_ORGANIZATION_ID && view.organizationId !== LOCAL_ORGANIZATION_ID) {
      throw new Error(`${view.label} belongs to organization ${view.organizationId} and requires an explicitly bound Project.`);
    }
    return await this.resolveView(view, modelId);
  }

  providerForProject(
    connectionId: string,
    organizationId: string,
    legacyCredentialIds: ReadonlySet<string> = new Set()
  ): InferenceProvider {
    const view = this.view(connectionId);
    if (!view) throw new Error(`Unknown provider connection: ${connectionId}`);
    if (!connectionBelongsToOrganization(view, organizationId, legacyCredentialIds)) {
      throw new Error(
        `Connection ${view.label} belongs to organization ${view.organizationId}, not Project organization ${organizationId}.`
      );
    }
    if (!view.available) throw new Error(view.reason ?? `Provider connection ${connectionId} is unavailable.`);
    return this.provider(view);
  }

  async resolveForProject(
    connectionId: string,
    modelId: string,
    organizationId: string,
    legacyCredentialIds: ReadonlySet<string> = new Set()
  ): Promise<{ provider: InferenceProvider; model: ModelDefinition }> {
    const provider = this.providerForProject(connectionId, organizationId, legacyCredentialIds);
    const models = await provider.listModels();
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Model ${modelId} is not available through connection ${connectionId}.`);
    return { provider, model };
  }

  async catalogProviders(): Promise<Array<{
    id: string;
    kind: 'cloud';
    ready: boolean;
    reason?: string;
    models: Array<ModelDefinition & { providerDefault: boolean; projectDefault: false; available: boolean }>;
  }>> {
    const results: Array<{
      id: string;
      kind: 'cloud';
      ready: boolean;
      reason?: string;
      models: Array<ModelDefinition & { providerDefault: boolean; projectDefault: false; available: boolean }>;
    }> = [];
    for (const view of this.list()) {
      if (view.organizationId !== PERSONAL_ORGANIZATION_ID || view.auth === 'local') continue;
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
        kind: 'cloud',
        ready: view.available && models.length > 0,
        reason: view.available && models.length > 0 ? undefined : reason ?? `${view.label} is unavailable.`,
        models: models.map((model) => ({ ...model, available: true, providerDefault: false, projectDefault: false }))
      });
    }
    return results;
  }

  private async resolveView(view: ProviderConnectionView, modelId: string): Promise<{ provider: InferenceProvider; model: ModelDefinition }> {
    if (!view.available) throw new Error(view.reason ?? `Provider connection ${view.id} is unavailable.`);
    const provider = this.provider(view);
    const models = await provider.listModels();
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Model ${modelId} is not available through ${view.label}.`);
    return { provider, model };
  }

  private provider(view: ProviderConnectionView): InferenceProvider {
    if (view.auth === 'local') {
      if (!this.localProvider) throw new Error('Local inference is not configured.');
      return this.capabilities.wrap(this.budget.wrap(withSafeModelLimits(this.localProvider)));
    }
    if (view.auth === 'api-key') {
      const secret = view.credentialId ? this.credentials.resolve(view.credentialId) : undefined;
      if (!secret) throw new Error(`Credential for ${view.label} is unavailable.`);
      const factory = view.providerFamily === 'openai' ? this.apiFactories.openai : this.apiFactories.anthropic;
      const raw = factory(secret);
      if (raw.kind !== 'cloud' || raw.id !== view.providerFamily) {
        throw new Error(`API provider factory for ${view.providerFamily} returned an inconsistent provider.`);
      }
      const guarded = this.budget.wrap(withSafeModelLimits(raw));
      return this.capabilities.wrap(aliasProvider(view.id, view.label, guarded));
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
