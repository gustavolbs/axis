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
      if (selection.mode === 'explicit' && selection.providerId === provider.id) {
        requestedIds = [selection.modelId];
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
