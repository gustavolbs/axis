import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apiCredentialConnectionId } from './connection-identity.js';
import type { CredentialProfile } from './credential-store.js';
import type { ProviderKind } from './providers/types.js';

export type RoutingPolicy =
  | 'auto'
  | 'local-first'
  | 'balanced'
  | 'speed-first'
  | 'deep'
  | 'frontier-only';

export type ModelSelection =
  | { mode: 'auto' }
  | { mode: 'explicit'; providerId: string; modelId: string }
  | { mode: 'local-first'; modelId: string };

export interface ProjectPrivacyPolicy {
  cloudAllowed: boolean;
  allowedProviderIds: string[];
}

export interface ProjectConnectionPolicy {
  chat: {
    defaultConnectionId?: string;
    defaultModelId?: string;
    allowedConnectionIds: string[];
  };
  inference: {
    allowedConnectionIds: string[];
    preferredConnectionId?: string;
  };
  workSourceIds: string[];
}

export interface ProjectBudgetPolicy {
  monthlyUsd?: number;
  dailyUsd?: number;
  perJobUsd?: number;
  warningFractions: number[];
  hardStopFraction: number;
}

export interface ProjectDefinition {
  id: string;
  name: string;
  description?: string;
  workspace: string;
  instructions?: string;
  organizationId: string;
  organizationName?: string;
  defaultRoutingPolicy: RoutingPolicy;
  defaultModel: ModelSelection;
  privacy: ProjectPrivacyPolicy;
  /** Legacy provider-family -> credential binding. New code should use connectionPolicy. */
  credentialProfileIds: Record<string, string>;
  /** Always persisted by ProjectStore; optional only so legacy in-memory callers migrate safely. */
  connectionPolicy?: ProjectConnectionPolicy;
  budgets: ProjectBudgetPolicy;
  repoIntelligenceScope: 'project';
  concurrency: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  description?: string;
  workspace?: string;
  instructions?: string;
  organizationId: string;
  organizationName?: string;
  defaultRoutingPolicy?: RoutingPolicy;
  defaultModel?: ModelSelection;
  privacy?: ProjectPrivacyPolicy;
  credentialProfileIds?: Record<string, string>;
  connectionPolicy?: ProjectConnectionPolicy;
  budgets?: Partial<ProjectBudgetPolicy>;
  concurrency?: number;
}

interface ProjectStoreFile {
  version: 1;
  projects: ProjectDefinition[];
  updatedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROUTING_POLICIES = new Set<RoutingPolicy>([
  'auto', 'local-first', 'balanced', 'speed-first', 'deep', 'frontier-only'
]);
const MAX_PROJECT_INSTRUCTIONS = 40_000;
const MAX_PROJECT_DESCRIPTION = 2_000;

function safeId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_ID.test(trimmed)) throw new Error(`${label} contains unsupported characters.`);
  return trimmed;
}

function text(value: string, label: string, max = 160): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`${label} must be 1-${max} characters.`);
  return trimmed;
}

function optionalInstructions(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_PROJECT_INSTRUCTIONS) {
    throw new Error(`Project instructions must be at most ${MAX_PROJECT_INSTRUCTIONS} characters.`);
  }
  return trimmed;
}

function optionalDescription(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_PROJECT_DESCRIPTION) {
    throw new Error(`Project description must be at most ${MAX_PROJECT_DESCRIPTION} characters.`);
  }
  return trimmed;
}

function normalizeWorkspace(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  if (trimmed.length > 4096) throw new Error('Project workspace must be at most 4096 characters.');
  return path.resolve(trimmed);
}

function positiveMoney(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number.`);
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeBudgets(input: Partial<ProjectBudgetPolicy> = {}): ProjectBudgetPolicy {
  const warningFractions = input.warningFractions ?? [0.5, 0.75, 0.9];
  if (
    warningFractions.length === 0 ||
    warningFractions.some((value) => !Number.isFinite(value) || value <= 0 || value >= 1)
  ) throw new Error('Budget warning fractions must be between 0 and 1.');
  const hardStopFraction = input.hardStopFraction ?? 1;
  if (!Number.isFinite(hardStopFraction) || hardStopFraction <= 0) {
    throw new Error('Budget hard-stop fraction must be positive.');
  }
  return {
    monthlyUsd: positiveMoney(input.monthlyUsd, 'Monthly budget'),
    dailyUsd: positiveMoney(input.dailyUsd, 'Daily budget'),
    perJobUsd: positiveMoney(input.perJobUsd, 'Per-job budget'),
    warningFractions: [...new Set(warningFractions)].sort((a, b) => a - b),
    hardStopFraction
  };
}

function normalizePrivacy(input?: ProjectPrivacyPolicy): ProjectPrivacyPolicy {
  const policy = input ?? { cloudAllowed: false, allowedProviderIds: ['ollama'] };
  const allowedProviderIds = [...new Set(policy.allowedProviderIds.map((id) => safeId(id, 'Provider id')))];
  if (allowedProviderIds.length === 0) throw new Error('Project provider allowlist cannot be empty.');
  return { cloudAllowed: policy.cloudAllowed === true, allowedProviderIds };
}

function normalizeModel(input: ModelSelection | undefined): ModelSelection {
  if (!input || input.mode === 'auto') return { mode: 'auto' };
  if (input.mode === 'local-first') {
    return { mode: 'local-first', modelId: text(input.modelId, 'Local-first model id', 240) };
  }
  return {
    mode: 'explicit',
    providerId: safeId(input.providerId, 'Model provider/connection id'),
    modelId: text(input.modelId, 'Model id', 240)
  };
}

function normalizeCredentialMap(input: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [providerId, credentialId] of Object.entries(input ?? {})) {
    result[safeId(providerId, 'Credential provider id')] = safeId(credentialId, 'Credential profile id');
  }
  return result;
}

function connectionIds(values: string[] | undefined, label: string): string[] {
  return [...new Set((values ?? []).map((value) => safeId(value, label)))];
}

function legacyConnectionId(providerId: string, credentialId?: string): string {
  if (credentialId && (providerId === 'openai' || providerId === 'anthropic')) {
    return apiCredentialConnectionId(providerId, credentialId);
  }
  return providerId;
}

function migrateExplicitModel(
  model: ModelSelection,
  credentials: Record<string, string>
): ModelSelection {
  if (model.mode !== 'explicit') return model;
  const migrated = legacyConnectionId(model.providerId, credentials[model.providerId]);
  return migrated === model.providerId ? model : { ...model, providerId: migrated };
}

export function deriveLegacyConnectionPolicy(
  privacy: ProjectPrivacyPolicy,
  credentialProfileIds: Record<string, string> = {},
  defaultModel: ModelSelection = { mode: 'auto' }
): ProjectConnectionPolicy {
  const allowed = privacy.allowedProviderIds.map((providerId) =>
    legacyConnectionId(providerId, credentialProfileIds[providerId])
  );
  const uniqueAllowed = [...new Set(allowed)];
  let defaultConnectionId: string | undefined;
  let defaultModelId: string | undefined;
  if (defaultModel.mode === 'local-first') {
    defaultConnectionId = uniqueAllowed.includes('ollama') ? 'ollama' : undefined;
    defaultModelId = defaultModel.modelId;
  } else if (defaultModel.mode === 'explicit') {
    const migrated = legacyConnectionId(defaultModel.providerId, credentialProfileIds[defaultModel.providerId]);
    if (uniqueAllowed.includes(migrated)) {
      defaultConnectionId = migrated;
      defaultModelId = defaultModel.modelId;
    }
  }
  defaultConnectionId ??= uniqueAllowed[0];
  return {
    chat: { defaultConnectionId, defaultModelId, allowedConnectionIds: [...uniqueAllowed] },
    inference: { allowedConnectionIds: [...uniqueAllowed], preferredConnectionId: defaultConnectionId },
    workSourceIds: []
  };
}

export function effectiveProjectConnectionPolicy(
  project: Pick<ProjectDefinition, 'privacy' | 'credentialProfileIds' | 'defaultModel' | 'connectionPolicy'>
): ProjectConnectionPolicy {
  return project.connectionPolicy ?? deriveLegacyConnectionPolicy(
    project.privacy,
    project.credentialProfileIds ?? {},
    project.defaultModel
  );
}

function normalizeConnectionPolicy(
  input: ProjectConnectionPolicy | undefined,
  legacy: ProjectConnectionPolicy
): ProjectConnectionPolicy {
  const candidate = input ?? legacy;
  const inferenceAllowed = connectionIds(candidate.inference?.allowedConnectionIds, 'Inference connection id');
  if (inferenceAllowed.length === 0) throw new Error('Project inference connection allowlist cannot be empty.');
  const chatAllowed = connectionIds(candidate.chat?.allowedConnectionIds, 'Chat connection id');
  const effectiveChat = chatAllowed.length > 0 ? chatAllowed : [...inferenceAllowed];
  const defaultConnectionId = candidate.chat?.defaultConnectionId
    ? safeId(candidate.chat.defaultConnectionId, 'Default Chat connection id')
    : effectiveChat[0];
  if (defaultConnectionId && !effectiveChat.includes(defaultConnectionId)) {
    throw new Error(`Default Chat connection ${defaultConnectionId} is not in the Project Chat allowlist.`);
  }
  const preferredConnectionId = candidate.inference?.preferredConnectionId
    ? safeId(candidate.inference.preferredConnectionId, 'Preferred inference connection id')
    : undefined;
  if (preferredConnectionId && !inferenceAllowed.includes(preferredConnectionId)) {
    throw new Error(`Preferred inference connection ${preferredConnectionId} is not in the Project inference allowlist.`);
  }
  return {
    chat: {
      defaultConnectionId,
      defaultModelId: candidate.chat?.defaultModelId
        ? text(candidate.chat.defaultModelId, 'Default Chat model id', 240)
        : undefined,
      allowedConnectionIds: effectiveChat
    },
    inference: { allowedConnectionIds: inferenceAllowed, preferredConnectionId },
    workSourceIds: connectionIds(candidate.workSourceIds, 'Work Hub source id')
  };
}

function normalizeProject(
  input: CreateProjectInput,
  existing?: ProjectDefinition,
  preserveUpdatedAt?: string
): ProjectDefinition {
  const now = preserveUpdatedAt ?? new Date().toISOString();
  const routing = input.defaultRoutingPolicy ?? existing?.defaultRoutingPolicy ?? 'local-first';
  if (!ROUTING_POLICIES.has(routing)) throw new Error(`Unsupported routing policy: ${routing}`);
  const concurrency = input.concurrency ?? existing?.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Project concurrency must be an integer between 1 and 32.');
  }
  const privacy = normalizePrivacy(input.privacy ?? existing?.privacy);
  const credentials = normalizeCredentialMap(input.credentialProfileIds ?? existing?.credentialProfileIds);
  const rawDefaultModel = normalizeModel(input.defaultModel ?? existing?.defaultModel);
  const defaultModel = migrateExplicitModel(rawDefaultModel, credentials);
  const legacyPolicy = deriveLegacyConnectionPolicy(privacy, credentials, rawDefaultModel);
  const connectionPolicy = normalizeConnectionPolicy(input.connectionPolicy ?? existing?.connectionPolicy, legacyPolicy);

  if (
    defaultModel.mode === 'explicit' &&
    !connectionPolicy.inference.allowedConnectionIds.includes(defaultModel.providerId) &&
    !connectionPolicy.chat.allowedConnectionIds.includes(defaultModel.providerId)
  ) {
    throw new Error(`Explicit model connection ${defaultModel.providerId} is not allowed by the Project connection policy.`);
  }
  if (defaultModel.mode === 'local-first' && !connectionPolicy.inference.allowedConnectionIds.includes('ollama')) {
    throw new Error('Local-first mode requires the Ollama connection in the Project inference allowlist.');
  }

  return {
    id: safeId(input.id ?? existing?.id ?? randomUUID(), 'Project id'),
    name: text(input.name, 'Project name'),
    description: optionalDescription(input.description ?? existing?.description),
    workspace: normalizeWorkspace(input.workspace ?? existing?.workspace),
    instructions: optionalInstructions(input.instructions ?? existing?.instructions),
    organizationId: safeId(input.organizationId, 'Organization id'),
    organizationName: input.organizationName ? text(input.organizationName, 'Organization name') : existing?.organizationName,
    defaultRoutingPolicy: routing,
    defaultModel,
    privacy,
    credentialProfileIds: credentials,
    connectionPolicy,
    budgets: normalizeBudgets(input.budgets ?? existing?.budgets),
    repoIntelligenceScope: 'project',
    concurrency,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

function parseProject(value: unknown): ProjectDefinition | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  try {
    if (
      typeof item.id !== 'string' || typeof item.name !== 'string' ||
      (item.description !== undefined && typeof item.description !== 'string') ||
      (item.workspace !== undefined && typeof item.workspace !== 'string') ||
      (item.instructions !== undefined && typeof item.instructions !== 'string') ||
      typeof item.organizationId !== 'string' || typeof item.defaultRoutingPolicy !== 'string' ||
      !item.defaultModel || typeof item.defaultModel !== 'object' ||
      !item.privacy || typeof item.privacy !== 'object' ||
      !item.credentialProfileIds || typeof item.credentialProfileIds !== 'object' ||
      (item.connectionPolicy !== undefined && (!item.connectionPolicy || typeof item.connectionPolicy !== 'object' || Array.isArray(item.connectionPolicy))) ||
      !item.budgets || typeof item.budgets !== 'object' || typeof item.concurrency !== 'number' ||
      typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string'
    ) return undefined;
    const existing = { ...(item as unknown as ProjectDefinition), workspace: typeof item.workspace === 'string' ? item.workspace : '' };
    return normalizeProject({
      id: existing.id,
      name: existing.name,
      description: existing.description,
      workspace: existing.workspace,
      instructions: existing.instructions,
      organizationId: existing.organizationId,
      organizationName: existing.organizationName,
      defaultRoutingPolicy: existing.defaultRoutingPolicy,
      defaultModel: existing.defaultModel,
      privacy: existing.privacy,
      credentialProfileIds: existing.credentialProfileIds,
      connectionPolicy: existing.connectionPolicy,
      budgets: existing.budgets,
      concurrency: existing.concurrency
    }, existing, existing.updatedAt);
  } catch {
    return undefined;
  }
}

export function projectStorePath(): string {
  return process.env.LOCAL_CODER_PROJECTS_PATH?.trim() || path.join(os.homedir(), '.local-coder-mcp', 'projects.json');
}

export function projectIsolationKey(project: Pick<ProjectDefinition, 'id' | 'organizationId'>): string {
  return createHash('sha256').update(project.organizationId).update('\0').update(project.id).digest('hex');
}

export function projectRepoMemoryScopeKey(
  project: Pick<ProjectDefinition, 'id' | 'organizationId' | 'workspace'>,
  workspace: string
): string {
  const base = projectIsolationKey(project);
  if (project.workspace) return base;
  return createHash('sha256').update(base).update('\0').update(path.resolve(workspace)).digest('hex');
}

export function assertProjectProviderAllowed(
  project: ProjectDefinition,
  providerId: string,
  providerKind: ProviderKind
): void {
  const policy = effectiveProjectConnectionPolicy(project);
  const exactAllowed = new Set([
    ...policy.inference.allowedConnectionIds,
    ...policy.chat.allowedConnectionIds
  ]);
  if (!exactAllowed.has(providerId) && !project.privacy.allowedProviderIds.includes(providerId)) {
    throw new Error(`Connection/provider ${providerId} is blocked by project ${project.id}'s allowlist.`);
  }
  if (providerKind === 'cloud' && !project.privacy.cloudAllowed) {
    throw new Error(`Project ${project.id} does not allow cloud inference.`);
  }
}

export function assertProjectCredentialIsolation(
  project: ProjectDefinition,
  credentials: CredentialProfile[]
): void {
  const byId = new Map(credentials.map((credential) => [credential.id, credential]));
  for (const [providerId, credentialId] of Object.entries(project.credentialProfileIds ?? {})) {
    const credential = byId.get(credentialId);
    if (!credential) throw new Error(`Project ${project.id} references missing credential ${credentialId}.`);
    if (credential.providerId !== providerId) {
      throw new Error(`Credential ${credentialId} belongs to ${credential.providerId}, not ${providerId}.`);
    }
    if (credential.organizationId !== undefined && credential.organizationId !== project.organizationId) {
      throw new Error(`Credential ${credentialId} is outside project ${project.id}'s organization isolation boundary.`);
    }
  }
}

export class ProjectStore {
  constructor(private readonly file = projectStorePath()) {}

  list(): ProjectDefinition[] {
    return this.read().projects.map((project) => structuredClone(project));
  }

  get(id: string): ProjectDefinition | undefined {
    const projectId = safeId(id, 'Project id');
    const project = this.read().projects.find((entry) => entry.id === projectId);
    return project ? structuredClone(project) : undefined;
  }

  create(input: CreateProjectInput): ProjectDefinition {
    const state = this.read();
    const project = normalizeProject(input);
    if (state.projects.some((entry) => entry.id === project.id)) throw new Error(`Project already exists: ${project.id}`);
    state.projects.unshift(project);
    state.updatedAt = project.updatedAt;
    this.write(state);
    return structuredClone(project);
  }

  update(id: string, patch: Partial<Omit<CreateProjectInput, 'id'>>): ProjectDefinition {
    const projectId = safeId(id, 'Project id');
    const state = this.read();
    const current = state.projects.find((entry) => entry.id === projectId);
    if (!current) throw new Error(`Project not found: ${projectId}`);
    const mergedBudgets = patch.budgets ? { ...current.budgets, ...patch.budgets } : current.budgets;
    const project = normalizeProject({
      id: current.id,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      workspace: patch.workspace ?? current.workspace,
      instructions: patch.instructions ?? current.instructions,
      organizationId: patch.organizationId ?? current.organizationId,
      organizationName: patch.organizationName ?? current.organizationName,
      defaultRoutingPolicy: patch.defaultRoutingPolicy ?? current.defaultRoutingPolicy,
      defaultModel: patch.defaultModel ?? current.defaultModel,
      privacy: patch.privacy ?? current.privacy,
      credentialProfileIds: patch.credentialProfileIds ?? current.credentialProfileIds,
      connectionPolicy: patch.connectionPolicy ?? current.connectionPolicy,
      budgets: mergedBudgets,
      concurrency: patch.concurrency ?? current.concurrency
    }, current);
    state.projects = state.projects.map((entry) => entry.id === projectId ? project : entry);
    state.updatedAt = project.updatedAt;
    this.write(state);
    return structuredClone(project);
  }

  remove(id: string): boolean {
    const projectId = safeId(id, 'Project id');
    const state = this.read();
    const next = state.projects.filter((entry) => entry.id !== projectId);
    if (next.length === state.projects.length) return false;
    state.projects = next;
    state.updatedAt = new Date().toISOString();
    this.write(state);
    return true;
  }

  private read(): ProjectStoreFile {
    if (!fs.existsSync(this.file)) return { version: 1, projects: [], updatedAt: new Date(0).toISOString() };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Could not read Local Coder projects: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Local Coder projects file must be a JSON object.');
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.projects)) {
      throw new Error(`Unsupported Local Coder projects version: ${String(value.version)}`);
    }
    const projects = value.projects.map(parseProject);
    if (projects.some((project) => !project)) throw new Error('Local Coder projects file contains an invalid project.');
    return {
      version: 1,
      projects: projects as ProjectDefinition[],
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString()
    };
  }

  private write(state: ProjectStoreFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort on non-POSIX */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }
}
