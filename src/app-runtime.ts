import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentExecutionTarget, AgentLifecycleEvent } from './agent-runtime/index.js';
import { ManagedProcessRegistry } from './agent-tools/process/index.js';
import { AgentProductExecutionBridge } from './agent-product-execution.js';
import { AgentProductRuntime } from './agent-product-runtime.js';
import type { ExecutionBackend } from './execution-runtime.js';
import { readAppSettings, writeAppSettings, type AppSettingsFile } from './app-config.js';
import {
  CompanyContextStore,
  PERSONAL_COMPANY_ID,
  type CompanyContextSnapshot,
  type CreateCompanyInput,
  type UpdateCompanyInput
} from './company-context.js';
import { loadConfig } from './config.js';
import { CredentialManager } from './credential-store.js';
import { createExecutionRuntime } from './execution-runtime.js';
import { createLocalInferenceProvider } from './local-inference-provider.js';
import { OllamaClient } from './ollama.js';
import { ProjectAdminService, type CreateCredentialInput } from './project-admin.js';
import { projectChatDefaultModelSelection } from './project-chat-default.js';
import { ProjectProviderRuntime } from './project-provider-runtime.js';
import type { ModelSelection, CreateProjectInput } from './project-store.js';
import { ProviderConnectionRuntime } from './provider-connections.js';
import { RemoteWorkerAgentExecutionTarget } from './remote-agent-execution-target.js';
import { remoteAxisToolNames } from './remote-axis-tool-handler.js';
import { RemoteWorkerClient } from './remote-worker-client.js';
import {
  ProviderSettingsStore,
  type ProviderRuntimeSettingsPatch
} from './provider-settings.js';
import {
  StandaloneJobManager,
  type StandaloneInteractionMode,
  type StandaloneJobInput,
  type StandaloneReasoningEffort
} from './standalone-job-manager.js';
import { UsageDashboard, parseUsageDashboardPeriod } from './usage-dashboard.js';

export interface AppRuntimeRequest {
  method?: string;
  path: string;
  body?: unknown;
}

export type AppRuntimeEvent =
  | { type: 'job'; payload: { job: ReturnType<StandaloneJobManager['get']> } }
  | { type: 'worker'; payload: Record<string, unknown> }
  | { type: 'worker-error'; payload: { error: string } };

export type AppRuntimeListener = (event: AppRuntimeEvent) => void;

type JsonObject = Record<string, unknown>;
type CompanyScopedJob = NonNullable<ReturnType<StandaloneJobManager['get']>> & {
  input: StandaloneJobInput & { companyId?: string };
  lifecycleEvents: readonly AgentLifecycleEvent[];
};

function objectBody(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object.');
  }
  return value as JsonObject;
}

function requiredString(body: JsonObject, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function optionalString(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value.trim() || undefined;
}

function parseInteractionMode(value: unknown): StandaloneInteractionMode {
  if (value === undefined) return 'cowork';
  if (value === 'chat' || value === 'cowork') return value;
  throw new Error("interactionMode must be 'chat' or 'cowork'.");
}

export function parseModelSelection(value: unknown): ModelSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('modelSelection must be an object.');
  }
  const item = value as JsonObject;
  if (item.mode === 'auto') return { mode: 'auto' };
  if (
    item.mode === 'local-first' &&
    typeof item.modelId === 'string' && item.modelId.trim()
  ) {
    return {
      mode: 'local-first',
      modelId: item.modelId.trim()
    };
  }
  if (
    item.mode === 'explicit' &&
    typeof item.providerId === 'string' && item.providerId.trim() &&
    typeof item.modelId === 'string' && item.modelId.trim()
  ) {
    return {
      mode: 'explicit',
      providerId: item.providerId.trim(),
      modelId: item.modelId.trim()
    };
  }
  throw new Error('modelSelection must be auto, local-first with an Ollama model, or an explicit provider/model pair.');
}

function parseReasoningEffort(value: unknown): StandaloneReasoningEffort | undefined {
  if (value === undefined) return undefined;
  const allowed = new Set<StandaloneReasoningEffort>([
    'auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'
  ]);
  if (typeof value !== 'string' || !allowed.has(value as StandaloneReasoningEffort)) {
    throw new Error('reasoningEffort must be auto, none, low, medium, high, xhigh, or max.');
  }
  return value as StandaloneReasoningEffort;
}

function createCredentialInput(body: JsonObject): CreateCredentialInput {
  const backend = requiredString(body, 'backend');
  const base = {
    id: requiredString(body, 'id'),
    providerId: requiredString(body, 'providerId'),
    label: requiredString(body, 'label'),
    organizationId: optionalString(body, 'organizationId')
  };
  if (backend === 'macos-keychain') {
    return { ...base, backend, secret: requiredString(body, 'secret') };
  }
  if (backend === 'environment') {
    return {
      ...base,
      backend,
      environmentVariable: requiredString(body, 'environmentVariable')
    };
  }
  throw new Error('backend must be macos-keychain or environment.');
}

type RuntimeSettings = Pick<AppSettingsFile, 'remoteWorkerUrl' | 'workerHealthPath'>;

export const DEFAULT_WORKER_HEALTH_PATH = '/v1/health';

export function normalizeHealthPath(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('workerHealthPath is required.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error('workerHealthPath must be a path like /v1/health, not a full URL.');
  }
  return `/${raw.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`;
}

function toResponse(patch: RuntimeSettings): Record<string, unknown> {
  return {
    ...(patch.remoteWorkerUrl !== undefined ? { workerUrl: patch.remoteWorkerUrl } : {}),
    ...(patch.workerHealthPath !== undefined ? { workerHealthPath: patch.workerHealthPath } : {})
  };
}

export function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('A URL is required.');
  const invalid = new Error(`"${value}" is not a valid URL. Expected something like http://192.168.0.10:7337`);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw invalid;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The URL must use http or https.');
  }
  if (!parsed.hostname) throw invalid;
  return `${parsed.protocol}//${parsed.host}`;
}

// ponytail: TTL bounds staleness from changes outside the app (e.g. `claude login`
// in a terminal); in-app mutations clear the cache immediately on any non-GET request.
const CATALOG_CACHE_TTL_MS = 30_000;

export class DesktopAppRuntime {
  private readonly listeners = new Set<AppRuntimeListener>();
  // Cycle resolution (jobs -> productExecution -> agentRuntime -> jobs):
  // The fields are declared with definite-assignment assertion and constructed in the
  // constructor body in the right dependency order.
  private readonly agentRuntime: AgentProductRuntime;
  private readonly productExecution: AgentProductExecutionBridge;
  readonly jobs: StandaloneJobManager;
  private readonly config = { ...loadConfig(), executionMode: 'remote' as const };
  private readonly companyContext = new CompanyContextStore();
  private readonly ollama = new OllamaClient(this.config);
  private readonly localProvider = createLocalInferenceProvider(this.config, this.ollama);
  private readonly credentials = new CredentialManager();
  private readonly providerSettings = new ProviderSettingsStore();
  private readonly connections = new ProviderConnectionRuntime({
    localProvider: this.localProvider,
    credentials: this.credentials,
    settings: this.providerSettings
  });
  private readonly personalProviders = new ProjectProviderRuntime({
    localProvider: this.localProvider,
    credentials: this.credentials,
    settings: this.providerSettings,
    connections: this.connections
  });
  /**
   * Legacy execution runtime remains only for worker health/settings compatibility.
   * Product Chat/Cowork do not execute through its legacy engineer backend.
   */
  private readonly execution = createExecutionRuntime(
    this.config,
    this.ollama,
    this.personalProviders
  );
  private readonly projects = new ProjectAdminService({
    localProvider: this.localProvider,
    credentials: this.credentials,
    providerSettings: this.providerSettings,
    providerRuntime: this.personalProviders,
    connections: this.connections
  });
  private readonly usage = new UsageDashboard();
  private readonly processRegistry = new ManagedProcessRegistry({
    stateFile: path.join(path.dirname(this.config.runStorePath), 'sessions', 'managed-processes.json')
  });
  private workerTimer?: NodeJS.Timeout;
  private readonly catalogCache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor() {
    // The runtime needs the jobs manager (for durable checkpoints) and the jobs
    // manager needs the runtime. Build in dependency order with a placeholder,
    // then attach the real jobs manager to the runtime via the option injection.
    const placeholderExecution: Pick<ExecutionBackend, 'executeEngineer' | 'prepareEscalation' | 'consultEscalation'> = {
      executeEngineer: async () => {
        throw new Error('AgentProductRuntime not yet wired to the real product execution.');
      },
      prepareEscalation: async () => {
        throw new Error('AgentProductRuntime not yet wired to the real product execution.');
      },
      consultEscalation: async () => {
        throw new Error('AgentProductRuntime not yet wired to the real product execution.');
      }
    };
    const jobs = new StandaloneJobManager(
      placeholderExecution,
      path.join(path.dirname(this.config.runStorePath), 'sessions')
    );
    const supportedRemoteTools = remoteAxisToolNames();
    const productTarget: AgentExecutionTarget & { supports(toolName: string): boolean } = this.config.remoteWorkerUrl
      ? new RemoteWorkerAgentExecutionTarget(
          'local-worker',
          new RemoteWorkerClient(this.config),
          supportedRemoteTools
        )
      : {
          id: 'local-worker',
          supports: (toolName) => supportedRemoteTools.includes(toolName),
          execute: async () => {
            throw new Error('Local Worker is the selected execution target but no Worker URL is configured.');
          }
        };
    const runtime = new AgentProductRuntime({
      companyContext: () => this.companySnapshot(),
      projects: this.projects,
      connections: this.connections,
      providers: this.personalProviders,
      executionTarget: productTarget,
      executionTargetKind: 'worker',
      processRegistry: this.processRegistry,
      jobManager: jobs
    });
    const execution = new AgentProductExecutionBridge(runtime);
    this.agentRuntime = runtime;
    this.productExecution = execution;
    jobs.setExecution(execution);
    this.jobs = jobs;
  }

  private cachedCatalog<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.catalogCache.get(key);
    if (cached && Date.now() - cached.at < CATALOG_CACHE_TTL_MS) return cached.value as Promise<T>;
    const entry = { at: Date.now(), value: load() };
    this.catalogCache.set(key, entry);
    entry.value.catch(() => {
      if (this.catalogCache.get(key) === entry) this.catalogCache.delete(key);
    });
    return entry.value;
  }

  private companySnapshot(): CompanyContextSnapshot {
    return this.companyContext.reconcile({
      projects: this.projects.listProjects(),
      connections: this.projects.listConnections(),
      sessions: this.jobs.list()
    });
  }

  private companyForProject(projectId: string): string {
    const owners = this.companySnapshot().companies.filter((company) =>
      company.projectIds.includes(projectId)
    );
    if (owners.length !== 1) {
      throw new Error(`Project ${projectId} must belong to exactly one canonical Company.`);
    }
    return owners[0]!.id;
  }

  private patchSettings(patch: RuntimeSettings): void {
    writeAppSettings({ ...readAppSettings(), ...patch });
  }

  private archivedProjectIds(): string[] {
    const stored = readAppSettings()?.archivedProjectIds ?? [];
    if (stored.length === 0) return [];
    const live = new Set(this.projects.listProjects().map((project) => project.id));
    return stored.filter((id) => live.has(id));
  }

  private setProjectArchived(id: string, archived: boolean): void {
    const current = new Set(this.archivedProjectIds());
    if (archived) current.add(id);
    else current.delete(id);
    writeAppSettings({ ...readAppSettings(), archivedProjectIds: [...current] });
  }

  private scopedJob(
    job: NonNullable<ReturnType<StandaloneJobManager['get']>>
  ): CompanyScopedJob {
    const existing = (job.input as StandaloneJobInput & { companyId?: string })
      .companyId?.trim();
    const companyId = job.input.projectId
      ? this.companyForProject(job.input.projectId)
      : existing || PERSONAL_COMPANY_ID;
    if (existing && existing !== companyId) {
      throw new Error(
        `Conversation ${job.id} Company ${existing} does not match canonical scope ${companyId}.`
      );
    }
    return {
      ...job,
      input: {
        ...job.input,
        companyId
      },
      lifecycleEvents: this.productExecution.lifecycleEvents(job.id)
    } as CompanyScopedJob;
  }

  private personalVisibleJob(
    job: NonNullable<ReturnType<StandaloneJobManager['get']>>
  ): CompanyScopedJob | undefined {
    const scoped = this.scopedJob(job);
    if (scoped.input.projectId || scoped.input.companyId === PERSONAL_COMPANY_ID) return scoped;
    return undefined;
  }

  private requirePersonalJobAccess(id: string): CompanyScopedJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found.');
    const scoped = this.scopedJob(job);
    if (!scoped.input.projectId && scoped.input.companyId !== PERSONAL_COMPANY_ID) {
      throw new Error(
        `Conversation ${id} belongs to company scope ${scoped.input.companyId} and is not available in Personal.`
      );
    }
    return scoped;
  }

  private assertPersonalModelSelection(selection: ModelSelection | undefined): void {
    if (selection?.mode !== 'explicit') return;
    const snapshot = this.companySnapshot();
    if (snapshot.sharedConnectionIds.includes(selection.providerId)) return;
    const owner = snapshot.companies.find((company) =>
      company.connectionIds.includes(selection.providerId)
    );
    if (!owner) {
      throw new Error(`Connection ${selection.providerId} has no canonical Company binding.`);
    }
    if (owner.id !== PERSONAL_COMPANY_ID) {
      throw new Error(
        `Connection ${selection.providerId} belongs to company scope ${owner.id} and requires an explicitly bound Project.`
      );
    }
  }

  private get workerHealthPath(): string {
    return readAppSettings()?.workerHealthPath ?? DEFAULT_WORKER_HEALTH_PATH;
  }

  private connectionSettings(): Record<string, unknown> {
    return {
      workerUrl: this.config.remoteWorkerUrl,
      workerHealthPath: this.workerHealthPath
    };
  }

  static async create(): Promise<DesktopAppRuntime> {
    const runtime = new DesktopAppRuntime();
    await runtime.jobs.restore();
    runtime.jobs.subscribe((_event, job) => {
      const visible = runtime.personalVisibleJob(job);
      if (visible) runtime.emit({ type: 'job', payload: { job: visible } });
    });
    runtime.productExecution.subscribeAgentLifecycle((event) => {
      const job = runtime.jobs.get(event.sessionId);
      if (!job) return;
      const visible = runtime.personalVisibleJob(job);
      if (visible) runtime.emit({ type: 'job', payload: { job: visible } });
    });
    runtime.startWorkerMonitor();
    return runtime;
  }

  subscribe(listener: AppRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.workerTimer = undefined;
    this.listeners.clear();
  }

  async request(request: AppRuntimeRequest): Promise<unknown> {
    const method = (request.method ?? 'GET').toUpperCase();
    const url = new URL(request.path, 'app://local-coder');
    const pathname = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';

    // Mutations can change credentials, connections, providers or projects,
    // all of which feed the model catalogs.
    if (method !== 'GET') this.catalogCache.clear();

    if (method === 'GET' && pathname === '/companies') {
      return {
        companies: this.companyContext.listCompanies({
          includeArchived: url.searchParams.get('archived') === 'all',
          query: url.searchParams.get('q') ?? undefined
        })
      };
    }
    if (method === 'POST' && pathname === '/companies') {
      return {
        company: this.companyContext.createCompany(
          objectBody(request.body) as unknown as CreateCompanyInput
        )
      };
    }
    if (method === 'POST' && pathname === '/companies/order') {
      const body = objectBody(request.body);
      if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
        throw new Error('ids must be an array of company ids.');
      }
      return { companies: this.companyContext.reorderCompanies(body.ids as string[]) };
    }
    const companyMatch = /^\/companies\/(?!(?:context|order)$)([^/]+)$/.exec(pathname);
    if (companyMatch && method === 'GET') {
      return { company: this.companyContext.getCompany(decodeURIComponent(companyMatch[1])) };
    }
    if (companyMatch && method === 'PATCH') {
      return {
        company: this.companyContext.updateCompany(
          decodeURIComponent(companyMatch[1]),
          objectBody(request.body) as unknown as UpdateCompanyInput
        )
      };
    }
    const companyArchiveMatch = /^\/companies\/([^/]+)\/archive$/.exec(pathname);
    if (companyArchiveMatch && method === 'POST') {
      const body = objectBody(request.body);
      if (typeof body.archived !== 'boolean') throw new Error('archived must be a boolean.');
      return {
        company: this.companyContext.setCompanyArchived(
          decodeURIComponent(companyArchiveMatch[1]),
          body.archived
        )
      };
    }
    if (method === 'GET' && pathname === '/companies/context') {
      return { context: this.companySnapshot() };
    }

    if (method === 'GET' && pathname === '/jobs') {
      return {
        jobs: this.jobs.list()
          .map((job) => this.personalVisibleJob(job))
          .filter(Boolean)
      };
    }
    if (method === 'POST' && pathname === '/jobs') {
      const body = objectBody(request.body);
      const projectId = optionalString(body, 'projectId');
      const interactionMode = parseInteractionMode(body.interactionMode);
      const project = projectId ? this.projects.getProject(projectId) : undefined;
      const workspace = project
        ? project.workspace
        : interactionMode === 'chat'
          ? optionalString(body, 'workspace') ?? ''
          : requiredString(body, 'workspace');
      const requestedModelSelection = parseModelSelection(body.modelSelection);
      const input: StandaloneJobInput & { companyId: string } = {
        companyId: projectId ? this.companyForProject(projectId) : PERSONAL_COMPANY_ID,
        projectId,
        workspace,
        goal: requiredString(body, 'goal'),
        context: optionalString(body, 'context'),
        constraints: Array.isArray(body.constraints)
          ? body.constraints.filter((item): item is string => typeof item === 'string')
          : undefined,
        language: optionalString(body, 'language'),
        maxRepairRounds:
          typeof body.maxRepairRounds === 'number' && Number.isInteger(body.maxRepairRounds)
            ? Math.max(0, Math.min(body.maxRepairRounds, 2))
            : 1,
        interactionMode,
        modelSelection: requestedModelSelection ?? (
          project && interactionMode === 'chat'
            ? projectChatDefaultModelSelection(project)
            : undefined
        ),
        reasoningEffort: parseReasoningEffort(body.reasoningEffort)
      };
      if (
        !projectId &&
        interactionMode !== 'chat' &&
        (input.modelSelection || (
          input.reasoningEffort && input.reasoningEffort !== 'auto'
        ))
      ) {
        throw new Error('Model and effort overrides require a configured Project for Cowork.');
      }
      if (!projectId && interactionMode === 'chat') {
        if (input.modelSelection?.mode === 'local-first') {
          throw new Error(
            'Local-first requires a Project because bounded cloud escalation uses Project privacy and credential bindings.'
          );
        }
        this.assertPersonalModelSelection(input.modelSelection);
      }
      return { job: this.scopedJob(this.jobs.create(input)) };
    }

    const jobMatch = /^\/jobs\/([A-Za-z0-9-]+)$/.exec(pathname);
    if (method === 'GET' && jobMatch) {
      return { job: this.requirePersonalJobAccess(jobMatch[1]) };
    }
    const contextMatch = /^\/jobs\/([A-Za-z0-9-]+)\/context$/.exec(pathname);
    if (contextMatch) {
      this.requirePersonalJobAccess(contextMatch[1]);
      if (method === 'GET') return { usage: this.agentRuntime.contextUsage(contextMatch[1]) ?? null };
      if (method === 'POST') {
        const body = objectBody(request.body ?? {});
        const maxBytes = typeof body.maxBytes === 'number' ? body.maxBytes : undefined;
        return { usage: await this.agentRuntime.compactSessionContext(contextMatch[1], maxBytes) };
      }
    }
    const followUpMatch = /^\/jobs\/([A-Za-z0-9-]+)\/follow-up$/.exec(pathname);
    if (method === 'POST' && followUpMatch) {
      const body = objectBody(request.body);
      const current = this.requirePersonalJobAccess(followUpMatch[1]);
      const modelSelection = parseModelSelection(body.modelSelection);
      const reasoningEffort = parseReasoningEffort(body.reasoningEffort);
      if (!current.input.projectId) {
        if (modelSelection?.mode === 'local-first') {
          throw new Error(
            'Local-first requires a Project because bounded cloud escalation uses Project privacy and credential bindings.'
          );
        }
        this.assertPersonalModelSelection(modelSelection);
      }
      return {
        job: this.scopedJob(await this.jobs.followUp(
          followUpMatch[1],
          requiredString(body, 'message'),
          { modelSelection, reasoningEffort }
        ))
      };
    }
    const turnRetryMatch = /^\/jobs\/([A-Za-z0-9-]+)\/turns\/([A-Za-z0-9-]+)\/retry$/.exec(pathname);
    if (method === 'POST' && turnRetryMatch) {
      const body = objectBody(request.body ?? {});
      const current = this.requirePersonalJobAccess(turnRetryMatch[1]);
      const modelSelection = parseModelSelection(body.modelSelection);
      const reasoningEffort = parseReasoningEffort(body.reasoningEffort);
      if (!current.input.projectId) {
        if (modelSelection?.mode === 'local-first') {
          throw new Error(
            'Local-first requires a Project because bounded cloud escalation uses Project privacy and credential bindings.'
          );
        }
        this.assertPersonalModelSelection(modelSelection);
      }
      return {
        job: this.scopedJob(await this.jobs.retryTurn(
          turnRetryMatch[1],
          turnRetryMatch[2],
          optionalString(body, 'message'),
          { modelSelection, reasoningEffort }
        ))
      };
    }
    if (method === 'PATCH' && jobMatch) {
      const body = objectBody(request.body);
      const id = jobMatch[1];
      this.requirePersonalJobAccess(id);
      if (body.title !== undefined) {
        return { job: await this.jobs.rename(id, requiredString(body, 'title')) };
      }
      if (body.archived !== undefined) {
        if (typeof body.archived !== 'boolean') throw new Error('archived must be a boolean.');
        return { job: await this.jobs.setArchived(id, body.archived) };
      }
      throw new Error('Supply title or archived.');
    }
    if (method === 'DELETE' && jobMatch) {
      this.requirePersonalJobAccess(jobMatch[1]);
      const removed = await this.jobs.remove(jobMatch[1]);
      if (removed) this.productExecution.clearSession(jobMatch[1]);
      return { removed };
    }
    const cancelMatch = /^\/jobs\/([A-Za-z0-9-]+)\/cancel$/.exec(pathname);
    if (method === 'POST' && cancelMatch) {
      this.requirePersonalJobAccess(cancelMatch[1]);
      return { job: await this.jobs.cancel(cancelMatch[1]) };
    }
    const decisionMatch = /^\/jobs\/([A-Za-z0-9-]+)\/decision$/.exec(pathname);
    if (method === 'POST' && decisionMatch) {
      this.requirePersonalJobAccess(decisionMatch[1]);
      const body = objectBody(request.body);
      const selections: Record<string, string> = {};
      if (
        body.selections &&
        typeof body.selections === 'object' &&
        !Array.isArray(body.selections)
      ) {
        for (const [key, value] of Object.entries(body.selections as JsonObject)) {
          if (typeof value === 'string') selections[key] = value;
        }
      }
      return {
        job: this.scopedJob(this.jobs.submitDecision(decisionMatch[1], selections))
      };
    }
    const guidanceMatch = /^\/jobs\/([A-Za-z0-9-]+)\/guidance$/.exec(pathname);
    if (method === 'POST' && guidanceMatch) {
      this.requirePersonalJobAccess(guidanceMatch[1]);
      const body = objectBody(request.body);
      return {
        job: this.scopedJob(this.jobs.submitGuidance(
          guidanceMatch[1],
          requiredString(body, 'guidance')
        ))
      };
    }
    const recoveryMatch = /^\/jobs\/([A-Za-z0-9-]+)\/mutation-recovery$/.exec(pathname);
    if (method === 'POST' && recoveryMatch) {
      const body = objectBody(request.body);
      const decision = body.decision;
      if (decision !== 'retry-confirmed' && decision !== 'accept-committed' && decision !== 'cancel') {
        throw new Error('decision must be retry-confirmed, accept-committed, or cancel.');
      }
      return {
        job: this.scopedJob(this.jobs.resolveIndeterminateMutation(recoveryMatch[1], decision))
      };
    }
    const escalationMatch = /^\/jobs\/([A-Za-z0-9-]+)\/escalate$/.exec(pathname);
    if (method === 'POST' && escalationMatch) {
      this.requirePersonalJobAccess(escalationMatch[1]);
      const body = objectBody(request.body);
      const effort = parseReasoningEffort(body.reasoningEffort);
      return {
        job: this.scopedJob(await this.jobs.submitEscalation(escalationMatch[1], {
          providerId: requiredString(body, 'providerId'),
          modelId: requiredString(body, 'modelId'),
          reasoningEffort: effort === 'auto' ? undefined : effort
        }))
      };
    }

    if (method === 'GET' && pathname === '/chat/catalog') {
      return { catalog: await this.cachedCatalog('personal', () => this.personalProviders.personalChatCatalog()) };
    }
    if (method === 'GET' && pathname === '/usage') {
      const period = parseUsageDashboardPeriod(url.searchParams.get('period'));
      return { usage: this.usage.summary(period) };
    }

    if (method === 'GET' && pathname === '/projects') {
      const archived = new Set(this.archivedProjectIds());
      return {
        projects: this.projects.listProjects().map((project) => ({
          ...project,
          archived: archived.has(project.id)
        }))
      };
    }
    if (method === 'POST' && pathname === '/projects') {
      return {
        project: this.projects.createProject(
          objectBody(request.body) as unknown as CreateProjectInput
        )
      };
    }
    const projectMatch = /^\/projects\/([^/]+)$/.exec(pathname);
    if (projectMatch && method === 'GET') {
      return { project: this.projects.getProject(decodeURIComponent(projectMatch[1])) };
    }
    if (projectMatch && method === 'PATCH') {
      return {
        project: this.projects.updateProject(
          decodeURIComponent(projectMatch[1]),
          objectBody(request.body) as unknown as Partial<Omit<CreateProjectInput, 'id'>>
        )
      };
    }
    const projectArchiveMatch = /^\/projects\/([^/]+)\/archive$/.exec(pathname);
    if (projectArchiveMatch && method === 'POST') {
      const id = decodeURIComponent(projectArchiveMatch[1]);
      const body = objectBody(request.body);
      if (typeof body.archived !== 'boolean') throw new Error('archived must be a boolean.');
      this.projects.getProject(id);
      this.setProjectArchived(id, body.archived);
      return { project: { ...this.projects.getProject(id), archived: body.archived } };
    }
    if (projectMatch && method === 'DELETE') {
      const id = decodeURIComponent(projectMatch[1]);
      const held = this.jobs.list().filter((job) => job.input.projectId === id);
      if (held.length > 0) {
        throw new Error(
          `${id} still holds ${held.length} conversation${held.length === 1 ? '' : 's'}. Archive or delete them first.`
        );
      }
      const removed = this.projects.removeProject(id);
      this.setProjectArchived(id, false);
      return { removed };
    }
    const catalogMatch = /^\/projects\/([^/]+)\/catalog$/.exec(pathname);
    if (catalogMatch && method === 'GET') {
      const projectId = decodeURIComponent(catalogMatch[1]);
      return { catalog: await this.cachedCatalog(`project:${projectId}`, () => this.projects.catalog(projectId)) };
    }
    const usageMatch = /^\/projects\/([^/]+)\/usage$/.exec(pathname);
    if (usageMatch && method === 'GET') {
      return { usage: this.projects.usage(decodeURIComponent(usageMatch[1])) };
    }

    if (method === 'GET' && pathname === '/providers') {
      return { providers: this.projects.listProviders() };
    }
    const providerMatch = /^\/providers\/([^/]+)$/.exec(pathname);
    if (providerMatch && method === 'PATCH') {
      return {
        settings: this.projects.updateProvider(
          decodeURIComponent(providerMatch[1]),
          objectBody(request.body) as unknown as ProviderRuntimeSettingsPatch
        )
      };
    }

    if (method === 'GET' && pathname === '/credentials') {
      return { credentials: this.projects.listCredentials() };
    }
    if (method === 'POST' && pathname === '/credentials') {
      return {
        credential: this.projects.createCredential(
          createCredentialInput(objectBody(request.body))
        )
      };
    }
    const credentialMatch = /^\/credentials\/([^/]+)$/.exec(pathname);
    if (credentialMatch && method === 'DELETE') {
      return {
        removed: this.projects.removeCredential(decodeURIComponent(credentialMatch[1]))
      };
    }

    if (method === 'GET' && pathname === '/health') {
      return { ok: true, execution: await this.execution.health() };
    }

    if (method === 'GET' && pathname === '/settings') {
      return { settings: this.connectionSettings() };
    }
    if (method === 'PUT' && pathname === '/settings') {
      const body = objectBody(request.body);
      const patch: RuntimeSettings = {};

      if (body.workerUrl !== undefined) {
        patch.remoteWorkerUrl = normalizeBaseUrl(requiredString(body, 'workerUrl'));
      }
      if (body.workerHealthPath !== undefined) {
        patch.workerHealthPath = normalizeHealthPath(requiredString(body, 'workerHealthPath'));
      }

      if (Object.keys(patch).length === 0) {
        throw new Error('No supported settings in request.');
      }
      this.patchSettings(patch);
      return {
        settings: {
          ...this.connectionSettings(),
          ...toResponse(patch),
          restartRequired: true
        }
      };
    }

    if (method === 'POST' && pathname === '/settings/probe-worker') {
      const body = objectBody(request.body);
      const target = normalizeBaseUrl(requiredString(body, 'workerUrl'));
      const healthPath = normalizeHealthPath(
        body.workerHealthPath === undefined
          ? this.workerHealthPath
          : requiredString(body, 'workerHealthPath')
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4_000);
      try {
        const response = await fetch(`${target}${healthPath}`, {
          signal: controller.signal
        });
        if (!response.ok) {
          return {
            reachable: false,
            status: response.status,
            error: `HTTP ${response.status} from ${healthPath}`
          };
        }
        const text = (await response.text().catch(() => '')).trim();
        return {
          reachable: true,
          status: response.status,
          detail: text.slice(0, 120) || undefined
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          reachable: false,
          error: controller.signal.aborted ? 'Timed out after 4s' : message
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    if (method === 'GET' && pathname === '/fs/exists') {
      const raw = url.searchParams.get('path')?.trim();
      if (!raw) return { exists: false };
      const target = raw === '~' || raw.startsWith('~/')
        ? path.join(os.homedir(), raw.slice(2))
        : path.resolve(raw);
      try {
        const stat = await fs.stat(target);
        return { exists: stat.isDirectory(), path: target };
      } catch {
        return { exists: false, path: target };
      }
    }

    throw new Error(`Unsupported app runtime request: ${method} ${pathname}`);
  }

  private startWorkerMonitor(): void {
    const publish = async () => {
      try {
        this.emit({
          type: 'worker',
          payload: await this.execution.health() as Record<string, unknown>
        });
      } catch (error) {
        this.emit({
          type: 'worker-error',
          payload: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    };
    void publish();
    this.workerTimer = setInterval(() => void publish(), 1_500);
    this.workerTimer.unref();
  }

  private emit(event: AppRuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
