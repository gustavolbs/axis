import type { RoutingCandidate } from './cognitive-router.js';
import type { InferenceStage } from './inference-status.js';
import { CredentialManager } from './credential-store.js';
import {
  assertProjectCredentialIsolation,
  type ModelSelection,
  type ProjectDefinition
} from './project-store.js';
import {
  ProviderSettingsStore,
  type ModelRoutingProfile
} from './provider-settings.js';
import { AnthropicInferenceProvider } from './providers/anthropic-provider.js';
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
  cloudProviderFactories?: Record<string, CloudProviderFactory>;
  metrics?: RoutingMetricsSource;
}

export interface RoutingCatalogOptions {
  stage: InferenceStage;
  /** Preserve the legacy fast/strong local model selected by the existing executor. */
  localModelHint?: string;
  modelSelection?: ModelSelection;
}

export interface PersonalChatCatalogModel {
  id: string;
  displayName: string;
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

function allowed(
  project: ProjectDefinition,
  provider: { id: string; kind: ProviderKind }
): boolean {
  if (!project.privacy.allowedProviderIds.includes(provider.id)) return false;
  return provider.kind === 'local' || project.privacy.cloudAllowed;
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

function isPersonalChatModel(providerId: string, model: ModelDefinition): boolean {
  if (providerId !== 'openai') return true;
  const id = model.id.toLowerCase();
  if (/(?:image|audio|realtime|transcrib|tts|embedding|moderation|whisper|dall-e)/.test(id)) return false;
  return /^(?:gpt-(?:4|5)|chatgpt-|o[1-9](?:-|$))/.test(id);
}

function orderPersonalChatModels(
  models: ModelDefinition[],
  defaultModelId?: string
): ModelDefinition[] {
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

/**
 * Creates provider registries and model catalogs inside one Project isolation boundary.
 * Secrets are resolved only long enough to construct the provider and are never returned.
 */
export class ProjectProviderRuntime {
  private readonly localProvider?: InferenceProvider;
  private readonly credentials: CredentialManager;
  private readonly settings: ProviderSettingsStore;
  private readonly factories: Record<string, CloudProviderFactory>;
  private readonly metrics?: RoutingMetricsSource;

  constructor(options: ProjectProviderRuntimeOptions = {}) {
    this.localProvider = options.localProvider;
    this.credentials = options.credentials ?? new CredentialManager();
    this.settings = options.settings ?? new ProviderSettingsStore();
    this.factories = { ...defaultCloudFactories, ...(options.cloudProviderFactories ?? {}) };
    this.metrics = options.metrics;
  }

  buildRegistry(project: ProjectDefinition): ProviderRegistry {
    const profiles = this.credentials.list();
    assertProjectCredentialIsolation(project, profiles);
    const providers: InferenceProvider[] = [];

    if (this.localProvider && allowed(project, this.localProvider)) {
      const settings = this.settings.get(this.localProvider.id);
      if (settings?.enabled !== false) providers.push(this.localProvider);
    }

    for (const providerId of project.privacy.allowedProviderIds) {
      if (providerId === this.localProvider?.id) continue;
      const factory = this.factories[providerId];
      if (!factory || !project.privacy.cloudAllowed) continue;
      const settings = this.settings.get(providerId);
      if (settings?.enabled === false) continue;
      const credentialId = project.credentialProfileIds[providerId];
      if (!credentialId) continue;
      const secret = this.credentials.resolve(credentialId);
      if (!secret) continue;
      const provider = factory(secret);
      if (provider.id !== providerId || provider.kind !== 'cloud') {
        throw new Error(
          `Provider factory ${providerId} returned inconsistent provider identity/kind.`
        );
      }
      if (allowed(project, provider)) providers.push(provider);
    }

    return new ProviderRegistry(providers);
  }

  /**
   * Resolve a provider for projectless Chat. Only credentials without an organization
   * boundary are eligible. Corporate credentials can therefore never leak into a
   * personal conversation. Multiple personal credentials fail closed because there is
   * no Project binding available to disambiguate them.
   */
  personalChatProvider(providerId: string): { provider?: InferenceProvider; reason?: string } {
    if (providerId === this.localProvider?.id || providerId === 'ollama') {
      if (!this.localProvider) return { reason: 'Local inference is not configured.' };
      const settings = this.settings.get(this.localProvider.id);
      if (settings?.enabled === false) return { reason: 'Ollama is disabled in Model routing settings.' };
      return { provider: this.localProvider };
    }

    const factory = this.factories[providerId];
    if (!factory) return { reason: `Provider ${providerId} is not supported.` };
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
      } catch {
        // Availability is represented by the resulting reason, never by leaking a Keychain error/secret.
      }
    }

    if (available.length === 0) {
      return { reason: `Add an available personal ${providerId === 'openai' ? 'OpenAI' : 'Anthropic'} API key in Settings → API keys.` };
    }
    if (available.length > 1) {
      return { reason: `Multiple personal ${providerId} credentials are available. Use a Project to choose one explicitly.` };
    }

    const provider = factory(available[0]!.secret);
    if (provider.id !== providerId || provider.kind !== 'cloud') {
      throw new Error(`Provider factory ${providerId} returned inconsistent provider identity/kind.`);
    }
    return { provider };
  }

  async personalChatCatalog(): Promise<PersonalChatCatalog> {
    const providerIds = unique([
      this.localProvider?.id ?? 'ollama',
      ...BUILT_IN_CLOUD_PROVIDER_IDS
    ]);
    const providers: PersonalChatCatalogProvider[] = [];

    for (const providerId of providerIds) {
      const resolution = this.personalChatProvider(providerId);
      const provider = resolution.provider;
      const settings = this.settings.get(providerId) ?? { enabled: true, models: {} };
      let models: ModelDefinition[] = [];
      let discoveryError: string | undefined;
      if (provider) {
        try {
          models = orderPersonalChatModels(
            (await provider.listModels()).filter((model) => isPersonalChatModel(providerId, model)),
            settings.defaultModelId
          );
        } catch (error) {
          discoveryError = error instanceof Error ? error.message : String(error);
        }
      }
      const ready = Boolean(provider) && !discoveryError && models.length > 0;
      providers.push({
        id: providerId,
        kind: provider?.kind ?? (providerId === 'ollama' ? 'local' : 'cloud'),
        ready,
        reason: ready
          ? undefined
          : discoveryError ?? resolution.reason ?? `No conversational models are available for ${providerId}.`,
        models: models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          available: true,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          capabilities: mergeCapabilities(provider!, model),
          providerDefault: settings.defaultModelId === model.id,
          projectDefault: false
        }))
      });
    }

    return {
      scope: 'personal',
      projectId: '',
      defaultModel: { mode: 'auto' },
      providers
    };
  }

  async personalModelDefinition(
    providerId: string,
    modelId: string
  ): Promise<{ provider: InferenceProvider; model: ModelDefinition }> {
    const resolution = this.personalChatProvider(providerId);
    if (!resolution.provider) {
      throw new Error(resolution.reason ?? `Provider ${providerId} is unavailable for personal Chat.`);
    }
    const models = await resolution.provider.listModels();
    const model = models.find(
      (candidate) => candidate.id === modelId && isPersonalChatModel(providerId, candidate)
    );
    if (!model) throw new Error(`Model ${providerId}/${modelId} is not available for personal Chat.`);
    return { provider: resolution.provider, model };
  }

  /**
   * Returns the real provider/model metadata used by Chat budgeting. This keeps
   * context-window knowledge at the provider boundary instead of baking Claude,
   * GPT or Ollama limits into the generic conversation layer.
   */
  async modelDefinition(
    project: ProjectDefinition,
    providerId: string,
    modelId: string
  ): Promise<{ providerKind: ProviderKind; model: ModelDefinition } | undefined> {
    const registry = this.buildRegistry(project);
    const provider = registry.list().find((candidate) => candidate.id === providerId);
    if (!provider || !allowed(project, provider)) return undefined;
    const models = await provider.listModels();
    const model = models.find((candidate) => candidate.id === modelId);
    return model ? { providerKind: provider.kind, model } : undefined;
  }

  async routingCandidates(
    project: ProjectDefinition,
    options: RoutingCatalogOptions
  ): Promise<{ registry: ProviderRegistry; candidates: RoutingCandidate[] }> {
    const registry = this.buildRegistry(project);
    const selection = options.modelSelection ?? project.defaultModel;
    const candidates: RoutingCandidate[] = [];

    for (const provider of registry.list()) {
      const providerSettings = this.settings.get(provider.id) ?? { enabled: true, models: {} };
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
        // Local-first is a strict execution mode, not a scoring preference. Normal
        // agent stages must remain on Ollama. Cloud is reachable only through the
        // explicit escalation broker after the local agent returns needs-guidance.
        requestedIds = provider.kind === 'local' ? [selection.modelId] : [];
      } else if (selection.mode === 'explicit' && selection.providerId === provider.id) {
        requestedIds = [selection.modelId];
      } else if (selection.mode === 'explicit') {
        // Direct Ollama / Claude / GPT selection is exact. Do not keep unrelated
        // providers around as fallback candidates for provider failures.
        requestedIds = [];
      } else if (provider.kind === 'local') {
        const configuredFast = discovered.find(
          (model) => model.metadata?.configuredFastModel === true
        )?.id;
        // When the legacy executor selected fast/strong for this attempt, keep that exact
        // local model as the only local candidate. Cloud can still beat it by policy.
        requestedIds = options.localModelHint
          ? [options.localModelHint]
          : unique([providerSettings.defaultModelId, configuredFast, ...configuredModels]);
      } else {
        // Auto-routing never chooses an arbitrary cloud model just because `/models`
        // returned it. Provider setup must select a default or explicitly enable profiles.
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
          estimatedCostUsd: provider.kind === 'local' ? 0 : metrics?.estimatedCostUsd
        });
      }
    }

    return { registry, candidates };
  }
}