import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from './config.js';
import { createExecutionRuntime } from './execution-runtime.js';
import { createControlPlaneLocalProvider } from './local-inference-provider.js';
import { OllamaClient } from './ollama.js';
import { ProjectAdminService, type CreateCredentialInput } from './project-admin.js';
import type { ModelSelection, CreateProjectInput } from './project-store.js';
import type { ProviderRuntimeSettingsPatch } from './provider-settings.js';
import {
  StandaloneJobManager,
  type StandaloneJobInput,
  type StandaloneReasoningEffort
} from './standalone-job-manager.js';

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

function parseModelSelection(value: unknown): ModelSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('modelSelection must be an object.');
  }
  const item = value as JsonObject;
  if (item.mode === 'auto') return { mode: 'auto' };
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
  throw new Error('modelSelection must be auto or an explicit provider/model pair.');
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

export class DesktopAppRuntime {
  private readonly listeners = new Set<AppRuntimeListener>();
  private readonly config = loadConfig();
  private readonly ollama = new OllamaClient(this.config);
  private readonly execution = createExecutionRuntime(this.config, this.ollama);
  private readonly projects = new ProjectAdminService({
    localProvider: createControlPlaneLocalProvider(this.config, this.ollama)
  });
  private readonly jobs = new StandaloneJobManager(
    this.execution.execution,
    path.join(path.dirname(this.config.runStorePath), 'sessions')
  );
  private workerTimer?: NodeJS.Timeout;

  static async create(): Promise<DesktopAppRuntime> {
    const runtime = new DesktopAppRuntime();
    await runtime.jobs.restore();
    runtime.jobs.subscribe((_event, job) => runtime.emit({ type: 'job', payload: { job } }));
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

    if (method === 'GET' && pathname === '/jobs') return { jobs: this.jobs.list() };
    if (method === 'POST' && pathname === '/jobs') {
      const body = objectBody(request.body);
      const projectId = optionalString(body, 'projectId');
      const workspace = projectId
        ? this.projects.getProject(projectId).workspace
        : requiredString(body, 'workspace');
      const input: StandaloneJobInput = {
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
        modelSelection: parseModelSelection(body.modelSelection),
        reasoningEffort: parseReasoningEffort(body.reasoningEffort)
      };
      if (!projectId && (input.modelSelection || (input.reasoningEffort && input.reasoningEffort !== 'auto'))) {
        throw new Error('Model and effort overrides require a configured Project.');
      }
      return { job: this.jobs.create(input) };
    }

    const jobMatch = /^\/jobs\/([A-Za-z0-9-]+)$/.exec(pathname);
    if (method === 'GET' && jobMatch) {
      const job = this.jobs.get(jobMatch[1]);
      if (!job) throw new Error('Job not found.');
      return { job };
    }
    const cancelMatch = /^\/jobs\/([A-Za-z0-9-]+)\/cancel$/.exec(pathname);
    if (method === 'POST' && cancelMatch) return { job: await this.jobs.cancel(cancelMatch[1]) };
    const decisionMatch = /^\/jobs\/([A-Za-z0-9-]+)\/decision$/.exec(pathname);
    if (method === 'POST' && decisionMatch) {
      const body = objectBody(request.body);
      const selections: Record<string, string> = {};
      if (body.selections && typeof body.selections === 'object' && !Array.isArray(body.selections)) {
        for (const [key, value] of Object.entries(body.selections as JsonObject)) {
          if (typeof value === 'string') selections[key] = value;
        }
      }
      return { job: this.jobs.submitDecision(decisionMatch[1], selections) };
    }
    const guidanceMatch = /^\/jobs\/([A-Za-z0-9-]+)\/guidance$/.exec(pathname);
    if (method === 'POST' && guidanceMatch) {
      const body = objectBody(request.body);
      return { job: this.jobs.submitGuidance(guidanceMatch[1], requiredString(body, 'guidance')) };
    }

    if (method === 'GET' && pathname === '/projects') return { projects: this.projects.listProjects() };
    if (method === 'POST' && pathname === '/projects') {
      return { project: this.projects.createProject(objectBody(request.body) as unknown as CreateProjectInput) };
    }
    const projectMatch = /^\/projects\/([^/]+)$/.exec(pathname);
    if (projectMatch && method === 'GET') return { project: this.projects.getProject(decodeURIComponent(projectMatch[1])) };
    if (projectMatch && method === 'PATCH') {
      return {
        project: this.projects.updateProject(
          decodeURIComponent(projectMatch[1]),
          objectBody(request.body) as unknown as Partial<Omit<CreateProjectInput, 'id'>>
        )
      };
    }
    if (projectMatch && method === 'DELETE') {
      return { removed: this.projects.removeProject(decodeURIComponent(projectMatch[1])) };
    }
    const catalogMatch = /^\/projects\/([^/]+)\/catalog$/.exec(pathname);
    if (catalogMatch && method === 'GET') {
      return { catalog: await this.projects.catalog(decodeURIComponent(catalogMatch[1])) };
    }
    const usageMatch = /^\/projects\/([^/]+)\/usage$/.exec(pathname);
    if (usageMatch && method === 'GET') {
      return { usage: this.projects.usage(decodeURIComponent(usageMatch[1])) };
    }

    if (method === 'GET' && pathname === '/providers') return { providers: this.projects.listProviders() };
    const providerMatch = /^\/providers\/([^/]+)$/.exec(pathname);
    if (providerMatch && method === 'PATCH') {
      return {
        settings: this.projects.updateProvider(
          decodeURIComponent(providerMatch[1]),
          objectBody(request.body) as unknown as ProviderRuntimeSettingsPatch
        )
      };
    }

    if (method === 'GET' && pathname === '/credentials') return { credentials: this.projects.listCredentials() };
    if (method === 'POST' && pathname === '/credentials') {
      return { credential: this.projects.createCredential(createCredentialInput(objectBody(request.body))) };
    }
    const credentialMatch = /^\/credentials\/([^/]+)$/.exec(pathname);
    if (credentialMatch && method === 'DELETE') {
      return { removed: this.projects.removeCredential(decodeURIComponent(credentialMatch[1])) };
    }

    if (method === 'GET' && pathname === '/health') {
      return { ok: true, execution: await this.execution.health() };
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
        this.emit({ type: 'worker', payload: await this.execution.health() as Record<string, unknown> });
      } catch (error) {
        this.emit({
          type: 'worker-error',
          payload: { error: error instanceof Error ? error.message : String(error) }
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
