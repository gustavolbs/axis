import {
  CredentialManager,
  type CredentialProfile
} from './credential-store.js';
import {
  PricingStore,
  type ModelPricing
} from './pricing-store.js';
import {
  BUILT_IN_CLOUD_PROVIDER_IDS,
  ProjectProviderRuntime
} from './project-provider-runtime.js';
import {
  ProjectStore,
  assertProjectCredentialIsolation,
  type CreateProjectInput,
  type ProjectBudgetPolicy,
  type ProjectDefinition
} from './project-store.js';
import {
  ProviderSettingsStore,
  type ModelRoutingProfile,
  type ProviderRuntimeSettings,
  type ProviderRuntimeSettingsPatch
} from './provider-settings.js';
import type {
  InferenceProvider,
  ModelDefinition,
  ProviderCapabilities,
  ProviderKind
} from './providers/types.js';
import {
  UsageLedger,
  utcDayPeriod,
  utcMonthPeriod,
  type UsagePeriodSummary
} from './usage-ledger.js';

export interface CredentialView {
  id: string;
  providerId: string;
  label: string;
  organizationId?: string;
  backend: 'macos-keychain' | 'environment';
  environmentVariable?: string;
  available: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CreateCredentialInput =
  | {
      backend: 'macos-keychain';
      id: string;
      providerId: string;
      label: string;
      organizationId?: string;
      secret: string;
    }
  | {
      backend: 'environment';
      id: string;
      providerId: string;
      label: string;
      organizationId?: string;
      environmentVariable: string;
    };

export interface ProviderAdminView {
  id: string;
  kind: ProviderKind;
  builtIn: boolean;
  settings: ProviderRuntimeSettings;
  credentials: CredentialView[];
  pricing: Record<string, ModelPricing>;
}

export interface ProjectCatalogModel {
  id: string;
  displayName: string;
  available: boolean;
  capabilities?: Partial<ProviderCapabilities>;
  routing: ModelRoutingProfile;
  pricing?: ModelPricing;
  providerDefault: boolean;
  projectDefault: boolean;
}

export interface ProjectCatalogProvider {
  id: string;
  kind: ProviderKind;
  allowed: boolean;
  enabled: boolean;
  ready: boolean;
  reason?: string;
  credentialProfileId?: string;
  credentialAvailable?: boolean;
  models: ProjectCatalogModel[];
}

export interface ProjectCatalog {
  projectId: string;
  defaultRoutingPolicy: ProjectDefinition['defaultRoutingPolicy'];
  defaultModel: ProjectDefinition['defaultModel'];
  providers: ProjectCatalogProvider[];
}

export interface ProjectUsageView {
  projectId: string;
  budgets: ProjectBudgetPolicy;
  daily: UsagePeriodSummary;
  monthly: UsagePeriodSummary;
  activeReservations: {
    count: number;
    upperBoundUsd: number;
  };
}

export interface ProjectAdminServiceOptions {
  projects?: ProjectStore;
  credentials?: CredentialManager;
  providerSettings?: ProviderSettingsStore;
  pricing?: PricingStore;
  ledger?: UsageLedger;
  localProvider?: InferenceProvider;
  providerRuntime?: ProjectProviderRuntime;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function credentialAvailable(manager: CredentialManager, id: string): boolean {
  try {
    return Boolean(manager.resolve(id));
  } catch {
    return false;
  }
}

function credentialView(manager: CredentialManager, profile: CredentialProfile): CredentialView {
  return {
    id: profile.id,
    providerId: profile.providerId,
    label: profile.label,
    organizationId: profile.organizationId,
    backend: profile.secret.backend,
    environmentVariable:
      profile.secret.backend === 'environment' ? profile.secret.id : undefined,
    available: credentialAvailable(manager, profile.id),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function modelMap(models: ModelDefinition[]): Map<string, ModelDefinition> {
  return new Map(models.map((model) => [model.id, model]));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function inferredKind(providerId: string, localProvider?: InferenceProvider): ProviderKind {
  return providerId === localProvider?.id || providerId === 'ollama' ? 'local' : 'cloud';
}

export class ProjectAdminService {
  private readonly projects: ProjectStore;
  private readonly credentials: CredentialManager;
  private readonly providerSettings: ProviderSettingsStore;
  private readonly pricing: PricingStore;
  private readonly ledger: UsageLedger;
  private readonly localProvider?: InferenceProvider;
  private readonly providerRuntime: ProjectProviderRuntime;

  constructor(options: ProjectAdminServiceOptions = {}) {
    this.projects = options.projects ?? new ProjectStore();
    this.credentials = options.credentials ?? new CredentialManager();
    this.providerSettings = options.providerSettings ?? new ProviderSettingsStore();
    this.pricing = options.pricing ?? new PricingStore();
    this.ledger = options.ledger ?? new UsageLedger();
    this.localProvider = options.localProvider;
    this.providerRuntime = options.providerRuntime ?? new ProjectProviderRuntime({
      localProvider: this.localProvider,
      credentials: this.credentials,
      settings: this.providerSettings
    });
  }

  listProjects(): ProjectDefinition[] {
    return this.projects.list();
  }

  getProject(id: string): ProjectDefinition {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return project;
  }

  createProject(input: CreateProjectInput): ProjectDefinition {
    this.assertCredentialBindings(
      input.id ?? '[new-project]',
      input.organizationId,
      input.privacy?.allowedProviderIds ?? ['ollama'],
      input.credentialProfileIds ?? {}
    );
    const project = this.projects.create(input);
    assertProjectCredentialIsolation(project, this.credentials.list());
    return project;
  }

  updateProject(
    id: string,
    patch: Partial<Omit<CreateProjectInput, 'id'>>
  ): ProjectDefinition {
    const current = this.getProject(id);
    const organizationId = patch.organizationId ?? current.organizationId;
    const privacy = patch.privacy ?? current.privacy;
    const credentialProfileIds = patch.credentialProfileIds ?? current.credentialProfileIds;
    this.assertCredentialBindings(
      current.id,
      organizationId,
      privacy.allowedProviderIds,
      credentialProfileIds
    );
    const project = this.projects.update(id, patch);
    assertProjectCredentialIsolation(project, this.credentials.list());
    return project;
  }

  removeProject(id: string): boolean {
    return this.projects.remove(id);
  }

  listCredentials(): CredentialView[] {
    return this.credentials.list().map((profile) => credentialView(this.credentials, profile));
  }

  createCredential(input: CreateCredentialInput): CredentialView {
    const profile = input.backend === 'macos-keychain'
      ? this.credentials.addOrReplaceKeychainCredential({
          id: input.id,
          providerId: input.providerId,
          label: input.label,
          organizationId: input.organizationId,
          secret: input.secret
        })
      : this.credentials.addEnvironmentCredential({
          id: input.id,
          providerId: input.providerId,
          label: input.label,
          organizationId: input.organizationId,
          environmentVariable: input.environmentVariable
        });
    return credentialView(this.credentials, profile);
  }

  removeCredential(id: string): boolean {
    const referencedBy = this.projects.list()
      .filter((project) => Object.values(project.credentialProfileIds).includes(id))
      .map((project) => project.id);
    if (referencedBy.length > 0) {
      throw new Error(
        `Credential ${id} is still referenced by Project(s): ${referencedBy.join(', ')}.`
      );
    }
    return this.credentials.remove(id);
  }

  listProviders(): ProviderAdminView[] {
    const settings = this.providerSettings.list();
    const pricing = this.pricing.list();
    const credentials = this.listCredentials();
    const projectProviderIds = this.projects.list().flatMap(
      (project) => project.privacy.allowedProviderIds
    );
    const ids = unique([
      this.localProvider?.id ?? 'ollama',
      ...BUILT_IN_CLOUD_PROVIDER_IDS,
      ...Object.keys(settings),
      ...Object.keys(pricing),
      ...credentials.map((credential) => credential.providerId),
      ...projectProviderIds
    ]).sort();

    return ids.map((id) => ({
      id,
      kind: inferredKind(id, this.localProvider),
      builtIn:
        id === (this.localProvider?.id ?? 'ollama') ||
        (BUILT_IN_CLOUD_PROVIDER_IDS as readonly string[]).includes(id),
      settings: settings[id] ?? { enabled: true, models: {} },
      credentials: credentials.filter((credential) => credential.providerId === id),
      pricing: pricing[id] ?? {}
    }));
  }

  updateProvider(
    providerId: string,
    patch: ProviderRuntimeSettingsPatch
  ): ProviderRuntimeSettings {
    return this.providerSettings.update(providerId, patch);
  }

  removeProviderSettings(providerId: string): boolean {
    return this.providerSettings.remove(providerId);
  }

  listPricing(): Record<string, Record<string, ModelPricing>> {
    return this.pricing.list();
  }

  setPricing(providerId: string, modelId: string, value: ModelPricing): ModelPricing {
    return this.pricing.set(providerId, modelId, value);
  }

  removePricing(providerId: string, modelId: string): boolean {
    return this.pricing.remove(providerId, modelId);
  }

  usage(projectId: string, now = new Date()): ProjectUsageView {
    const project = this.getProject(projectId);
    const day = utcDayPeriod(now);
    const month = utcMonthPeriod(now);
    const reservations = this.ledger.listReservations(project.id, now);
    return {
      projectId: project.id,
      budgets: project.budgets,
      daily: this.ledger.summarize(project.id, day.from, day.to),
      monthly: this.ledger.summarize(project.id, month.from, month.to),
      activeReservations: {
        count: reservations.length,
        upperBoundUsd: roundUsd(
          reservations.reduce((sum, reservation) => sum + reservation.upperBoundCostUsd, 0)
        )
      }
    };
  }

  async catalog(projectId: string): Promise<ProjectCatalog> {
    const project = this.getProject(projectId);
    const registry = this.providerRuntime.buildRegistry(project);
    const pricing = this.pricing.list();
    const providers: ProjectCatalogProvider[] = [];

    for (const providerId of project.privacy.allowedProviderIds) {
      const settings = this.providerSettings.get(providerId) ?? { enabled: true, models: {} };
      const credentialProfileId = project.credentialProfileIds[providerId];
      const credentialAvailableForProject = credentialProfileId
        ? credentialAvailable(this.credentials, credentialProfileId)
        : undefined;
      const provider = registry.has(providerId) ? registry.get(providerId) : undefined;
      let discovered: ModelDefinition[] = [];
      let discoveryError: string | undefined;

      if (provider) {
        try {
          discovered = await provider.listModels();
        } catch (error) {
          discoveryError = error instanceof Error ? error.message : String(error);
        }
      }

      const discoveredById = modelMap(discovered);
      const modelIds = unique([
        ...discovered.map((model) => model.id),
        ...Object.keys(settings.models),
        ...Object.keys(pricing[providerId] ?? {})
      ]).sort();
      const kind = provider?.kind ?? inferredKind(providerId, this.localProvider);
      const ready = Boolean(provider) && !discoveryError;
      const reason = discoveryError ?? this.providerUnavailableReason(
        project,
        providerId,
        kind,
        settings.enabled,
        credentialProfileId,
        credentialAvailableForProject,
        Boolean(provider)
      );

      providers.push({
        id: providerId,
        kind,
        allowed: true,
        enabled: settings.enabled,
        ready,
        reason: ready ? undefined : reason,
        credentialProfileId,
        credentialAvailable: credentialAvailableForProject,
        models: modelIds.map((modelId) => {
          const model = discoveredById.get(modelId);
          return {
            id: modelId,
            displayName: model?.displayName ?? modelId,
            available: Boolean(model),
            capabilities: model?.capabilities,
            routing: settings.models[modelId] ?? {},
            pricing: pricing[providerId]?.[modelId],
            providerDefault: settings.defaultModelId === modelId,
            projectDefault:
              project.defaultModel.mode === 'explicit' &&
              project.defaultModel.providerId === providerId &&
              project.defaultModel.modelId === modelId
          };
        })
      });
    }

    return {
      projectId: project.id,
      defaultRoutingPolicy: project.defaultRoutingPolicy,
      defaultModel: project.defaultModel,
      providers
    };
  }

  private assertCredentialBindings(
    projectId: string,
    organizationId: string,
    allowedProviderIds: string[],
    credentialProfileIds: Record<string, string>
  ): void {
    for (const [providerId, credentialId] of Object.entries(credentialProfileIds)) {
      if (!allowedProviderIds.includes(providerId)) {
        throw new Error(
          `Project ${projectId} binds credential ${credentialId} to provider ${providerId}, but that provider is not allowed.`
        );
      }
      const profile = this.credentials.getProfile(credentialId);
      if (!profile) throw new Error(`Project ${projectId} references missing credential ${credentialId}.`);
      if (profile.providerId !== providerId) {
        throw new Error(`Credential ${credentialId} belongs to ${profile.providerId}, not ${providerId}.`);
      }
      if (profile.organizationId !== organizationId) {
        throw new Error(
          `Credential ${credentialId} is outside project ${projectId}'s organization isolation boundary.`
        );
      }
    }
  }

  private providerUnavailableReason(
    project: ProjectDefinition,
    providerId: string,
    kind: ProviderKind,
    enabled: boolean,
    credentialProfileId: string | undefined,
    credentialIsAvailable: boolean | undefined,
    registered: boolean
  ): string {
    if (!enabled) return 'provider-disabled';
    if (kind === 'cloud' && !project.privacy.cloudAllowed) return 'cloud-disabled';
    if (
      kind === 'cloud' &&
      !(BUILT_IN_CLOUD_PROVIDER_IDS as readonly string[]).includes(providerId)
    ) return 'provider-not-supported';
    if (kind === 'cloud' && !credentialProfileId) return 'credential-not-bound';
    if (kind === 'cloud' && credentialIsAvailable === false) return 'credential-unavailable';
    if (!registered) return 'provider-unavailable';
    return 'model-discovery-unavailable';
  }
}
