import { isIP } from 'node:net';

import {
  isRuntimeSecretField,
  redactRuntimeUrlForDisplay
} from './redaction.js';

export type RuntimeNetworkClass = 'public' | 'loopback' | 'private-network' | 'link-local' | 'reserved-network' | 'metadata-service' | 'invalid';

export interface RuntimeNetworkPolicy {
  readonly allowedHosts?: readonly string[];
  readonly blockedHosts?: readonly string[];
  readonly allowLoopback?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly allowInsecureHttp?: boolean;
}

export interface RuntimeNetworkDecision {
  readonly allowed: boolean;
  readonly normalizedUrl: string;
  readonly host: string;
  readonly classification: RuntimeNetworkClass;
  readonly reason?: string;
}

const METADATA_NAMES = new Set([
  'metadata.google.internal',
  'metadata.google',
  'instance-data.ec2.internal',
  'metadata.azure.internal'
]);
const METADATA_IPS = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200']);

function host(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  return normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
}

function pattern(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized.includes('/')) {
    throw new Error(`Invalid runtime network host pattern: ${value}`);
  }
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(2);
    if (!suffix || suffix.includes(':') || isIP(suffix) !== 0) {
      throw new Error(`Invalid runtime network wildcard pattern: ${value}`);
    }
    return normalized;
  }
  const normalizedHost = host(normalized);
  if (!normalizedHost || (normalizedHost.includes(':') && isIP(normalizedHost) !== 6)) {
    throw new Error(`Invalid runtime network host pattern: ${value}`);
  }
  return normalizedHost;
}

function matches(value: string, rule: string): boolean {
  if (!rule.startsWith('*.')) return value === rule;
  const suffix = rule.slice(2);
  return value.length > suffix.length && value.endsWith(`.${suffix}`);
}

function ipv4(value: string): RuntimeNetworkClass {
  if (METADATA_IPS.has(value)) return 'metadata-service';
  const parts = value.split('.').map((part) => Number.parseInt(part, 10));
  const [a = -1, b = -1, c = -1] = parts;
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private-network';
  if (a === 169 && b === 254) return 'link-local';
  if (
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  ) return 'reserved-network';
  return 'public';
}

function ipv6(value: string): RuntimeNetworkClass {
  const normalized = value.toLowerCase().split('%')[0] ?? value.toLowerCase();
  if (normalized === '::1') return 'loopback';
  if (normalized === '::') return 'reserved-network';
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return 'private-network';
  if (/^fe[89ab]/.test(normalized)) return 'link-local';
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return ipv4(mapped);
  }
  if (normalized.startsWith('2001:db8:')) return 'reserved-network';
  return 'public';
}

export function classifyRuntimeNetworkHost(value: string): RuntimeNetworkClass {
  const normalized = host(value);
  if (METADATA_NAMES.has(normalized)) return 'metadata-service';
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return 'loopback';
  if (normalized.endsWith('.local') || normalized.endsWith('.internal')) return 'private-network';
  if (isIP(normalized) === 4) return ipv4(normalized);
  if (isIP(normalized) === 6) return ipv6(normalized);
  return 'public';
}

function verdict(allowed: boolean, normalizedUrl: string, targetHost: string, classification: RuntimeNetworkClass, reason?: string): RuntimeNetworkDecision {
  return { allowed, normalizedUrl, host: targetHost, classification, ...(reason ? { reason } : {}) };
}

function hasCredentialQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (isRuntimeSecretField(key)) return true;
  }
  return false;
}

export function authorizeRuntimeNetworkUrl(rawUrl: string, policy: RuntimeNetworkPolicy = {}): RuntimeNetworkDecision {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return verdict(false, redactRuntimeUrlForDisplay(rawUrl), '', 'invalid', 'Invalid outbound URL.'); }
  const targetHost = host(url.hostname);
  const classification = classifyRuntimeNetworkHost(targetHost);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return verdict(false, redactRuntimeUrlForDisplay(url.toString()), targetHost, 'invalid', 'Only http/https outbound URLs are supported.');
  if (url.username || url.password || hasCredentialQuery(url)) {
    return verdict(false, redactRuntimeUrlForDisplay(url.toString()), targetHost, 'invalid', 'Credential-bearing URLs are blocked.');
  }
  if (url.protocol === 'http:' && policy.allowInsecureHttp !== true) return verdict(false, url.toString(), targetHost, classification, 'HTTPS is required by policy.');
  const blocked = (policy.blockedHosts ?? []).map(pattern);
  const allowed = (policy.allowedHosts ?? []).map(pattern);
  if (blocked.some((rule) => matches(targetHost, rule))) return verdict(false, url.toString(), targetHost, classification, `Host ${targetHost} is denied by policy.`);
  if (allowed.length > 0 && !allowed.some((rule) => matches(targetHost, rule))) return verdict(false, url.toString(), targetHost, classification, `Host ${targetHost} is not allowed by policy.`);
  if (classification === 'metadata-service') return verdict(false, url.toString(), targetHost, classification, 'Metadata-service targets are blocked.');
  if (classification === 'loopback' && policy.allowLoopback !== true) return verdict(false, url.toString(), targetHost, classification, 'Loopback access requires explicit policy opt-in.');
  if ((classification === 'private-network' || classification === 'link-local' || classification === 'reserved-network') && policy.allowPrivateNetwork !== true) return verdict(false, url.toString(), targetHost, classification, 'Non-public network access requires explicit policy opt-in.');
  return verdict(true, url.toString(), targetHost, classification);
}

export function assertRuntimeNetworkUrl(rawUrl: string, policy: RuntimeNetworkPolicy = {}): RuntimeNetworkDecision {
  const decision = authorizeRuntimeNetworkUrl(rawUrl, policy);
  if (!decision.allowed) throw new Error(decision.reason ?? 'Outbound network request denied by policy.');
  return decision;
}
