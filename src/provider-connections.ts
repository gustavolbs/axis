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
  toolUse: true
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
    '# ACCOUNT CONNECTION',
    'You are running through the exact provider account selected for this Local Coder conversation. Use MCP servers and connectors configured for this account whenever they help fulfill the user request. Read or mutate remote data when the user explicitly asks for that action, including creating or updating tickets, calendar events, messages, or other connector-backed resources. Never switch to another account identity or use credentials from another connection.'
  ].join('\n');
}

interface AccountModelSpec {
  id: string;
  label: string;
  alias?: boolean;
}

const CLAUDE_ACCOUNT_MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
type ClaudeAccountModelFamily = typeof CLAUDE_ACCOUNT_MODEL_FAMILIES[number];

function claudeModelFamily(modelId: string): ClaudeAccountModelFamily | undefined {
  const normalized = modelId.toLowerCase();
  return CLAUDE_ACCOUNT_MODEL_FAMILIES.find((family) =>
    normalized === family || normalized.includes(`-${family}-`)
  );
}

function claudeVersionLabel(modelId: string): string {
  const family = claudeModelFamily(modelId);
  if (!family) return modelId;
  const version = modelId
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(new RegExp(`^${family}-`), '')
    .replace(/-\d{8}$/, '')
    .replace(/-/g, '.');
  return `${family.charAt(0).toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ''}`;
}

function latestClaudeModels(models: ModelDefinition[]): Map<ClaudeAccountModelFamily, ModelDefinition> {
  const latest = new Map<ClaudeAccountModelFamily, ModelDefinition>();
  for (const model of [...models].sort((left, right) => {
    const created = Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? '');
    if (Number.isFinite(created) && created !== 0) return created;
    return right.id.localeCompare(left.id, undefined, { numeric: true });
  })) {
    const family = claudeModelFamily(model.id);
    if (family && !latest.has(family)) latest.set(family, model);
  }
  return latest;
}

/**
 * Subscription CLIs do not expose the authenticated account's `/models`
 * endpoint. Claude does expose stable aliases, however, and those aliases are
 * intentionally used instead of versioned ids so a provider can move them to
 * its latest model without a Local Coder release.
 */
const CLAUDE_ACCOUNT_MODELS: AccountModelSpec[] = [
  { id: 'default', label: 'Account default' },
  { id: 'fable', label: 'Fable', alias: true },
  { id: 'opus', label: 'Opus', alias: true },
  { id: 'sonnet', label: 'Sonnet', alias: true },
  { id: 'haiku', label: 'Haiku', alias: true }
];

function accountModels(providerId: string, family: 'anthropic' | 'openai', label: string): ModelDefinition[] {
  const specs = family === 'anthropic'
    ? CLAUDE_ACCOUNT_MODELS
    : [{ id: 'default', label: 'Account default' }];
  return specs.map((spec) => ({
    providerId,
    id: spec.id,
    displayName: spec.label,
    capabilities: ACCOUNT_CAPABILITIES,
    metadata: {
      connectionAuth: family === 'anthropic' ? 'claude-account' : 'chatgpt-account',
      accountManagedModel: true,
      ...(spec.alias ? { modelAlias: true } : {})
    }
  }));
}

function aliasProvider(aliasId: string, inner: InferenceProvider): InferenceProvider {
  return {
    id: aliasId,
    kind: inner.kind,
    capabilities: inner.capabilities,
    async listModels() {
      return (await inner.listModels()).map((model) => ({
        ...model,
        providerId: aliasId
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
    return status.authenticated ? accountModels(this.id, 'anthropic', this.label) : [];
  }

  async health(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    const status = await this.runtime.status(this.profileId);
    return {
      providerId: this.id,
      ok: status.authenticated,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      modelsAvailable: status.authenticated ? accountModels(this.id, 'anthropic', this.label).length : 0,
      message: status.authenticated ? undefined : status.error ?? 'Claude account is not authenticated.'
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    const startedAt = Date.now();
    const result = await this.runtime.invoke(this.profileId, accountPrompt(request), {
      timeoutMs: request.timeoutMs,
      model: request.model,
      captureResultMetadata: true,
      allowedTools: ['mcp__*'],
      jsonSchema: request.output?.type === 'json_schema' ? request.output.schema : undefined
    });
    if (result.cancelled) throw new Error('Claude account invocation was cancelled.');
    if (result.timedOut) throw new Error('Claude account invocation timed out.');
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Claude account invocation failed.');
    return {
      providerId: this.id,
      model: result.model ?? request.model,
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
    return status.authenticated ? accountModels(this.id, 'openai', this.label) : [];
  }

  async health(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    const status = await this.runtime.status(this.profileId);
    return {
      providerId: this.id,
      ok: status.authenticated,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      modelsAvailable: status.authenticated ? accountModels(this.id, 'openai', this.label).length : 0,
      message: status.authenticated ? undefined : status.error ?? 'ChatGPT/Codex account is not authenticated.'
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
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

function apiConnectionLabel(providerFamily: 'anthropic' | 'openai', credentialLabel: string): string {
  const alreadyNamesProvider = providerFamily === 'anthropic'
    ? /\b(?:claude|anthropic)\b/i.test(credentialLabel)
    : /\b(?:gpt|openai)\b/i.test(credentialLabel);
  if (alreadyNamesProvider) return credentialLabel;
  return `${providerFamily === 'openai' ? 'OpenAI' : 'Claude'} · ${credentialLabel}`;
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
        label: apiConnectionLabel(credential.providerId, credential.label),
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
    if (
      view.organizationId !== PERSONAL_ORGANIZATION_ID &&
      view.organizationId !== LOCAL_ORGANIZATION_ID
    ) {
      throw new Error(`${view.label} belongs to company scope ${view.organizationId} and requires an explicitly bound Project.`);
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
    label: string;
    providerFamily: ProviderFamily;
    auth: ProviderConnectionAuth;
    billing: ProviderConnectionBilling;
    organizationLabel?: string;
    ready: boolean;
    reason?: string;
    models: Array<ModelDefinition & { providerDefault: boolean; projectDefault: false; available: boolean }>;
  }>> {
    const results: Array<{
      id: string;
      kind: 'cloud';
      label: string;
      providerFamily: ProviderFamily;
      auth: ProviderConnectionAuth;
      billing: ProviderConnectionBilling;
      organizationLabel?: string;
      ready: boolean;
      reason?: string;
      models: Array<ModelDefinition & { providerDefault: boolean; projectDefault: false; available: boolean }>;
    }> = [];
    for (const view of this.list()) {
      if (view.auth === 'local') continue;
      // Project-less Chat is the Personal context. Every non-local connection,
      // regardless of whether it authenticates through an API key or an Account,
      // must therefore be explicitly Personal before it can expose models or
      // account-scoped MCP resources here.
      if (view.organizationId !== PERSONAL_ORGANIZATION_ID) continue;
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
        label: view.label,
        providerFamily: view.providerFamily,
        auth: view.auth,
        billing: view.billing,
        organizationLabel: view.organizationLabel,
        ready: view.available && models.length > 0,
        reason: view.available && models.length > 0 ? undefined : reason ?? `${view.label} is unavailable.`,
        models: models.map((model) => ({ ...model, available: true, providerDefault: false, projectDefault: false }))
      });
    }
    const currentClaudeModels = latestClaudeModels(
      results
        .filter((provider) => provider.providerFamily === 'anthropic' && provider.auth === 'api-key' && provider.ready)
        .flatMap((provider) => provider.models)
    );
    for (const provider of results) {
      if (provider.auth !== 'claude-account') continue;
      provider.models = provider.models.map((model) => {
        const family = claudeModelFamily(model.id);
        const current = family ? currentClaudeModels.get(family) : undefined;
        return current
          ? {
              ...model,
              displayName: `${claudeVersionLabel(current.id)} · latest alias`,
              metadata: { ...model.metadata, resolvedModelHint: current.id }
            }
          : model;
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
      return this.capabilities.wrap(aliasProvider(view.id, guarded));
    }
    if (view.auth === 'claude-account' && view.accountProfileId) {
      return withSafeModelLimits(
        new ClaudeAccountInferenceProvider(view.id, view.accountProfileId, view.label, this.claudeRuntime)
      );
    }
    if (view.auth === 'chatgpt-account' && view.accountProfileId) {
      return withSafeModelLimits(
        new ChatGptAccountInferenceProvider(view.id, view.accountProfileId, view.label, this.codexRuntime)
      );
    }
    throw new Error(`Connection ${view.id} cannot be used for inference.`);
  }
}
