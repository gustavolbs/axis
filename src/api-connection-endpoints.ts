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
import type { InferenceProvider } from './providers/types.js';

export type ApiEndpointProviderFamily = 'openai' | 'anthropic';

export interface ApiConnectionEndpointConfig {
  connectionId: string;
  providerFamily: ApiEndpointProviderFamily;
  credentialId: string;
  endpoint?: string;
  createdAt: string;
  updatedAt: string;
}

interface ApiConnectionEndpointFile {
  version: 1;
  connections: ApiConnectionEndpointConfig[];
  updatedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function safeId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_ID.test(trimmed)) throw new Error(`${label} contains unsupported characters.`);
  return trimmed;
}

export function normalizeApiEndpoint(value: string | undefined): string | undefined {
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
    return {
      connectionId: safeId(item.connectionId, 'Connection id'),
      providerFamily: item.providerFamily,
      credentialId: safeId(item.credentialId, 'Credential id'),
      endpoint: typeof item.endpoint === 'string' ? normalizeApiEndpoint(item.endpoint) : undefined,
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
    return this.read().connections.map((connection) => ({ ...connection }));
  }

  get(connectionIdValue: string): ApiConnectionEndpointConfig | undefined {
    const connectionId = safeId(connectionIdValue, 'Connection id');
    const match = this.read().connections.find((connection) => connection.connectionId === connectionId);
    return match ? { ...match } : undefined;
  }

  upsert(input: {
    connectionId: string;
    providerFamily: ApiEndpointProviderFamily;
    credentialId: string;
    endpoint?: string;
  }): ApiConnectionEndpointConfig {
    const connectionId = safeId(input.connectionId, 'Connection id');
    const credentialId = safeId(input.credentialId, 'Credential id');
    const endpoint = normalizeApiEndpoint(input.endpoint);
    const state = this.read();
    const current = state.connections.find((connection) => connection.connectionId === connectionId);
    if (current && (current.providerFamily !== input.providerFamily || current.credentialId !== credentialId)) {
      throw new Error(`Connection ${connectionId} is already bound to another API credential.`);
    }
    const now = new Date().toISOString();
    const config: ApiConnectionEndpointConfig = {
      connectionId,
      providerFamily: input.providerFamily,
      credentialId,
      endpoint,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    state.connections = [config, ...state.connections.filter((connection) => connection.connectionId !== connectionId)];
    state.updatedAt = now;
    this.write(state);
    return { ...config };
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
 * Keeps endpoint configuration independent from secret storage and provider brand.
 * The provider runtime remains the single connection abstraction; this decorator
 * only supplies per-connection transport configuration for API-key identities.
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
      return config?.endpoint ? { ...connection, endpoint: config.endpoint } as ProviderConnectionView : connection;
    });
  };

  prototype.provider = function providerForEndpoint(this: ProviderConnectionRuntime, view: ProviderConnectionView): InferenceProvider {
    if (view.auth !== 'api-key' || !view.credentialId) return originalProvider.call(this, view);
    const config = store.get(view.id);
    if (!config?.endpoint) return originalProvider.call(this, view);
    if (config.providerFamily !== view.providerFamily || config.credentialId !== view.credentialId) {
      throw new Error(`API endpoint metadata does not match connection ${view.id}.`);
    }

    const runtime = this as unknown as RuntimeInternals;
    const secret = runtime.credentials.resolve(view.credentialId);
    if (!secret) throw new Error(`Credential for ${view.label} is unavailable.`);
    const raw = view.providerFamily === 'openai'
      ? new OpenAIInferenceProvider({ apiKey: secret, baseUrl: config.endpoint })
      : new AnthropicInferenceProvider({ apiKey: secret, baseUrl: config.endpoint });
    const guarded = runtime.budget.wrap(withSafeModelLimits(raw));
    return runtime.capabilities.wrap(aliasProvider(view.id, guarded));
  };
}
