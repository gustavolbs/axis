import {
  DEFAULT_PROVIDER_CAPABILITIES,
  ProviderSettingsStore,
  type ProviderCapabilityAccess,
  type ProviderCapabilityPolicy
} from './provider-settings.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ProviderCapabilityKind,
  ProviderCapabilityRequest
} from './providers/types.js';

export class ProviderCapabilityPolicyError extends Error {
  constructor(
    readonly providerId: string,
    readonly capability: ProviderCapabilityRequest,
    message: string
  ) {
    super(message);
    this.name = 'ProviderCapabilityPolicyError';
  }
}

function accessAllows(access: ProviderCapabilityAccess, id: string): boolean {
  if (!access.enabled) return false;
  return !access.allowIds || access.allowIds.length === 0 || access.allowIds.includes(id);
}

export class ProviderCapabilityPolicyManager {
  constructor(private readonly settings = new ProviderSettingsStore()) {}

  policy(providerId: string): ProviderCapabilityPolicy {
    return this.settings.get(providerId)?.capabilities ?? structuredClone(DEFAULT_PROVIDER_CAPABILITIES);
  }

  assertAllowed(providerId: string, requests: ProviderCapabilityRequest[] | undefined): void {
    if (!requests || requests.length === 0) return;
    const policy = this.policy(providerId);
    for (const request of requests) {
      const id = request.id.trim();
      if (!id) {
        throw new ProviderCapabilityPolicyError(
          providerId,
          request,
          `Provider ${providerId} requested an empty ${request.kind} capability id.`
        );
      }
      const access = policy[request.kind as ProviderCapabilityKind];
      if (!access || !accessAllows(access, id)) {
        throw new ProviderCapabilityPolicyError(
          providerId,
          request,
          `Provider ${providerId} is not allowed to use ${request.kind}:${id}. Enable it in Settings → Capabilities first.`
        );
      }
    }
  }

  wrap(provider: InferenceProvider): InferenceProvider {
    const manager = this;
    return {
      id: provider.id,
      kind: provider.kind,
      capabilities: provider.capabilities,
      listModels: () => provider.listModels(),
      health: () => provider.health(),
      async invoke(request: InferenceRequest): Promise<InferenceResult> {
        manager.assertAllowed(provider.id, request.capabilityRequests);
        return await provider.invoke(request);
      }
    };
  }
}
