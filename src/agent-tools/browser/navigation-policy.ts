import { isIP } from 'node:net';

import type {
  BrowserNavigationClassification,
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
  /** HTTP remains supported by default for development previews; callers may require HTTPS. */
  readonly allowInsecureHttp?: boolean;
}

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google',
  'instance-data.ec2.internal'
]);

function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
  return trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function normalizePattern(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed) throw new Error('Browser host policy patterns must not be empty.');
  const host = trimmed.startsWith('*.') ? trimmed.slice(2) : trimmed;
  if (!host || host.includes('/') || host.includes(':')) {
    throw new Error(`Invalid browser host policy pattern: ${value}`);
  }
  return trimmed;
}

function matchesHost(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return hostname.length > suffix.length && hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

function ipv4Classification(hostname: string): BrowserNavigationClassification {
  const octets = hostname.split('.').map((part) => Number.parseInt(part, 10));
  const [a = -1, b = -1] = octets;
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'private-network';
  }
  if (a === 169 && b === 254) return 'link-local';
  if (
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  ) {
    return 'reserved-network';
  }
  return 'public';
}

function ipv6Classification(hostname: string): BrowserNavigationClassification {
  const normalized = hostname.toLowerCase().split('%')[0] ?? hostname.toLowerCase();
  if (normalized === '::1') return 'loopback';
  if (normalized === '::') return 'reserved-network';
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return 'private-network';
  if (/^fe[89ab]/.test(normalized)) return 'link-local';
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return ipv4Classification(mapped);
  }
  return 'public';
}

function classifyHost(hostname: string): BrowserNavigationClassification {
  const normalized = normalizeHost(hostname);
  if (METADATA_HOSTS.has(normalized)) return 'metadata-service';
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return 'loopback';
  if (normalized.endsWith('.local') || normalized.endsWith('.internal')) return 'private-network';
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return ipv4Classification(normalized);
  if (ipVersion === 6) return ipv6Classification(normalized);
  return 'public';
}

function decision(
  allowed: boolean,
  normalizedUrl: string,
  host: string,
  classification: BrowserNavigationClassification,
  reason?: string
): BrowserNavigationPolicyDecision {
  return {
    allowed,
    normalizedUrl,
    host,
    classification,
    ...(reason ? { reason } : {})
  };
}

/**
 * Fail-closed URL/host policy for Axis browser navigation. It is intentionally
 * independent from provider identity and can be composed from Company/Project
 * policy without changing AgentRuntime or a browser backend implementation.
 *
 * This boundary blocks obvious local/private targets and validates redirect
 * destinations when backends honor `authorizeNavigation`. It is not a complete
 * DNS-rebinding sandbox; process/network sandboxing remains a separate defense.
 */
export class StaticBrowserNavigationPolicy implements BrowserNavigationPolicy {
  private readonly allowedHosts: readonly string[];
  private readonly blockedHosts: readonly string[];
  private readonly allowLoopback: boolean;
  private readonly allowPrivateNetwork: boolean;
  private readonly allowInsecureHttp: boolean;

  constructor(options: StaticBrowserNavigationPolicyOptions = {}) {
    this.allowedHosts = Object.freeze((options.allowedHosts ?? []).map(normalizePattern));
    this.blockedHosts = Object.freeze((options.blockedHosts ?? []).map(normalizePattern));
    this.allowLoopback = options.allowLoopback ?? false;
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this.allowInsecureHttp = options.allowInsecureHttp ?? true;
  }

  authorize(request: BrowserNavigationPolicyRequest): BrowserNavigationPolicyDecision {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return decision(false, request.url, '', 'invalid', `Invalid browser URL: ${request.url}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return decision(
        false,
        url.toString(),
        normalizeHost(url.hostname),
        'invalid',
        `Browser navigation only supports http/https URLs, not ${url.protocol}`
      );
    }
    if (url.username || url.password) {
      return decision(
        false,
        url.toString(),
        normalizeHost(url.hostname),
        'invalid',
        'Browser navigation URLs must not contain embedded credentials.'
      );
    }
    if (url.protocol === 'http:' && !this.allowInsecureHttp) {
      return decision(
        false,
        url.toString(),
        normalizeHost(url.hostname),
        'public',
        'Browser navigation policy requires HTTPS for this session.'
      );
    }

    const host = normalizeHost(url.hostname);
    const classification = classifyHost(host);
    if (this.blockedHosts.some((pattern) => matchesHost(host, pattern))) {
      return decision(false, url.toString(), host, classification, `Browser host ${host} is blocked by policy.`);
    }
    if (
      this.allowedHosts.length > 0 &&
      !this.allowedHosts.some((pattern) => matchesHost(host, pattern))
    ) {
      return decision(
        false,
        url.toString(),
        host,
        classification,
        `Browser host ${host} is not in the session allowlist.`
      );
    }
    if (classification === 'metadata-service') {
      return decision(false, url.toString(), host, classification, `Browser host ${host} is a metadata-service target and is blocked.`);
    }
    if (classification === 'loopback' && !this.allowLoopback) {
      return decision(false, url.toString(), host, classification, `Loopback browser host ${host} requires explicit policy opt-in.`);
    }
    if (
      (classification === 'private-network' ||
        classification === 'link-local' ||
        classification === 'reserved-network') &&
      !this.allowPrivateNetwork
    ) {
      return decision(
        false,
        url.toString(),
        host,
        classification,
        `Non-public browser host ${host} requires explicit private-network policy opt-in.`
      );
    }
    return decision(true, url.toString(), host, classification);
  }
}
