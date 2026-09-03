import type {
  EffectiveCapability,
  EffectiveCapabilitySet
} from './contracts.js';

export interface CapabilityOffer {
  readonly source: string;
  readonly ids: readonly string[];
}

/**
 * A restriction is narrower than an offer. `allow` omitted means this layer does
 * not maintain an allowlist; `deny` always wins and should explain why.
 */
export interface CapabilityRestriction {
  readonly source: string;
  readonly allow?: readonly string[];
  readonly deny?: Readonly<Record<string, string>>;
}

export interface CapabilityNegotiationInput {
  readonly offers: readonly CapabilityOffer[];
  readonly restrictions?: readonly CapabilityRestriction[];
}

function cleanIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * Canonical capability negotiation for a resolved session.
 *
 * Callers should submit separately namespaced capabilities from Axis native
 * features, the selected connection/model, configured resources and the exact
 * execution target. Company/Project/session/provider-admin restrictions are
 * represented as restriction layers. No provider or auth kind is special here.
 */
export function negotiateEffectiveCapabilities(
  input: CapabilityNegotiationInput
): EffectiveCapabilitySet {
  const restrictions = input.restrictions ?? [];
  const candidateIds = new Set<string>();
  for (const offer of input.offers) {
    for (const id of cleanIds(offer.ids)) candidateIds.add(id);
  }
  for (const restriction of restrictions) {
    for (const id of cleanIds(restriction.allow ?? [])) candidateIds.add(id);
    for (const id of Object.keys(restriction.deny ?? {})) {
      const clean = id.trim();
      if (clean) candidateIds.add(clean);
    }
  }

  const entries: Record<string, EffectiveCapability> = Object.create(null);
  for (const id of [...candidateIds].sort()) {
    const offeredBy = input.offers
      .filter((offer) => cleanIds(offer.ids).includes(id))
      .map((offer) => offer.source);
    const blockedBy: string[] = [];
    for (const restriction of restrictions) {
      const denied = restriction.deny?.[id];
      if (denied !== undefined) {
        blockedBy.push(`${restriction.source}: ${denied || 'denied'}`);
        continue;
      }
      if (restriction.allow !== undefined && !cleanIds(restriction.allow).includes(id)) {
        blockedBy.push(`${restriction.source}: not allowed`);
      }
    }
    entries[id] = Object.freeze({
      id,
      available: offeredBy.length > 0 && blockedBy.length === 0,
      offeredBy: Object.freeze(offeredBy),
      blockedBy: Object.freeze(blockedBy)
    });
  }
  return Object.freeze({ entries: Object.freeze(entries) });
}

export function capabilityUnavailableReason(
  capabilities: EffectiveCapabilitySet,
  id: string
): string | undefined {
  const capability = capabilities.entries[id];
  if (!capability) return `Capability ${id} is not offered by this session.`;
  if (capability.available) return undefined;
  if (capability.blockedBy.length > 0) {
    return `Capability ${id} is unavailable: ${capability.blockedBy.join('; ')}.`;
  }
  return `Capability ${id} is unavailable because no selected resource offers it.`;
}

export function assertEffectiveCapabilities(
  capabilities: EffectiveCapabilitySet,
  required: readonly string[]
): void {
  for (const id of cleanIds(required)) {
    const reason = capabilityUnavailableReason(capabilities, id);
    if (reason) throw new Error(reason);
  }
}
