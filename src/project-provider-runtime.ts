import type { RoutingCandidate } from './cognitive-router.js';
import type { InferenceStage } from './inference-status.js';
import { CredentialManager } from './credential-store.js';
import { ProviderBudgetManager } from './provider-budget.js';
import { ProviderCapabilityPolicyManager } from './provider-capability-policy.js';
import { ProviderConnectionRuntime } from './provider-connections.js';
import {
  assertProjectCredentialIsolation,
  assertProjectProviderAllowed,
  type ModelSelection,
  type ProjectDefinition
} from './project-store.js';
import {
  DEFAULT_PROVIDER_CAPABILITIES,
  ProviderSettingsStore,
  type ModelRoutingProfile,
  type ProviderRuntimeSettings
} from './provider-settings.js';
import { AnthropicInferenceProvider } from './providers/anthropic-provider.js';
import { withSafeModelLimits } from './providers/model-limits.js';
import { OpenAIInferenceProvider } from './providers/openai-provider.js';
import { ProviderRegistry } from './providers/registry.js';
import type {
  InferenceProvider,
  ModelDefinition,
  ProviderCapabilities,
  ProviderKind
} from './providers/types.js';

export interface RoutingMetrics {
  queueDelayMs?: number;
  p50LatencyMs?: number;
  successRate?: number;
  historicalSamples?: number;
  estimatedCostUsd?: number;
}

export interface RoutingMetricsSource {
  get(
    projectId: string,
    stage: InferenceStage,
    providerId: string,
    modelId: string
  ): RoutingMetrics | undefined | Promise<RoutingMetrics | undefined>;
}

export type CloudProviderFactory = (apiKey: string) => InferenceProvider;

export interface ProjectProviderRuntimeOptions {
  localProvider?: InferenceProvider;
  credentials?: CredentialManager;
  settings?: ProviderSettingsStore;
  budget?: ProviderBudgetManager;
  capabilityPolicy?: ProviderCapabilityPolicyManager;
  cloudProviderFactories?: Record<string, CloudProviderFactory>;
  metrics?: RoutingMetricsSource;
  connections?: ProviderConnectionRuntime;
}

export interface RoutingCatalogOptions {
  stage: InferenceStage;
  localModelHint?: string;
  modelSelection?: ModelSelection;
  connectionScope?: 'chat' | 'cowork';
}

export interface PersonalChatCatalogModel {
  id: string;
  displayName: string;
  createdAt?: string;
  available: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ProviderCapabilities>;
  providerDefault: boolean;
  projectDefault: false;
}

export interface PersonalChatCatalogProvider {
  id: string;
  kind: ProviderKind;
  ready: boolean;
  reason?: string;
  models: PersonalChatCatalogModel[];
}

export interface PersonalChatCatalog {
  scope: 'personal';
  projectId: '';
  defaultModel: ModelSelection;
  providers: PersonalChatCatalogProvider[];
}

export const BUILT_IN_CLOUD_PROVIDER_IDS = ['anthropic', 'openai'] as const;

const defaultCloudFactories: Record<string, CloudProviderFactory> = {
  anthropic: (apiKey) => new AnthropicInferenceProvider({ apiKey }),
  openai: (apiKey) => new OpenAIInferenceProvider({ apiKey })
};

function defaultSettings(): ProviderRuntimeSettings {
  return {
    enabled: true,
    capabilities: structuredClone(DEFAULT_PROVIDER_CAPABILITIES),
    models: {}
  };
}

function mergeCapabilities(
  provider: InferenceProvider,
  model: ModelDefinition | undefined
): Partial<ProviderCapabilities> {
  return { ...provider.capabilities, ...(model?.capabilities ?? {}) };
}

function profileEnabled(profile: ModelRoutingProfile | undefined): boolean {
  return profile?.enabled !== false;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

const OPENAI_PERSONAL_CHAT_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4-mini',
  'gpt-5.5-pro'
]);

function isPersonalChatModel(providerId: string, model: ModelDefinition): boolean {
  if (providerId === 'openai') return OPENAI_PERSONAL_CHAT_MODELS.has(model.id.toLowerCase());
  if (providerId === 'anthropic') return /^claude-/i.test(model.id);
  return !/(?:image|audio|realtime|transcrib|tts|embedding|moderation|whisper)/.test(model.id.toLowerCase());
}

function orderPersonalChatModels(models: ModelDefinition[], defaultModelId?: string): ModelDefinition[] {
  return [...models].sort((left, right) => {
    const leftDefault = left.id === defaultModelId ? 1 : 0;
    const rightDefault = right.id === defaultModelId ? 1 : 0;
    if (leftDefault !== rightDefault) return rightDefault - leftDefault;
    const leftCreated = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightCreated = right.createdAt ? Date.parse(right.createdAt) : 0;
    if (leftCreated !== rightCreated) return rightCreated - leftCreated;
    return left.id.localeCompare(right.id);
  });
}

function curatePersonalChatModels(
  providerId: string,
  providerKind: ProviderKind,
  models: ModelDefinition[],
  defaultModelId?: string
): ModelDefinition[] {
  const ordered = orderPersonalChatModels(
    models.filter((model) => isPersonalChatModel(providerId, model)),
    defaultModelId
  );
  if (providerKind === 'local' || providerId === 'anthropic') return ordered;
  return ordered.slice(0, 6);
}

export class ProjectProviderRuntime {
  private readonly localProvider?: InferenceProvider;
  private readonly credentials: CredentialManager;
  private readonly settings: ProviderSettingsStore;
  private readonly budget: ProviderBudgetManager;
  private readonly capabilityPolicy: ProviderCapabilityPolicyManager;
  private readonly factories: Record<string, CloudProviderFactory>;
  private readonly metrics?: RoutingMetricsSource;
  private readonly connections: ProviderConnectionRuntime;

  constructor(options: ProjectProviderRuntimeOptions = {}) {
    this.localProvider = options.localProvider;
    this.credentials = options.credentials ?? new CredentialManager();
    this.settings = options.settings ?? new ProviderSettingsStore();
    this.budget = options.budget ?? new ProviderBudgetManager({ settings: this.settings });
    this.capabilityPolicy = options.capabilityPolicy ?? new ProviderCapabilityPolicyManager(this.settings);
    this.factories = { ...defaultCloudFactories, ...(options.cloudProviderFactories ?? {}) };
    this.metrics = options.metrics;
    this.connections = options.connections ?? new ProviderConnectionRuntime({
      localProvider: this.localProvider,
      credentials: this.credentials,
      settings: this.settings,
      budget: this.budget,
      capabilityPolicy: this.capabilityPolicy,
      apiProviderFactories: {
        anthropic: this.factories.anthropic,
        openai: this.factories.openai
      }
    });
  }

  private governed(provider: InferenceProvider): InferenceProvider {
    return this.capabilityPolicy.wrap(this.budget.wrap(withSafeModelLimits(provider)));
  }

  private settingsKey(providerId: string): string {
    return this.connections.view(providerId)?.providerFamily ?? providerId;
  }

  private assertConnectionFamilyAllowed(project: ProjectDefinition, connectionId: string): void {
    const view = this.connections.view(connectionId);
    if (!view) return;
    if (!project.privacy.allowedProviderIds.includes(view.providerFamily)) {
      throw new Error(
        `Connection ${view.label} belongs to provider family ${view.providerFamily}, which Project ${project.id} does not allow.`
      );
    }
    if (view.providerFamily !== 'ollama' && !project.privacy.cloudAllowed) {
      throw new Error(`Project ${project.id} does not allow cloud connection ${view.label}.`);
    }
  }

  buildRegistry(project: ProjectDefinition): ProviderRegistry {
    const profiles = this.credentials.list();
    assertProjectCredentialIsolation(project, profiles);
    const providers: InferenceProvider[] = [];
    const legacyCredentialIds = new Set(Object.values(project.credentialProfileIds));
    const connectionIds = unique([
      ...project.connectionPolicy.inference.allowedConnectionIds,
      ...project.connectionPolicy.chat.allowedConnectionIds
    ]);

    for (const connectionId of connectionIds) {
      this.assertConnectionFamilyAllowed(project, connectionId);
      if (connectionId === (this.localProvider?.id ?? 'ollama') || connectionId === 'ollama') {
        if (!this.localProvider) continue;
        if (!project.privacy.allowedProviderIds.includes('ollama')) continue;
        if (this.settings.get(this.localProvider.id)?.enabled === false) continue;
        providers.push(this.governed(this.localProvider));
        continue;
      }

      if (this.connections.handles(connectionId)) {
        const provider = this.connections.providerForProject(
          connectionId,
          project.organizationId,
          legacyCredentialIds
        );
        providers.push(provider);
        continue;
      }

      // Compatibility for non-built-in/custom providers that predate connection IDs.
      const factory = this.factories[connectionId];
      const credentialId = project.credentialProfileIds[connectionId];
      if (!factory || !credentialId || !project.privacy.cloudAllowed) continue;
      if (this.settings.get(connectionId)?.enabled === false) continue;
      const secret = this.credentials.resolve(credentialId);
      if (!secret) continue;
      const provider = factory(secret);
      if (provider.id !== connectionId || provider.kind !== 'cloud') {
        throw new Error(`Provider factory ${connectionId} returned inconsistent provider identity/kind.`);
      }
      providers.push(this.governed(provider));
    }

    return new ProviderRegistry(providers);
  }

  personalChatProvider(providerId: string): { provider?: InferenceProvider; reason?: string } {
    if (providerId === this.localProvider?.id || providerId === 'ollama') {
      if (!this.localProvider) return { reason: 'Local inference is not configured.' };
      const settings = this.settings.get(this.localProvider.id);
      if (settings?.enabled === false) return { reason: `${this.localProvider.id} is disabled in Model routing settings.` };
      return { provider: this.governed(this.localProvider) };
    }

    const factory = this.factories[providerId];
    if (!factory) return { reason: `Provider ${providerId} is not registered.` };
    const settings = this.settings.get(providerId);
    if (settings?.enabled === false) return { reason: `${providerId} is disabled in Model routing settings.` };

    const personalProfiles = this.credentials.list().filter(
      (profile) => profile.providerId === providerId && profile.organizationId === undefined
    );
    const available: Array<{ id: string; secret: string }> = [];
    for (const profile of personalProfiles) {
      try {
        const secret = this.credentials.resolve(profile.id);
        if (secret) available.push({ id: profile.id, secret });
      } catch { /* safe unavailable */ }
    }
    if (available.length === 0) {
      return { reason: `Add an available personal ${providerId} credential in Settings → API keys.` };
    }
    if (available.length > 1) {
      return { reason: `Multiple personal ${providerId} credentials are available. Choose an explicit API connection.` };
    }
    const provider = factory(available[0]!.secret);
    if (provider.id !== providerId || provider.kind !== 'cloud') {
      throw new Error(`Provider factory ${providerId} returned inconsistent provider identity/kind.`);
    }
    return { provider: this.governed(provider) };
  }

  async personalChatCatalog(): Promise<PersonalChatCatalog> {
    const providerIds = unique([this.localProvider?.id ?? 'ollama', ...Object.keys(this.factories)]);
    const providers: PersonalChatCatalogProvider[] = [];

    for (const providerId of providerIds) {
      const resolution = this.personalChatProvider(providerId);
      const provider = resolution.provider;
      const settings = this.settings.get(providerId) ?? defaultSettings();
      let models: ModelDefinition[] = [];
      let discoveryError: string | undefined;
      if (provider) {
        try {
          models = curatePersonalChatModels(providerId, provider.kind, await provider.listModels(), settings.defaultModelId);
        } catch (error) {
          discoveryError = error instanceof Error ? error.message : String(error);
        }
      }
      const ready = Boolean(provider) && !discoveryError && models.length > 0;
      providers.push({
        id: providerId,
        kind: provider?.kind ?? (providerId === (this.localProvider?.id ?? 'ollama') ? 'local' : 'cloud'),
        ready,
        reason: ready ? undefined : discoveryError ?? resolution.reason ?? `No conversational models are available for ${providerId}.`,
        models: models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          createdAt: model.createdAt,
          available: true,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          capabilities: mergeCapabilities(provider!, model),
          providerDefault: settings.defaultModelId === model.id,
          projectDefault: false
        }))
      });
    }

    for (const connection of await this.connections.catalogProviders()) {
      providers.push({
        id: connection.id,
        kind: connection.kind,
        ready: connection.ready,
        reason: connection.reason,
        models: connection.models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          createdAt: model.createdAt,
          available: model.available,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          capabilities: model.capabilities,
          providerDefault: model.providerDefault,
          projectDefault: false
        }))
      });
    }

    return { scope: 'personal', projectId: '', defaultModel: { mode: 'auto' }, providers };
  }

  async personalModelDefinition(
    providerId: string,
    modelId: string
  ): Promise<{ provider: InferenceProvider; model: ModelDefinition }> {
    if (this.connections.handles(providerId)) return await this.connections.resolve(providerId, modelId);
    const resolution = this.personalChatProvider(providerId);
    if (!resolution.provider) throw new Error(resolution.reason ?? `Provider ${providerId} is unavailable for personal Chat.`);
    const settings = this.settings.get(providerId) ?? defaultSettings();
    const models = curatePersonalChatModels(
      providerId,
      resolution.provider.kind,
      await resolution.provider.listModels(),
      settings.defaultModelId
    );
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`Model ${providerId}/${modelId} is not available for personal Chat.`);
    return { provider: resolution.provider, model };
  }

  async projectChatSelection(project: ProjectDefinition): Promise<ModelSelection> {
    const connectionId = project.connectionPolicy.chat.defaultConnectionId;
    if (!connectionId) throw new Error(`Project ${project.id} has no default Chat connection.`);
    if (!project.connectionPolicy.chat.allowedConnectionIds.includes(connectionId)) {
      throw new Error(`Project ${project.id} default Chat connection is outside its Chat allowlist.`);
    }
    this.assertConnectionFamilyAllowed(project, connectionId);

    const legacyCredentialIds = new Set(Object.values(project.credentialProfileIds));
    let provider: InferenceProvider;
    if (connectionId === (this.localProvider?.id ?? 'ollama') || connectionId === 'ollama') {
      if (!this.localProvider) throw new Error('Local inference is not configured.');
      provider = this.governed(this.localProvider);
    } else if (this.connections.handles(connectionId)) {
      provider = this.connections.providerForProject(connectionId, project.organizationId, legacyCredentialIds);
    } else {
      const registry = this.buildRegistry(project);
      if (!registry.has(connectionId)) throw new Error(`Project Chat connection is unavailable: ${connectionId}`);
      provider = registry.get(connectionId);
    }

    const settings = this.settings.get(this.settingsKey(connectionId)) ?? defaultSettings();
    const models = await provider.listModels();
    const inheritedModel = project.defaultModel.mode === 'explicit' && project.defaultModel.providerId === connectionId
      ? project.defaultModel.modelId
      : project.defaultModel.mode === 'local-first' && connectionId === 'ollama'
        ? project.defaultModel.modelId
        : undefined;
    const modelId = unique([
      project.connectionPolicy.chat.defaultModelId,
      inheritedModel,
      settings.defaultModelId,
      models[0]?.id
    ])[0];
    if (!modelId || !models.some((model) => model.id === modelId)) {
      throw new Error(`Project ${project.id} default Chat connection ${connectionId} has no available model.`);
    }
    return { mode: 'explicit', providerId: connectionId, modelId };
  }

  async modelDefinition(
    project: ProjectDefinition,
    providerId: string,
    modelId: string
  ): Promise<{ providerKind: ProviderKind; model: ModelDefinition } | undefined> {
    const registry = this.buildRegistry(project);
    const provider = registry.list().find((candidate) => candidate.id === providerId);
    if (!provider) return undefined;
    assertProjectProviderAllowed(project, providerId, provider.kind);
    const model = (await provider.listModels()).find((candidate) => candidate.id === modelId);
    return model ? { providerKind: provider.kind, model } : undefined;
  }

  async routingCandidates(
    project: ProjectDefinition,
    options: RoutingCatalogOptions
  ): Promise<{ registry: ProviderRegistry; candidates: RoutingCandidate[] }> {
    const registry = this.buildRegistry(project);
    const selection = options.modelSelection ?? project.defaultModel;
    const candidates: RoutingCandidate[] = [];
    const allowedConnections = new Set(
      options.connectionScope === 'chat'
        ? project.connectionPolicy.chat.allowedConnectionIds
        : project.connectionPolicy.inference.allowedConnectionIds
    );

    for (const provider of registry.list()) {
      if (!allowedConnections.has(provider.id)) continue;
      const settingsKey = this.settingsKey(provider.id);
      const providerSettings = this.settings.get(settingsKey) ?? defaultSettings();
      const connection = this.connections.view(provider.id);
      let discovered: ModelDefinition[] = [];
      let discoveryOk = true;
      try {
        discovered = await provider.listModels();
      } catch {
        discoveryOk = false;
      }
      const byId = new Map(discovered.map((model) => [model.id, model]));
      const configuredModels = Object.entries(providerSettings.models)
        .filter(([, profile]) => profileEnabled(profile))
        .map(([modelId]) => modelId);

      let requestedIds: string[];
      if (selection.mode === 'local-first') {
        requestedIds = provider.kind === 'local' ? [selection.modelId] : [];
      } else if (selection.mode === 'explicit' && selection.providerId === provider.id) {
        requestedIds = [selection.modelId];
      } else if (selection.mode === 'explicit') {
        requestedIds = [];
      } else if (provider.kind === 'local') {
        const configuredFast = discovered.find((model) => model.metadata?.configuredFastModel === true)?.id;
        requestedIds = options.localModelHint
          ? [options.localModelHint]
          : unique([providerSettings.defaultModelId, configuredFast, ...configuredModels]);
      } else if (connection?.billing === 'subscription') {
        requestedIds = unique([providerSettings.defaultModelId, ...configuredModels, ...discovered.map((model) => model.id)]);
      } else {
        requestedIds = unique([providerSettings.defaultModelId, ...configuredModels]);
      }

      for (const modelId of requestedIds) {
        const model = byId.get(modelId);
        const profile = providerSettings.models[modelId];
        const metrics = await this.metrics?.get(project.id, options.stage, provider.id, modelId);
        candidates.push({
          providerId: provider.id,
          modelId,
          providerKind: provider.kind,
          available: discoveryOk && Boolean(model) && profileEnabled(profile),
          capabilities: mergeCapabilities(provider, model),
          frontier: profile?.frontier === true,
          qualityScore: profile?.qualityScore,
          queueDelayMs: metrics?.queueDelayMs,
          p50LatencyMs: metrics?.p50LatencyMs,
          successRate: metrics?.successRate,
          historicalSamples: metrics?.historicalSamples,
          estimatedCostUsd: provider.kind === 'local' ? 0 : metrics?.estimatedCostUsd,
          preferredConnection: project.connectionPolicy.inference.preferredConnectionId === provider.id
        });
      }
    }

    return { registry, candidates };
  }
}
