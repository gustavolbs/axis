import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readAppSettings, writeAppSettings, type AppSettingsFile } from './app-config.js';
import { loadConfig } from './config.js';
import { createExecutionRuntime } from './execution-runtime.js';
import { createLocalInferenceProvider } from './local-inference-provider.js';
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

/** The slice of ~/.local-coder/settings.json that Settings can edit. */
type RuntimeSettings = Pick<AppSettingsFile, 'ollamaBaseUrl' | 'executionMode'>;

/** Exported for tests: the endpoint the user typed must be rejected here, not
 *  three layers down inside a fetch error. */
export function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('ollamaBaseUrl is required.');
  const invalid = new Error(`"${value}" is not a valid URL. Expected something like http://127.0.0.1:11434`);
  // `localhost:11434` is what people type; accept it rather than making them
  // remember the scheme. Infer before trimming slashes, or a bare "http://"
  // becomes the hostname.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw invalid;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('ollamaBaseUrl must use http or https.');
  }
  if (!parsed.hostname) throw invalid;
  // Serialize from the parsed URL so the stored value is canonical, then drop
  // the path: requests append their own (/api/tags, /api/chat, ...).
  return `${parsed.protocol}//${parsed.host}`;
}

export class DesktopAppRuntime {
  private readonly listeners = new Set<AppRuntimeListener>();
  private readonly config = loadConfig();
  private readonly ollama = new OllamaClient(this.config);
  private readonly execution = createExecutionRuntime(this.config, this.ollama);
  private readonly projects = new ProjectAdminService({
    localProvider: createLocalInferenceProvider(this.config, this.ollama)
  });
  private readonly jobs = new StandaloneJobManager(
    this.execution.execution,
    path.join(path.dirname(this.config.runStorePath), 'sessions')
  );
  private workerTimer?: NodeJS.Timeout;

  /**
   * Merges into ~/.local-coder/settings.json instead of replacing it. loadConfig
   * reads executionMode, remoteWorkerUrl, remoteWorkerCredentialRef and model
   * from that same file, so writing a fresh object would silently drop them.
   */
  private patchSettings(patch: RuntimeSettings): void {
    writeAppSettings({ ...readAppSettings(), ...patch });
  }

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

    if (method === 'GET' && pathname === '/settings') {
      return {
        settings: {
          ollamaBaseUrl: this.config.ollamaBaseUrl,
          executionMode: this.config.executionMode,
          // Direct mode never consults a worker, so no bearer token is involved.
          requiresWorkerToken: this.config.executionMode !== 'local'
        }
      };
    }
    if (method === 'PUT' && pathname === '/settings') {
      const body = objectBody(request.body);
      const patch: RuntimeSettings = {};

      if (body.ollamaBaseUrl !== undefined) {
        const next = normalizeBaseUrl(requiredString(body, 'ollamaBaseUrl'));
        // OllamaClient reads config.ollamaBaseUrl per request, so this applies
        // to the next call without a restart.
        this.config.ollamaBaseUrl = next;
        patch.ollamaBaseUrl = next;
      }

      if (body.executionMode !== undefined) {
        const mode = requiredString(body, 'executionMode');
        if (mode !== 'local' && mode !== 'remote' && mode !== 'auto') {
          throw new Error("executionMode must be 'local', 'remote' or 'auto'.");
        }
        // The execution runtime is built once from this value, so unlike the
        // endpoint it only takes effect on the next launch.
        patch.executionMode = mode;
      }

      if (Object.keys(patch).length === 0) throw new Error('No supported settings in request.');
      this.patchSettings(patch);
      return {
        settings: {
          ollamaBaseUrl: this.config.ollamaBaseUrl,
          executionMode: patch.executionMode ?? this.config.executionMode,
          requiresWorkerToken: (patch.executionMode ?? this.config.executionMode) !== 'local',
          restartRequired: patch.executionMode !== undefined && patch.executionMode !== this.config.executionMode
        }
      };
    }
    /** Probes a URL without saving it, so Settings can show whether it works. */
    if (method === 'POST' && pathname === '/settings/probe-ollama') {
      const body = objectBody(request.body);
      const target = normalizeBaseUrl(requiredString(body, 'ollamaBaseUrl'));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4_000);
      try {
        const response = await fetch(`${target}/api/tags`, { signal: controller.signal });
        if (!response.ok) return { reachable: false, error: `HTTP ${response.status}` };
        const payload = (await response.json()) as { models?: Array<{ name?: string }> };
        return { reachable: true, models: (payload.models ?? []).map((model) => model.name).filter(Boolean).length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { reachable: false, error: controller.signal.aborted ? 'Timed out after 4s' : message };
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
