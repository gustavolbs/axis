import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  StaticToolPermissionGate,
  type AgentDecisionRequest,
  type AgentDecisionResolution,
  type AgentSessionContext,
  type ToolPermissionDecision,
  type ToolPermissionGate,
  type ToolPermissionRequest
} from '../agent-runtime/index.js';
import { redactRuntimeText } from './redaction.js';

export type RuntimeAuthorityMode = 'plan' | 'ask-before' | 'workspace-write' | 'auto' | 'full-access';
export type RuntimePolicyEffect = 'allow' | 'ask' | 'deny';
export type RuntimePolicyDomain = 'filesystem' | 'process' | 'git' | 'mcp' | 'browser' | 'network' | 'destructive' | 'external';

export interface RuntimePolicyRule {
  readonly id: string;
  readonly effect: RuntimePolicyEffect;
  readonly domain: RuntimePolicyDomain;
  /** Case-insensitive glob matched against the canonical operation descriptor. */
  readonly match?: string;
  readonly note?: string;
}

export interface RuntimePolicyScope {
  readonly mode?: RuntimeAuthorityMode;
  readonly rules?: readonly RuntimePolicyRule[];
}

interface RuntimeCompanyPolicy extends RuntimePolicyScope {
  readonly projects?: Readonly<Record<string, RuntimePolicyScope>>;
}

interface RuntimePolicyFile {
  readonly version: 1;
  readonly companies: Readonly<Record<string, RuntimeCompanyPolicy>>;
  readonly updatedAt: string;
}

export interface RuntimeSessionPolicyOverride extends RuntimePolicyScope {
  /** Only trusted product/session composition may construct this object. Tool output is never accepted here. */
  readonly source: 'trusted-session-config';
}

export interface RuntimePolicySubject {
  readonly domain: RuntimePolicyDomain;
  readonly descriptor: string;
  readonly destructive: boolean;
  readonly external: boolean;
}

export interface RuntimePolicyDecision {
  readonly effect: RuntimePolicyEffect;
  readonly mode: RuntimeAuthorityMode;
  readonly subject: RuntimePolicySubject;
  readonly matchedRuleIds: readonly string[];
  readonly reason: string;
}

const SAFE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MODE_RANK: Readonly<Record<RuntimeAuthorityMode, number>> = {
  plan: 0,
  'ask-before': 1,
  'workspace-write': 2,
  auto: 3,
  'full-access': 4
};
const EFFECT_RANK: Readonly<Record<RuntimePolicyEffect, number>> = { deny: 0, ask: 1, allow: 2 };
const DESTRUCTIVE_COMMANDS = new Set(['rm', 'rmdir', 'del', 'erase', 'format', 'diskpart', 'shutdown', 'reboot']);

function runtimePolicyPath(): string {
  return process.env.AXIS_RUNTIME_POLICY_PATH?.trim() || path.join(os.homedir(), '.local-coder-mcp', 'runtime-policies.json');
}

function cleanScopeId(value: string, label: string): string {
  const clean = value.trim();
  if (!SAFE_SCOPE_ID.test(clean) || ['__proto__', 'prototype', 'constructor'].includes(clean)) {
    throw new Error(`${label} is not a safe runtime policy scope id.`);
  }
  return clean;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function runtimeToolArgumentFingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function commandDescriptor(args: Readonly<Record<string, unknown>>): string | undefined {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return undefined;
  const argv = Array.isArray(args.args) ? args.args.filter((item): item is string => typeof item === 'string') : [];
  return [command, ...argv].join(' ').trim();
}

function pathDescriptor(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ['path', 'file', 'target', 'cwd', 'rootId']) {
    if (typeof args[key] === 'string' && args[key]!.trim()) return String(args[key]).trim();
  }
  return undefined;
}

function urlDescriptor(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ['url', 'href', 'endpoint']) {
    if (typeof args[key] === 'string' && args[key]!.trim()) return String(args[key]).trim();
  }
  return undefined;
}

export function runtimePolicySubject(request: ToolPermissionRequest): RuntimePolicySubject {
  const caps = request.tool.requiredCapabilities.join(' ');
  const name = request.tool.name;
  const args = request.call.arguments;
  const processDomain = caps.includes('axis.process.') || name.startsWith('process_');
  const gitDomain = caps.includes('axis.git.') || name.startsWith('git_');
  const filesystemDomain = caps.includes('axis.filesystem.') || name.startsWith('filesystem_');
  const mcpDomain = caps.includes('axis.mcp.') || name.startsWith('mcp_') || name.startsWith('axis_mcp_');
  const browserDomain = caps.includes('axis.browser.') || name.startsWith('axis_browser_');
  const domain: RuntimePolicyDomain = processDomain ? 'process' : gitDomain ? 'git' : filesystemDomain ? 'filesystem' : mcpDomain ? 'mcp' : browserDomain ? 'browser' : request.tool.effect === 'external' ? 'external' : 'filesystem';
  const command = processDomain ? commandDescriptor(args) : undefined;
  const descriptor = redactRuntimeText(command ?? urlDescriptor(args) ?? pathDescriptor(args) ?? name, { maxChars: 2_000 });
  const executable = command?.split(/\s+/)[0]?.toLowerCase();
  const destructive = request.tool.mutationRisk === 'high' ||
    Boolean(executable && DESTRUCTIVE_COMMANDS.has(path.basename(executable))) ||
    /(?:^|[_-])(delete|remove|destroy|reset|clean|purge)(?:$|[_-])/i.test(name) ||
    (gitDomain && /\bgit\s+(?:reset\s+--hard|clean\b)/i.test(command ?? ''));
  const external = request.tool.effect === 'external' || mcpDomain || browserDomain;
  return { domain, descriptor, destructive, external };
}

function globRegex(value: string): RegExp {
  const escaped = value.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesRule(rule: RuntimePolicyRule, subject: RuntimePolicySubject): boolean {
  if (rule.domain !== subject.domain && !(rule.domain === 'destructive' && subject.destructive) && !(rule.domain === 'external' && subject.external)) return false;
  return !rule.match?.trim() || globRegex(rule.match).test(subject.descriptor);
}

function restrictiveMode(modes: readonly (RuntimeAuthorityMode | undefined)[]): RuntimeAuthorityMode {
  const present = modes.filter((mode): mode is RuntimeAuthorityMode => Boolean(mode));
  if (present.length === 0) return 'workspace-write';
  return present.reduce((strictest, mode) => MODE_RANK[mode] < MODE_RANK[strictest] ? mode : strictest);
}

function strictestEffect(effects: readonly RuntimePolicyEffect[]): RuntimePolicyEffect | undefined {
  return effects.length ? effects.reduce((strictest, effect) => EFFECT_RANK[effect] < EFFECT_RANK[strictest] ? effect : strictest) : undefined;
}

function modeEffect(mode: RuntimeAuthorityMode, subject: RuntimePolicySubject, toolEffect: ToolPermissionRequest['tool']['effect']): RuntimePolicyEffect {
  if (mode === 'plan') return toolEffect === 'read' || toolEffect === 'validation' ? 'allow' : 'deny';
  if (mode === 'ask-before') return toolEffect === 'read' || toolEffect === 'validation' ? 'allow' : 'ask';
  if (mode === 'workspace-write') {
    if (subject.destructive || subject.external) return 'ask';
    return 'allow';
  }
  if (mode === 'auto') return subject.destructive ? 'ask' : 'allow';
  return 'allow';
}

function validateRule(rule: RuntimePolicyRule): RuntimePolicyRule {
  if (!rule.id?.trim()) throw new Error('Runtime policy rule id is required.');
  if (!['allow', 'ask', 'deny'].includes(rule.effect)) throw new Error(`Invalid runtime policy effect: ${rule.effect}`);
  if (!['filesystem', 'process', 'git', 'mcp', 'browser', 'network', 'destructive', 'external'].includes(rule.domain)) throw new Error(`Invalid runtime policy domain: ${rule.domain}`);
  const match = rule.match?.trim();
  const note = rule.note?.trim();
  if (match && redactRuntimeText(match) !== match) throw new Error('Runtime policy rules must not persist credentials or secrets.');
  if (note && redactRuntimeText(note) !== note) throw new Error('Runtime policy notes must not persist credentials or secrets.');
  return Object.freeze({ id: rule.id.trim(), effect: rule.effect, domain: rule.domain, ...(match ? { match } : {}), ...(note ? { note } : {}) });
}

function validateScope(scope: RuntimePolicyScope): RuntimePolicyScope {
  if (scope.mode && !(scope.mode in MODE_RANK)) throw new Error(`Invalid runtime authority mode: ${scope.mode}`);
  return Object.freeze({ ...(scope.mode ? { mode: scope.mode } : {}), rules: Object.freeze((scope.rules ?? []).map(validateRule)) });
}

function freshFile(): RuntimePolicyFile {
  return { version: 1, companies: Object.freeze({}), updatedAt: new Date().toISOString() };
}

export class RuntimePolicyStore {
  private state: RuntimePolicyFile;

  constructor(readonly filePath = runtimePolicyPath(), initial?: RuntimePolicyFile) {
    this.state = initial ?? this.read();
  }

  private read(): RuntimePolicyFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as RuntimePolicyFile;
      if (raw.version !== 1 || !raw.companies || typeof raw.companies !== 'object') throw new Error('Unsupported runtime policy file.');
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return freshFile();
      throw error;
    }
  }

  private write(next: RuntimePolicyFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
    this.state = next;
  }

  company(companyId: string): RuntimeCompanyPolicy | undefined {
    return this.state.companies[cleanScopeId(companyId, 'Company id')];
  }

  project(companyId: string, projectId: string): RuntimePolicyScope | undefined {
    return this.company(companyId)?.projects?.[cleanScopeId(projectId, 'Project id')];
  }

  setCompany(companyId: string, scope: RuntimePolicyScope): void {
    const id = cleanScopeId(companyId, 'Company id');
    const existing = this.state.companies[id];
    const company: RuntimeCompanyPolicy = { ...validateScope(scope), ...(existing?.projects ? { projects: existing.projects } : {}) };
    this.write({ version: 1, companies: { ...this.state.companies, [id]: company }, updatedAt: new Date().toISOString() });
  }

  setProject(companyId: string, projectId: string, scope: RuntimePolicyScope): void {
    const companyKey = cleanScopeId(companyId, 'Company id');
    const projectKey = cleanScopeId(projectId, 'Project id');
    const company = this.state.companies[companyKey] ?? { rules: [] };
    this.write({
      version: 1,
      companies: {
        ...this.state.companies,
        [companyKey]: { ...company, projects: { ...(company.projects ?? {}), [projectKey]: validateScope(scope) } }
      },
      updatedAt: new Date().toISOString()
    });
  }
}

export class RuntimePolicyEngine {
  constructor(readonly store = new RuntimePolicyStore()) {}

  evaluate(request: ToolPermissionRequest, sessionOverride?: RuntimeSessionPolicyOverride): RuntimePolicyDecision {
    const company = this.store.company(request.session.companyId);
    const project = request.session.project ? this.store.project(request.session.companyId, request.session.project.id) : undefined;
    const mode = restrictiveMode([company?.mode, project?.mode, sessionOverride?.mode]);
    const subject = runtimePolicySubject(request);
    const matches = [company?.rules ?? [], project?.rules ?? [], sessionOverride?.rules ?? []]
      .flat()
      .filter((rule) => matchesRule(rule, subject));
    const explicit = strictestEffect(matches.map((rule) => rule.effect));
    const fallback = modeEffect(mode, subject, request.tool.effect);
    const effect = explicit === undefined ? fallback : strictestEffect([fallback, explicit])!;
    const reason = matches.length
      ? `${effect.toUpperCase()} by runtime policy rule(s): ${matches.map((rule) => rule.id).join(', ')}.`
      : `${effect.toUpperCase()} by ${mode} authority mode.`;
    return { effect, mode, subject, matchedRuleIds: Object.freeze(matches.map((rule) => rule.id)), reason };
  }
}

interface PendingApproval {
  readonly requestId: string;
  readonly sessionId: string;
  readonly companyId: string;
  readonly toolName: string;
  readonly argumentFingerprint: string;
}

/** Deny-wins permission gate. A user approval can satisfy ASK, never override DENY. */
export class RuntimePolicyPermissionGate implements ToolPermissionGate {
  private readonly base = new StaticToolPermissionGate();
  private pending?: PendingApproval;
  private lastAsk?: Omit<PendingApproval, 'requestId'>;
  private resolution?: AgentDecisionResolution;
  private consumed = false;

  constructor(
    readonly engine: RuntimePolicyEngine,
    readonly sessionOverride?: RuntimeSessionPolicyOverride
  ) {}

  remember(request: AgentDecisionRequest, call?: { name: string; arguments: Readonly<Record<string, unknown>> }): void {
    if (!call || !this.lastAsk) return;
    if (call.name !== this.lastAsk.toolName || runtimeToolArgumentFingerprint(call.arguments) !== this.lastAsk.argumentFingerprint) return;
    this.pending = { requestId: request.id, ...this.lastAsk };
    this.resolution = undefined;
    this.consumed = false;
  }

  resolve(resolution: AgentDecisionResolution): void {
    if (!this.pending || resolution.requestId !== this.pending.requestId) return;
    this.resolution = resolution;
    this.consumed = false;
  }

  async authorize(request: ToolPermissionRequest): Promise<ToolPermissionDecision> {
    const base = await this.base.authorize(request);
    if (!base.allowed && !base.requiresApproval) return base;

    const policy = this.engine.evaluate(request, this.sessionOverride);
    if (policy.effect === 'deny') return { allowed: false, reason: policy.reason };

    const needsApproval = base.requiresApproval === true || policy.effect === 'ask';
    if (!needsApproval) return { allowed: true, reason: policy.reason };

    const identity = {
      sessionId: request.session.sessionId,
      companyId: request.session.companyId,
      toolName: request.tool.name,
      argumentFingerprint: runtimeToolArgumentFingerprint(request.call.arguments)
    };
    this.lastAsk = identity;
    const approved = this.pending && this.resolution && !this.consumed &&
      this.pending.sessionId === identity.sessionId &&
      this.pending.companyId === identity.companyId &&
      this.pending.toolName === identity.toolName &&
      this.pending.argumentFingerprint === identity.argumentFingerprint &&
      (this.resolution.optionId === 'approve' || this.resolution.text?.trim().toLowerCase() === 'approve');
    if (approved) {
      this.consumed = true;
      return { allowed: true, reason: `Approved once by ${this.pending!.requestId}; ${policy.reason}` };
    }
    if (this.pending && this.resolution && this.resolution.requestId === this.pending.requestId) {
      return { allowed: false, reason: `Denied by decision ${this.resolution.requestId}.` };
    }
    return { allowed: false, requiresApproval: true, reason: base.reason ?? policy.reason };
  }
}

export function policyRule(effect: RuntimePolicyEffect, domain: RuntimePolicyDomain, match?: string, note?: string): RuntimePolicyRule {
  return validateRule({ id: randomUUID(), effect, domain, ...(match ? { match } : {}), ...(note ? { note } : {}) });
}

export function assertTrustedPolicyOverride(value: RuntimeSessionPolicyOverride): RuntimeSessionPolicyOverride {
  if (value.source !== 'trusted-session-config') throw new Error('External/tool content cannot modify Axis runtime authority.');
  validateScope(value);
  return value;
}

export function sameAuthority(left: AgentSessionContext, right: AgentSessionContext): boolean {
  return left.sessionId === right.sessionId && left.companyId === right.companyId && left.project?.id === right.project?.id && left.connection.id === right.connection.id && left.modelId === right.modelId && left.executionTarget.id === right.executionTarget.id;
}
