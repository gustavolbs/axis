import { apiCredentialConnectionId, LOCAL_ORGANIZATION_ID } from './connection-identity.js';
import {
  CredentialManager,
  type CredentialProfile
} from './credential-store.js';
import {
  PricingStore,
  type ModelPricing
} from './pricing-store.js';
import {
  ProviderConnectionRuntime,
  type ProviderConnectionView
} from './provider-connections.js';
import {
  BUILT_IN_CLOUD_PROVIDER_IDS,
  ProjectProviderRuntime
} from './project-provider-runtime.js';
import {
  ProjectStore,
  assertProjectCredentialIsolation,
  effectiveProjectConnectionPolicy,
  type CreateProjectInput,
  type ModelSelection,
  type ProjectBudgetPolicy,
  type ProjectConnectionPolicy,
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
import { WorkHubSourceStore } from './work-hub.js';

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
  createdAt?: string;
  available: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ProviderCapabilities>;
  routing: ModelRoutingProfile;
  pricing?: ModelPricing;
  providerDefault: boolean;
  projectDefault: boolean;
}

export interface ProjectCatalogProvider {
  /** Exact connection id for first-class built-ins; legacy custom provider id otherwise. */
  id: string;
  label?: string;
  providerFamily?: string;
  organizationId?: string;
  auth?: ProviderConnectionView['auth'];
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
  /** Compatibility alias for Cowork default. */
  defaultModel: ProjectDefinition['defaultModel'];
  chatDefaultModel?: ModelSelection;
  coworkDefaultModel: ModelSelection;
  connectionPolicy: ProjectConnectionPolicy;
  providers: ProjectCatalogProvider[];
}

export interface ProjectUsageView {
  projectId: string;
  budgets: ProjectBudgetPolicy;
  daily: UsagePeriodSummary;
  monthly: UsagePeriodSummary;
  activeReservations: { count: number; upperBoundUsd: number };
}

export interface ProjectAdminServiceOptions {
  projects?: ProjectStore;
  credentials?: CredentialManager;
  providerSettings?: ProviderSettingsStore;
  pricing?: PricingStore;
  ledger?: UsageLedger;
  localProvider?: InferenceProvider;
  providerRuntime?: ProjectProviderRuntime;
  connections?: ProviderConnectionRuntime;
  workHubSources?: WorkHubSourceStore;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function credentialAvailable(manager: CredentialManager, id: string): boolean {
  try { return Boolean(manager.resolve(id)); } catch { return false; }
}

function credentialView(manager: CredentialManager, profile: CredentialProfile): CredentialView {
  return {
    id: profile.id,
    providerId: profile.providerId,
    label: profile.label,
    organizationId: profile.organizationId,
    backend: profile.secret.backend,
    environmentVariable: profile.secret.backend === 'environment' ? profile.secret.id : undefined,
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
  private readonly connections: ProviderConnectionRuntime;
  private readonly workHubSources: WorkHubSourceStore;
  private readonly providerRuntime: ProjectProviderRuntime;

  constructor(options: ProjectAdminServiceOptions = {}) {
    this.projects = options.projects ?? new ProjectStore();
    this.credentials = options.credentials ?? new CredentialManager();
    this.providerSettings = options.providerSettings ?? new ProviderSettingsStore();
    this.pricing = options.pricing ?? new PricingStore();
    this.ledger = options.ledger ?? new UsageLedger();
    this.localProvider = options.localProvider;
    this.connections = options.connections ?? new ProviderConnectionRuntime({
      localProvider: this.localProvider,
      credentials: this.credentials,
      settings: this.providerSettings
    });
    this.workHubSources = options.workHubSources ?? new WorkHubSourceStore();
    this.providerRuntime = options.providerRuntime ?? new ProjectProviderRuntime({
      localProvider: this.localProvider,
      credentials: this.credentials,
      settings: this.providerSettings,
      connections: this.connections
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

  listConnections(): ProviderConnectionView[] {
    return this.connections.list();
  }

  async resolveProjectChatSelection(projectId: string): Promise<ModelSelection> {
    return await this.providerRuntime.projectChatSelection(this.getProject(projectId));
  }

  createProject(input: CreateProjectInput): ProjectDefinition {
    this.assertCredentialBindings(
      input.id ?? '[new-project]',
      input.organizationId,
      input.privacy?.allowedProviderIds ?? ['ollama'],
      input.credentialProfileIds ?? {}
    );
    if (input.connectionPolicy) {
      this.assertConnectionBindings(
        input.id ?? '[new-project]',
        input.organizationId,
        input.privacy ?? { cloudAllowed: false, allowedProviderIds: ['ollama'] },
        input.credentialProfileIds ?? {},
        input.connectionPolicy
      );
    }
    const project = this.projects.create(input);
    assertProjectCredentialIsolation(project, this.credentials.list());
    this.assertStoredConnectionPolicy(project);
    return project;
  }

  updateProject(id: string, patch: Partial<Omit<CreateProjectInput, 'id'>>): ProjectDefinition {
    const current = this.getProject(id);
    const organizationId = patch.organizationId ?? current.organizationId;
    const privacy = patch.privacy ?? current.privacy;
    const credentialProfileIds = patch.credentialProfileIds ?? current.credentialProfileIds;
    const connectionPolicy = patch.connectionPolicy ?? effectiveProjectConnectionPolicy(current);
    this.assertCredentialBindings(current.id, organizationId, privacy.allowedProviderIds, credentialProfileIds);
    this.assertConnectionBindings(current.id, organizationId, privacy, credentialProfileIds, connectionPolicy);
    const project = this.projects.update(id, patch);
    assertProjectCredentialIsolation(project, this.credentials.list());
    this.assertStoredConnectionPolicy(project);
    return project;
  }

  removeProject(id: string): boolean {
    return this.projects.remove(id);
  }

  listCredentials(): CredentialView[] {
    return this.credentials.list().map((profile) => credentialView(this.credentials, profile));
  }

  createCredential(input: CreateCredentialInput): CredentialView {
    this.assertCredentialReplacementIsolation(input);
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
    const profile = this.credentials.getProfile(id);
    const exactConnectionId = profile ? apiCredentialConnectionId(profile.providerId, profile.id) : undefined;
    const referencedBy = this.projects.list()
      .filter((project) => {
        if (Object.values(project.credentialProfileIds ?? {}).includes(id)) return true;
        if (!exactConnectionId) return false;
        const policy = effectiveProjectConnectionPolicy(project);
        return policy.chat.allowedConnectionIds.includes(exactConnectionId) ||
          policy.inference.allowedConnectionIds.includes(exactConnectionId);
      })
      .map((project) => project.id);
    if (referencedBy.length > 0) {
      throw new Error(`Credential ${id} is still referenced by Project(s): ${referencedBy.join(', ')}.`);
    }
    return this.credentials.remove(id);
  }

  listProviders(): ProviderAdminView[] {
    const settings = this.providerSettings.list();
    const pricing = this.pricing.list();
    const credentials = this.listCredentials();
    const projectProviderIds = this.projects.list().flatMap((project) => project.privacy.allowedProviderIds);
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
      builtIn: id === (this.localProvider?.id ?? 'ollama') || (BUILT_IN_CLOUD_PROVIDER_IDS as readonly string[]).includes(id),
      settings: settings[id] ?? { enabled: true, models: {} },
      credentials: credentials.filter((credential) => credential.providerId === id),
      pricing: pricing[id] ?? {}
    }));
  }

  updateProvider(providerId: string, patch: ProviderRuntimeSettingsPatch): ProviderRuntimeSettings {
    return this.providerSettings.update(providerId, patch);
  }

  removeProviderSettings(providerId: string): boolean {
    return this.providerSettings.remove(providerId);
  }

  listPricing(): Record<string, Record<string, ModelPricing>> {
    return this.pricing.list();
  }

  async setPricing(providerId: string, modelId: string, value: ModelPricing): Promise<ModelPricing> {
    return await this.ledger.withBudgetLock(() => {
      this.assertPricingMutable(providerId, modelId);
      return this.pricing.set(providerId, modelId, value);
    });
  }

  async removePricing(providerId: string, modelId: string): Promise<boolean> {
    return await this.ledger.withBudgetLock(() => {
      this.assertPricingMutable(providerId, modelId);
      return this.pricing.remove(providerId, modelId);
    });
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
        upperBoundUsd: roundUsd(reservations.reduce((sum, reservation) => sum + reservation.upperBoundCostUsd, 0))
      }
    };
  }

  async catalog(projectId: string): Promise<ProjectCatalog> {
    const project = this.getProject(projectId);
    const policy = effectiveProjectConnectionPolicy(project);
    const registry = this.providerRuntime.buildRegistry(project);
    const providers: ProjectCatalogProvider[] = [];
    const allConnectionIds = unique([
      ...policy.chat.allowedConnectionIds,
      ...policy.inference.allowedConnectionIds
    ]);

    for (const providerId of allConnectionIds) {
      const connection = this.connections.view(providerId);
      const settingsId = connection?.providerFamily ?? providerId;
      const settings = this.providerSettings.get(settingsId) ?? { enabled: true, models: {} };
      const credentialProfileId = connection?.credentialId ?? project.credentialProfileIds?.[providerId];
      const credentialAvailableForProject = credentialProfileId
        ? credentialAvailable(this.credentials, credentialProfileId)
        : undefined;
      const provider = registry.has(providerId) ? registry.get(providerId) : undefined;
      let discovered: ModelDefinition[] = [];
      let discoveryError: string | undefined;
      if (provider) {
        try { discovered = await provider.listModels(); }
        catch (error) { discoveryError = error instanceof Error ? error.message : String(error); }
      }
      const discoveredById = modelMap(discovered);
      const modelIds = unique([
        ...discovered.map((model) => model.id),
        ...Object.keys(settings.models),
        ...(connection?.auth === 'api-key'
          ? Object.keys(this.pricing.list()[connection.providerFamily] ?? {})
          : Object.keys(this.pricing.list()[providerId] ?? {}))
      ]).sort();
      const kind = provider?.kind ?? inferredKind(providerId, this.localProvider);
      const ready = Boolean(provider) && !discoveryError;
      const reason = discoveryError ?? (ready ? undefined : connection?.reason ?? this.providerUnavailableReason(
        project,
        providerId,
        kind,
        settings.enabled,
        credentialProfileId,
        credentialAvailableForProject,
        Boolean(provider)
      ));

      providers.push({
        id: providerId,
        label: connection?.label,
        providerFamily: connection?.providerFamily,
        organizationId: connection?.organizationId,
        auth: connection?.auth,
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
            createdAt: model?.createdAt,
            available: Boolean(model),
            contextWindow: model?.contextWindow,
            maxOutputTokens: model?.maxOutputTokens,
            capabilities: model?.capabilities,
            routing: settings.models[modelId] ?? {},
            pricing: this.pricing.get(providerId, modelId),
            providerDefault: settings.defaultModelId === modelId,
            projectDefault:
              project.defaultModel.mode === 'explicit' &&
              project.defaultModel.providerId === providerId &&
              project.defaultModel.modelId === modelId
          };
        })
      });
    }

    let chatDefaultModel: ModelSelection | undefined;
    try { chatDefaultModel = await this.providerRuntime.projectChatSelection(project); } catch { /* surface unavailable default in UI */ }
    return {
      projectId: project.id,
      defaultRoutingPolicy: project.defaultRoutingPolicy,
      defaultModel: project.defaultModel,
      chatDefaultModel,
      coworkDefaultModel: project.defaultModel,
      connectionPolicy: policy,
      providers
    };
  }

  private assertStoredConnectionPolicy(project: ProjectDefinition): void {
    this.assertConnectionBindings(
      project.id,
      project.organizationId,
      project.privacy,
      project.credentialProfileIds ?? {},
      effectiveProjectConnectionPolicy(project)
    );
  }

  private assertConnectionBindings(
    projectId: string,
    organizationId: string,
    privacy: ProjectDefinition['privacy'],
    credentialProfileIds: Record<string, string>,
    policy: ProjectConnectionPolicy
  ): void {
    const legacyCredentialIds = new Set(Object.values(credentialProfileIds));
    const connectionIds = unique([
      ...policy.chat.allowedConnectionIds,
      ...policy.inference.allowedConnectionIds
    ]);
    for (const connectionId of connectionIds) {
      if (connectionId === 'ollama' || connectionId === this.localProvider?.id) {
        if (!privacy.allowedProviderIds.includes('ollama')) {
          throw new Error(`Project ${projectId} binds local connection ${connectionId}, but Ollama is not allowed.`);
        }
        continue;
      }
      const connection = this.connections.view(connectionId);
      if (!connection) {
        // A custom provider may still use its legacy provider id as its exact connection id.
        if (!privacy.allowedProviderIds.includes(connectionId)) {
          throw new Error(`Project ${projectId} references unknown connection ${connectionId}.`);
        }
        continue;
      }
      if (!privacy.allowedProviderIds.includes(connection.providerFamily)) {
        throw new Error(
          `Project ${projectId} binds ${connection.label}, but provider family ${connection.providerFamily} is not allowed.`
        );
      }
      if (connection.providerFamily !== 'ollama' && !privacy.cloudAllowed) {
        throw new Error(`Project ${projectId} binds cloud connection ${connection.label} while cloud inference is disabled.`);
      }
      const legacyException = connection.auth === 'api-key' &&
        Boolean(connection.credentialId && legacyCredentialIds.has(connection.credentialId));
      if (
        connection.organizationId !== LOCAL_ORGANIZATION_ID &&
        connection.organizationId !== organizationId &&
        !legacyException
      ) {
        throw new Error(
          `Connection ${connection.label} belongs to organization ${connection.organizationId}, not Project ${projectId} organization ${organizationId}.`
        );
      }
    }

    if (policy.chat.defaultConnectionId && !policy.chat.allowedConnectionIds.includes(policy.chat.defaultConnectionId)) {
      throw new Error(`Project ${projectId} default Chat connection is outside its Chat allowlist.`);
    }
    if (policy.inference.preferredConnectionId && !policy.inference.allowedConnectionIds.includes(policy.inference.preferredConnectionId)) {
      throw new Error(`Project ${projectId} preferred inference connection is outside its inference allowlist.`);
    }
    for (const sourceId of policy.workSourceIds) {
      const source = this.workHubSources.get(sourceId);
      if (!source) throw new Error(`Project ${projectId} references missing Work Hub source ${sourceId}.`);
      const sourceConnection = this.connections.view(source.connectionId);
      if (!sourceConnection) throw new Error(`Work Hub source ${sourceId} uses missing connection ${source.connectionId}.`);
      if (sourceConnection.organizationId !== organizationId) {
        throw new Error(
          `Work Hub source ${sourceId} belongs to organization ${sourceConnection.organizationId}, not Project ${projectId} organization ${organizationId}.`
        );
      }
    }
  }

  private assertPricingMutable(providerId: string, modelId: string): void {
    const active = this.ledger.listReservations().filter(
      (reservation) => reservation.providerId === providerId && reservation.modelId === modelId
    );
    if (active.length > 0) {
      throw new Error(`Pricing for ${providerId}/${modelId} cannot change while ${active.length} budget reservation(s) are active.`);
    }
  }

  private assertCredentialReplacementIsolation(input: CreateCredentialInput): void {
    const existing = this.credentials.getProfile(input.id);
    if (existing && existing.secret.backend !== input.backend) {
      throw new Error(`Credential ${input.id} already uses ${existing.secret.backend}; remove it before changing secret backends.`);
    }
    for (const project of this.projects.list()) {
      for (const [providerId, credentialId] of Object.entries(project.credentialProfileIds ?? {})) {
        if (credentialId !== input.id) continue;
        if (providerId !== input.providerId) {
          throw new Error(`Credential ${input.id} is bound to provider ${providerId} by Project ${project.id}; it cannot be reassigned to ${input.providerId}.`);
        }
        if (input.organizationId !== undefined && input.organizationId !== project.organizationId) {
          throw new Error(`Credential ${input.id} is referenced by Project ${project.id} in organization ${project.organizationId}; it cannot be moved outside that organization.`);
        }
      }
    }
  }

  private assertCredentialBindings(
    projectId: string,
    organizationId: string,
    allowedProviderIds: string[],
    credentialProfileIds: Record<string, string>
  ): void {
    for (const [providerId, credentialId] of Object.entries(credentialProfileIds)) {
      if (!allowedProviderIds.includes(providerId)) {
        throw new Error(`Project ${projectId} binds credential ${credentialId} to provider ${providerId}, but that provider is not allowed.`);
      }
      const profile = this.credentials.getProfile(credentialId);
      if (!profile) throw new Error(`Project ${projectId} references missing credential ${credentialId}.`);
      if (profile.providerId !== providerId) throw new Error(`Credential ${credentialId} belongs to ${profile.providerId}, not ${providerId}.`);
      if (profile.organizationId !== undefined && profile.organizationId !== organizationId) {
        throw new Error(`Credential ${credentialId} is outside project ${projectId}'s organization isolation boundary.`);
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
    if (kind === 'cloud' && !this.connections.view(providerId) && !(BUILT_IN_CLOUD_PROVIDER_IDS as readonly string[]).includes(providerId)) {
      return 'provider-not-supported';
    }
    if (kind === 'cloud' && !registered) {
      if (!this.connections.view(providerId) && !credentialProfileId) return 'credential-not-bound';
      if (credentialIsAvailable === false) return 'credential-unavailable';
      return 'provider-unavailable';
    }
    return 'model-discovery-unavailable';
  }
}
