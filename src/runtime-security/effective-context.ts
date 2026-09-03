import type { AgentSessionContext } from '../agent-runtime/index.js';
import {
  RuntimePolicyEngine,
  type RuntimeAuthorityMode,
  type RuntimePolicyRule,
  type RuntimeSessionPolicyOverride
} from './policy.js';
import { redactRuntimeText } from './redaction.js';

export interface EffectiveContextLabels {
  readonly companyName?: string;
  readonly projectName?: string;
  readonly connectionName?: string;
  readonly executionTargetName?: string;
}

export interface EffectiveContextMcpCandidate {
  readonly id: string;
  readonly name?: string;
  readonly companyId: string;
  readonly projectId?: string;
  readonly enabled: boolean;
}

export interface EffectiveRuntimeContext {
  readonly sessionId: string;
  readonly company: { readonly id: string; readonly name?: string };
  readonly project?: { readonly id: string; readonly name?: string };
  readonly connection: {
    readonly id: string;
    readonly name?: string;
    readonly providerFamily: string;
    readonly authKind: string;
    readonly sharedLocal: boolean;
  };
  readonly model: { readonly id: string };
  readonly execution: { readonly id: string; readonly name?: string; readonly kind: string; readonly mode: string };
  readonly authority: {
    readonly mode: RuntimeAuthorityMode;
    readonly companyMode?: RuntimeAuthorityMode;
    readonly projectMode?: RuntimeAuthorityMode;
    readonly sessionMode?: RuntimeAuthorityMode;
    readonly denyWins: true;
  };
  readonly roots: readonly { readonly id: string; readonly path: string; readonly access: 'read' | 'write' }[];
  readonly mcp: readonly { readonly id: string; readonly name?: string; readonly status: 'enabled' | 'policy-denied' | 'disabled' }[];
  readonly permissions: readonly { readonly id: string; readonly status: 'granted' | 'denied' | 'ask' }[];
  readonly rules: readonly { readonly id: string; readonly scope: 'company' | 'project' | 'session'; readonly effect: string; readonly domain: string; readonly match?: string; readonly note?: string }[];
  readonly network: {
    readonly publicHttps: 'allowed-by-network-boundary';
    readonly loopback: 'explicit-opt-in';
    readonly privateNetwork: 'explicit-opt-in';
    readonly linkLocal: 'explicit-opt-in';
    readonly metadataServices: 'denied';
    readonly credentialBearingUrls: 'denied';
    readonly redirects: 'reauthorized-per-hop';
  };
}

const MODE_RANK: Readonly<Record<RuntimeAuthorityMode, number>> = {
  plan: 0,
  'ask-before': 1,
  'workspace-write': 2,
  auto: 3,
  'full-access': 4
};

function effectiveMode(modes: readonly (RuntimeAuthorityMode | undefined)[]): RuntimeAuthorityMode {
  const present = modes.filter((mode): mode is RuntimeAuthorityMode => Boolean(mode));
  if (!present.length) return 'workspace-write';
  return present.reduce((current, mode) => MODE_RANK[mode] < MODE_RANK[current] ? mode : current);
}

function safeRule(rule: RuntimePolicyRule, scope: 'company' | 'project' | 'session') {
  return Object.freeze({
    id: redactRuntimeText(rule.id, { maxChars: 256 }),
    scope,
    effect: rule.effect,
    domain: rule.domain,
    ...(rule.match ? { match: redactRuntimeText(rule.match, { maxChars: 1_000 }) } : {}),
    ...(rule.note ? { note: redactRuntimeText(rule.note, { maxChars: 1_000 }) } : {})
  });
}

/**
 * Canonical, secret-free representation for Runtime UI. It is derived from the
 * same immutable AgentSessionContext and RuntimePolicyEngine used for execution.
 */
export function buildEffectiveRuntimeContext(input: {
  readonly session: AgentSessionContext;
  readonly policyEngine: RuntimePolicyEngine;
  readonly sessionOverride?: RuntimeSessionPolicyOverride;
  readonly labels?: EffectiveContextLabels;
  readonly mcpCandidates?: readonly EffectiveContextMcpCandidate[];
}): EffectiveRuntimeContext {
  const { session, policyEngine, sessionOverride, labels = {} } = input;
  const companyPolicy = policyEngine.store.company(session.companyId);
  const projectPolicy = session.project ? policyEngine.store.project(session.companyId, session.project.id) : undefined;
  const boundMcp = new Set(session.resources.filter((resource) => resource.kind === 'mcp').map((resource) => resource.id));
  const mcp = (input.mcpCandidates ?? session.resources.filter((resource) => resource.kind === 'mcp').map((resource) => ({
    id: resource.id,
    companyId: resource.companyId,
    projectId: resource.projectId,
    enabled: true
  }))).map((server) => {
    const scopeAllowed = server.companyId === session.companyId && (server.projectId === undefined || server.projectId === session.project?.id);
    const status = !server.enabled ? 'disabled' as const : scopeAllowed && boundMcp.has(server.id) ? 'enabled' as const : 'policy-denied' as const;
    return Object.freeze({ id: redactRuntimeText(server.id, { maxChars: 256 }), ...(server.name ? { name: redactRuntimeText(server.name, { maxChars: 256 }) } : {}), status });
  });

  const permissionIds = new Set([...Object.keys(session.permissions.entries)]);
  const rules = [
    ...(companyPolicy?.rules ?? []).map((rule) => safeRule(rule, 'company')),
    ...(projectPolicy?.rules ?? []).map((rule) => safeRule(rule, 'project')),
    ...(sessionOverride?.rules ?? []).map((rule) => safeRule(rule, 'session'))
  ];

  return Object.freeze({
    sessionId: redactRuntimeText(session.sessionId, { maxChars: 256 }),
    company: Object.freeze({ id: session.companyId, ...(labels.companyName ? { name: redactRuntimeText(labels.companyName, { maxChars: 256 }) } : {}) }),
    ...(session.project ? { project: Object.freeze({ id: session.project.id, ...(labels.projectName ? { name: redactRuntimeText(labels.projectName, { maxChars: 256 }) } : {}) }) } : {}),
    connection: Object.freeze({
      id: session.connection.id,
      ...(labels.connectionName ? { name: redactRuntimeText(labels.connectionName, { maxChars: 256 }) } : {}),
      providerFamily: session.connection.providerFamily,
      authKind: session.connection.authKind,
      sharedLocal: session.connection.companyId === null
    }),
    model: Object.freeze({ id: redactRuntimeText(session.modelId, { maxChars: 256 }) }),
    execution: Object.freeze({
      id: session.executionTarget.id,
      ...(labels.executionTargetName ? { name: redactRuntimeText(labels.executionTargetName, { maxChars: 256 }) } : {}),
      kind: session.executionTarget.kind,
      mode: session.executionTarget.mode
    }),
    authority: Object.freeze({
      mode: effectiveMode([companyPolicy?.mode, projectPolicy?.mode, sessionOverride?.mode]),
      ...(companyPolicy?.mode ? { companyMode: companyPolicy.mode } : {}),
      ...(projectPolicy?.mode ? { projectMode: projectPolicy.mode } : {}),
      ...(sessionOverride?.mode ? { sessionMode: sessionOverride.mode } : {}),
      denyWins: true as const
    }),
    roots: Object.freeze(session.roots.map((root) => Object.freeze({ id: root.id, path: redactRuntimeText(root.path, { maxChars: 2_000 }), access: root.access }))),
    mcp: Object.freeze(mcp),
    permissions: Object.freeze([...permissionIds].sort().map((id) => Object.freeze({ id, status: session.permissions.entries[id] ?? session.permissions.default }))),
    rules: Object.freeze(rules),
    network: Object.freeze({
      publicHttps: 'allowed-by-network-boundary' as const,
      loopback: 'explicit-opt-in' as const,
      privateNetwork: 'explicit-opt-in' as const,
      linkLocal: 'explicit-opt-in' as const,
      metadataServices: 'denied' as const,
      credentialBearingUrls: 'denied' as const,
      redirects: 'reauthorized-per-hop' as const
    })
  });
}
