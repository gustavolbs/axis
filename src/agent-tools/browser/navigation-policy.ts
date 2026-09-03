import {
  authorizeRuntimeNetworkUrl,
  type RuntimeNetworkPolicy
} from '../../runtime-security/network-policy.js';
import type {
  BrowserNavigationPolicy,
  BrowserNavigationPolicyDecision,
  BrowserNavigationPolicyRequest
} from './contracts.js';

export interface StaticBrowserNavigationPolicyOptions {
  /** Exact hosts or `*.example.com` patterns. Empty/omitted means any otherwise-safe public host. */
  readonly allowedHosts?: readonly string[];
  /** Deny rules win over allow rules. Supports exact hosts and `*.example.com`. */
  readonly blockedHosts?: readonly string[];
  /** Loopback is denied by default; local preview composition must opt in explicitly. */
  readonly allowLoopback?: boolean;
  /** RFC1918/ULA/link-local/reserved network literals and local names are denied by default. */
  readonly allowPrivateNetwork?: boolean;
  /** Browser keeps HTTP compatibility for dev previews unless the caller requires HTTPS. */
  readonly allowInsecureHttp?: boolean;
}

/** Browser adapter over Axis's canonical outbound network policy. */
export class StaticBrowserNavigationPolicy implements BrowserNavigationPolicy {
  private readonly policy: RuntimeNetworkPolicy;

  constructor(options: StaticBrowserNavigationPolicyOptions = {}) {
    this.policy = Object.freeze({
      ...(options.allowedHosts ? { allowedHosts: Object.freeze([...options.allowedHosts]) } : {}),
      ...(options.blockedHosts ? { blockedHosts: Object.freeze([...options.blockedHosts]) } : {}),
      allowLoopback: options.allowLoopback ?? false,
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      allowInsecureHttp: options.allowInsecureHttp ?? true
    });
  }

  authorize(request: BrowserNavigationPolicyRequest): BrowserNavigationPolicyDecision {
    const result = authorizeRuntimeNetworkUrl(request.url, this.policy);
    return {
      allowed: result.allowed,
      normalizedUrl: result.normalizedUrl,
      host: result.host,
      classification: result.classification,
      ...(result.reason ? { reason: result.reason } : {})
    };
  }
}
