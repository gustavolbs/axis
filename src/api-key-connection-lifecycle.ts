import {
  ApiConnectionEndpointStore,
  apiConnectionAllowedHeaders,
  type ApiEndpointProviderFamily
} from './api-connection-endpoints.js';
import { CredentialManager, type CredentialProfile } from './credential-store.js';
import { ProviderConnectionRuntime, type ProviderConnectionView } from './provider-connections.js';
import { AnthropicInferenceProvider } from './providers/anthropic-provider.js';
import { OpenAIInferenceProvider } from './providers/openai-provider.js';
import type { ProviderHealth } from './providers/types.js';

export interface ApiKeyConnectionDetails {
  connectionId: string;
  credentialId: string;
  providerFamily: ApiEndpointProviderFamily;
  name: string;
  companyId: string;
  endpoint?: string;
  headers: Record<string, string>;
  allowedHeaders: string[];
  enabled: boolean;
  available: boolean;
  reason?: string;
}

export interface EditApiKeyConnectionInput {
  name?: string;
  endpoint?: string | null;
  headers?: Record<string, string>;
}

function apiView(runtime: ProviderConnectionRuntime, connectionId: string): ProviderConnectionView & { credentialId: string } {
  const view = runtime.view(connectionId);
  if (!view || view.auth !== 'api-key' || !view.credentialId) {
    throw new Error(`Unknown API Key connection: ${connectionId}`);
  }
  return view as ProviderConnectionView & { credentialId: string };
}

function profileFor(credentials: CredentialManager, view: ProviderConnectionView & { credentialId: string }): CredentialProfile {
  const profile = credentials.getProfile(view.credentialId);
  if (!profile) throw new Error(`Credential metadata for ${view.label} is unavailable.`);
  if (profile.providerId !== view.providerFamily) {
    throw new Error(`Credential ${profile.id} does not match connection provider ${view.providerFamily}.`);
  }
  return profile;
}

export class ApiKeyConnectionLifecycle {
  constructor(
    private readonly credentials: CredentialManager,
    private readonly configs: ApiConnectionEndpointStore,
    private readonly runtime: ProviderConnectionRuntime
  ) {}

  details(connectionId: string): ApiKeyConnectionDetails {
    const view = apiView(this.runtime, connectionId);
    const profile = profileFor(this.credentials, view);
    const config = this.configs.get(connectionId);
    if (config && (config.credentialId !== profile.id || config.providerFamily !== view.providerFamily)) {
      throw new Error(`API connection configuration does not match ${connectionId}.`);
    }
    return {
      connectionId: view.id,
      credentialId: profile.id,
      providerFamily: view.providerFamily as ApiEndpointProviderFamily,
      name: profile.label,
      companyId: view.organizationId,
      endpoint: config?.endpoint,
      headers: { ...(config?.headers ?? {}) },
      allowedHeaders: apiConnectionAllowedHeaders(view.providerFamily as ApiEndpointProviderFamily),
      enabled: config?.enabled ?? true,
      available: view.available,
      reason: view.reason
    };
  }

  edit(connectionId: string, input: EditApiKeyConnectionInput): ApiKeyConnectionDetails {
    const view = apiView(this.runtime, connectionId);
    const profile = profileFor(this.credentials, view);
    if (input.name !== undefined) this.credentials.updateMetadata(profile.id, { label: input.name });
    const current = this.configs.get(connectionId);
    this.configs.upsert({
      connectionId,
      providerFamily: view.providerFamily as ApiEndpointProviderFamily,
      credentialId: profile.id,
      ...(Object.prototype.hasOwnProperty.call(input, 'endpoint') ? { endpoint: input.endpoint } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'headers') ? { headers: input.headers } : {}),
      enabled: current?.enabled ?? true
    });
    return this.details(connectionId);
  }

  rotate(connectionId: string, replacementSecret: string): ApiKeyConnectionDetails {
    const view = apiView(this.runtime, connectionId);
    const profile = profileFor(this.credentials, view);
    this.credentials.rotateKeychainCredential(profile.id, replacementSecret);
    return this.details(connectionId);
  }

  setEnabled(connectionId: string, enabled: boolean): ApiKeyConnectionDetails {
    const view = apiView(this.runtime, connectionId);
    const profile = profileFor(this.credentials, view);
    const current = this.configs.get(connectionId);
    this.configs.upsert({
      connectionId,
      providerFamily: view.providerFamily as ApiEndpointProviderFamily,
      credentialId: profile.id,
      enabled,
      ...(current?.endpoint !== undefined ? { endpoint: current.endpoint } : {}),
      headers: current?.headers ?? {}
    });
    return this.details(connectionId);
  }

  async test(connectionId: string): Promise<ProviderHealth> {
    const view = apiView(this.runtime, connectionId);
    const profile = profileFor(this.credentials, view);
    const config = this.configs.get(connectionId);
    if (config?.enabled === false) throw new Error(`API connection ${view.label} is disabled.`);
    if (config && (config.credentialId !== profile.id || config.providerFamily !== view.providerFamily)) {
      throw new Error(`API connection configuration does not match ${connectionId}.`);
    }
    const secret = this.credentials.resolve(profile.id);
    if (!secret) throw new Error(`Credential for ${view.label} is unavailable.`);

    // Connection Center Test is deliberately narrower than inference: construct
    // a fresh provider from the current persisted connection metadata and run
    // only its non-mutating model/health probe. This avoids cached/decorated
    // runtime state while still exercising the actual key, endpoint and allowed
    // headers that the next provider request will use.
    const provider = view.providerFamily === 'openai'
      ? new OpenAIInferenceProvider({ apiKey: secret, baseUrl: config?.endpoint, headers: config?.headers })
      : new AnthropicInferenceProvider({ apiKey: secret, baseUrl: config?.endpoint, headers: config?.headers });
    return await provider.health();
  }

  remove(connectionId: string): boolean {
    const view = apiView(this.runtime, connectionId);
    const profile = profileFor(this.credentials, view);
    // Removing credential metadata makes the provider identity disappear immediately.
    // The stable Company binding intentionally remains reserved for this connection id.
    const removed = this.credentials.remove(profile.id);
    if (!removed) return false;
    this.configs.remove(connectionId);
    return true;
  }
}
