import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CredentialManager } from './credential-store.js';
import type { ProviderBudgetManager } from './provider-budget.js';
import type { ProviderCapabilityPolicyManager } from './provider-capability-policy.js';
import { ProviderConnectionRuntime, type ProviderConnectionView } from './provider-connections.js';
import { AnthropicInferenceProvider } from './providers/anthropic-provider.js';
import { withSafeModelLimits } from './providers/model-limits.js';
import { OpenAIInferenceProvider } from './providers/openai-provider.js';
import type { InferenceProvider, ProviderHealth } from './providers/types.js';

export type ApiEndpointProviderFamily = 'openai' | 'anthropic';

export interface ApiConnectionEndpointConfig {
  connectionId: string;
  providerFamily: ApiEndpointProviderFamily;
  credentialId: string;
  endpoint?: string;
  /** Non-secret provider metadata headers only; auth headers are never configurable here. */
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ApiConnectionEndpointFile {
  version: 1;
  connections: ApiConnectionEndpointConfig[];
  updatedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ALLOWED_HEADERS: Record<ApiEndpointProviderFamily, ReadonlySet<string>> = {
  openai: new Set(['openai-organization', 'openai-project']),
  anthropic: new Set(['anthropic-beta'])
};

function safeId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_ID.test(trimmed)) throw new Error(`${label} contains unsupported characters.`);
  return trimmed;
}

export function normalizeApiEndpoint(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('API endpoint must be a valid absolute URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('API endpoint must use http or https.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('API endpoint must not contain embedded credentials.');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

export function apiConnectionAllowedHeaders(providerFamily: ApiEndpointProviderFamily): string[] {
  return [...ALLOWED_HEADERS[providerFamily]].sort();
}

export function normalizeApiConnectionHeaders(
  providerFamily: ApiEndpointProviderFamily,
  value: Record<string, string> | undefined
): Record<string, string> {
  const entries = Object.entries(value ?? {});
  if (entries.length > 8) throw new Error('API connection may configure at most 8 additional headers.');
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase();
    if (!ALLOWED_HEADERS[providerFamily].has(name)) {
      throw new Error(`API header ${rawName} is not allowed for ${providerFamily}.`);
    }
    const headerValue = rawValue.trim();
    if (!headerValue || headerValue.length > 1_024 || /[\0\r\n]/.test(headerValue)) {
      throw new Error(`API header ${name} must be 1-1024 characters without control line breaks.`);
    }
    result[name] = headerValue;
  }
  return result;
}

function validateConfig(value: unknown): ApiConnectionEndpointConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item.connectionId !== 'string' ||
    (item.providerFamily !== 'openai' && item.providerFamily !== 'anthropic') ||
    typeof item.credentialId !== 'string' ||
    typeof item.createdAt !== 'string' ||
    typeof item.updatedAt !== 'string'
  ) return undefined;
  try {
    const headers = item.headers === undefined
      ? {}
      : item.headers && typeof item.headers === 'object' && !Array.isArray(item.headers)
        ? normalizeApiConnectionHeaders(item.providerFamily, item.headers as Record<string, string>)
        : (() => { throw new Error('Invalid API connection headers.'); })();
    return {
      connectionId: safeId(item.connectionId, 'Connection id'),
      providerFamily: item.providerFamily,
      credentialId: safeId(item.credentialId, 'Credential id'),
      endpoint: typeof item.endpoint === 'string' ? normalizeApiEndpoint(item.endpoint) : undefined,
      headers,
      enabled: item.enabled !== false,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  } catch {
    return undefined;
  }
}

export function apiConnectionEndpointPath(): string {
  return process.env.LOCAL_CODER_API_CONNECTION_ENDPOINTS_PATH?.trim() ||
    path.join(os.homedir(), '.local-coder', 'api-connection-endpoints.json');
}

export class ApiConnectionEndpointStore {
  constructor(private readonly file = apiConnectionEndpointPath()) {}

  list(): ApiConnectionEndpointConfig[] {
    return this.read().connections.map((connection) => ({
      ...connection,
      headers: { ...connection.headers }
    }));
  }

  get(connectionIdValue: string): ApiConnectionEndpointConfig | undefined {
    const connectionId = safeId(connectionIdValue, 'Connection id');
    const match = this.read().connections.find((connection) => connection.connectionId === connectionId);
    return match ? { ...match, headers: { ...match.headers } } : undefined;
  }

  upsert(input: {
    connectionId: string;
    providerFamily: ApiEndpointProviderFamily;
    credentialId: string;
    endpoint?: string | null;
    headers?: Record<string, string>;
    enabled?: boolean;
  }): ApiConnectionEndpointConfig {
    const connectionId = safeId(input.connectionId, 'Connection id');
    const credentialId = safeId(input.credentialId, 'Credential id');
    const state = this.read();
    const current = state.connections.find((connection) => connection.connectionId === connectionId);
    if (current && (current.providerFamily !== input.providerFamily || current.credentialId !== credentialId)) {
      throw new Error(`Connection ${connectionId} is already bound to another API credential.`);
    }
    const endpoint = input.endpoint === undefined && current
      ? current.endpoint
      : normalizeApiEndpoint(input.endpoint);
    const headers = input.headers === undefined && current
      ? { ...current.headers }
      : normalizeApiConnectionHeaders(input.providerFamily, input.headers);
    const now = new Date().toISOString();
    const config: ApiConnectionEndpointConfig = {
      connectionId,
      providerFamily: input.providerFamily,
      credentialId,
      endpoint,
      headers,
      enabled: input.enabled ?? current?.enabled ?? true,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    state.connections = [config, ...state.connections.filter((connection) => connection.connectionId !== connectionId)];
    state.updatedAt = now;
    this.write(state);
    return { ...config, headers: { ...config.headers } };
  }

  remove(connectionIdValue: string): boolean {
    const connectionId = safeId(connectionIdValue, 'Connection id');
    const state = this.read();
    if (!state.connections.some((connection) => connection.connectionId === connectionId)) return false;
    state.connections = state.connections.filter((connection) => connection.connectionId !== connectionId);
    state.updatedAt = new Date().toISOString();
    this.write(state);
    return true;
  }

  private read(): ApiConnectionEndpointFile {
    if (!fs.existsSync(this.file)) {
      return { version: 1, connections: [], updatedAt: new Date(0).toISOString() };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Could not read API connection endpoints: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('API connection endpoint metadata must be a JSON object.');
    }
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.connections)) {
      throw new Error(`Unsupported API connection endpoint metadata version: ${String(value.version)}`);
    }
    const connections = value.connections.map(validateConfig);
    if (connections.some((connection) => !connection)) {
      throw new Error('API connection endpoint metadata contains an invalid connection.');
    }
    return {
      version: 1,
      connections: connections as ApiConnectionEndpointConfig[],
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString()
    };
  }

  private write(state: ApiConnectionEndpointFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort on non-POSIX */ }
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }
}

function aliasProvider(aliasId: string, inner: InferenceProvider): InferenceProvider {
  return {
    id: aliasId,
    kind: inner.kind,
    capabilities: inner.capabilities,
    async listModels() {
      return (await inner.listModels()).map((model) => ({ ...model, providerId: aliasId }));
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

interface RuntimeInternals {
  credentials: CredentialManager;
  budget: ProviderBudgetManager;
  capabilities: ProviderCapabilityPolicyManager;
}

let installed = false;

/**
 * Keeps endpoint/header configuration independent from secret storage and provider brand.
 * The provider runtime remains the single connection abstraction; this decorator
 * only supplies per-connection transport configuration and enabled state for API-key identities.
 */
export function installApiConnectionEndpointRouting(store = new ApiConnectionEndpointStore()): void {
  if (installed) return;
  installed = true;
  const prototype = ProviderConnectionRuntime.prototype as unknown as {
    list: () => ProviderConnectionView[];
    provider: (view: ProviderConnectionView) => InferenceProvider;
  };
  const originalList = prototype.list;
  const originalProvider = prototype.provider;

  prototype.list = function listEndpointAwareConnections(this: ProviderConnectionRuntime): ProviderConnectionView[] {
    return originalList.call(this).map((connection) => {
      if (connection.auth !== 'api-key') return connection;
      const config = store.get(connection.id);
      if (!config) return connection;
      return {
        ...connection,
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        apiHeaders: { ...config.headers },
        enabled: config.enabled,
        available: config.enabled ? connection.available : false,
        reason: config.enabled ? connection.reason : 'Disabled in Connection Center.'
      } as ProviderConnectionView;
    });
  };

  prototype.provider = function providerForEndpoint(this: ProviderConnectionRuntime, view: ProviderConnectionView): InferenceProvider {
    if (view.auth !== 'api-key' || !view.credentialId) return originalProvider.call(this, view);
    const config = store.get(view.id);
    if (config?.enabled === false) throw new Error(`API connection ${view.label} is disabled.`);
    if (!config?.endpoint && Object.keys(config?.headers ?? {}).length === 0) return originalProvider.call(this, view);
    if (!config || config.providerFamily !== view.providerFamily || config.credentialId !== view.credentialId) {
      throw new Error(`API endpoint metadata does not match connection ${view.id}.`);
    }

    const runtime = this as unknown as RuntimeInternals;
    const secret = runtime.credentials.resolve(view.credentialId);
    if (!secret) throw new Error(`Credential for ${view.label} is unavailable.`);
    const raw = view.providerFamily === 'openai'
      ? new OpenAIInferenceProvider({ apiKey: secret, baseUrl: config.endpoint, headers: config.headers })
      : new AnthropicInferenceProvider({ apiKey: secret, baseUrl: config.endpoint, headers: config.headers });
    const guarded = runtime.budget.wrap(withSafeModelLimits(raw));
    return runtime.capabilities.wrap(aliasProvider(view.id, guarded));
  };
}

/** Uses the connection's normal provider path and performs only its non-mutating model/health probe. */
export async function testApiKeyConnection(
  runtime: ProviderConnectionRuntime,
  connectionId: string
): Promise<ProviderHealth> {
  const view = runtime.view(connectionId);
  if (!view || view.auth !== 'api-key') throw new Error(`Unknown API Key connection: ${connectionId}`);
  if (!view.available && view.reason === 'Disabled in Connection Center.') {
    throw new Error(`API connection ${view.label} is disabled.`);
  }
  const provider = (runtime as unknown as { provider: (connection: ProviderConnectionView) => InferenceProvider }).provider(view);
  return await provider.health();
}
