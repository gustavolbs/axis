import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LOCAL_ORGANIZATION_ID, PERSONAL_ORGANIZATION_ID } from './connection-identity.js';

/**
 * Canonical company identity for Axis. `organization*` fields are legacy migration
 * inputs only; workspaces are filesystem locations and account labels are display
 * metadata. Neither is allowed to become an identity boundary in this module.
 */
export const PERSONAL_COMPANY_ID = PERSONAL_ORGANIZATION_ID;
export const DEFAULT_COMPANY_COLOR = '#64748B';
export const COMPANY_ICON_IDS = [
  'building-2',
  'briefcase-business',
  'code-2',
  'rocket',
  'landmark',
  'heart-pulse',
  'graduation-cap',
  'palette'
] as const;

export type CompanyIconId = (typeof COMPANY_ICON_IDS)[number];

export interface CompanyDefinition {
  id: string;
  name: string;
  description?: string;
  color: string;
  icon: CompanyIconId;
  archivedAt?: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCompanyInput {
  name: string;
  description?: string;
  color?: string;
  icon?: CompanyIconId;
}

export interface UpdateCompanyInput {
  name?: string;
  description?: string;
  color?: string;
  icon?: CompanyIconId;
}

export interface CompanyContextProjectInput {
  id: string;
  name: string;
  /** Forward-compatible canonical field. */
  companyId?: string;
  companyName?: string;
  /** Legacy ProjectStore isolation field; consumed only as a migration source. */
  organizationId?: string;
  organizationName?: string;
  workspace?: string;
}

export interface CompanyContextConnectionInput {
  id: string;
  label: string;
  auth: 'local' | 'api-key' | 'claude-account' | 'chatgpt-account';
  /** Forward-compatible canonical field. */
  companyId?: string;
  /** Legacy ProviderConnectionRuntime field; consumed only on first binding. */
  organizationId?: string;
  organizationLabel?: string;
}

export interface CompanyContextSessionInput {
  id: string;
  input: {
    projectId?: string;
    /** Forward-compatible immutable session scope, added by a later parity item. */
    companyId?: string;
  };
}

export interface CompanyContextCompany extends CompanyDefinition {
  kind: 'personal' | 'company';
  connectionIds: string[];
  projectIds: string[];
  sessionIds: string[];
}

export interface CompanyContextSnapshot {
  version: 1;
  generatedAt: string;
  companies: CompanyContextCompany[];
  /** Local runtimes are shared execution capabilities, not fake companies. */
  sharedConnectionIds: string[];
}

interface PersistedCompany {
  name: string;
  description?: string;
  color: string;
  icon: CompanyIconId;
  archivedAt?: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

interface CompanyContextFile {
  version: 1;
  companies: Record<string, PersistedCompany>;
  connectionBindings: Record<string, string>;
  updatedAt: string;
}

export interface CompanyContextServiceInput {
  projects: CompanyContextProjectInput[];
  connections: CompanyContextConnectionInput[];
  sessions: CompanyContextSessionInput[];
}

const SAFE_COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMPANY_COLOR = /^#[0-9A-F]{6}$/;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const COMPANY_ICONS = new Set<string>(COMPANY_ICON_IDS);
const MAX_COMPANY_DESCRIPTION = 2_000;

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function cleanCompanyId(value: string | undefined, label: string): string | undefined {
  const clean = value?.trim();
  if (!clean) return undefined;
  if (!SAFE_COMPANY_ID.test(clean) || UNSAFE_OBJECT_KEYS.has(clean)) {
    throw new Error(`${label} contains unsupported characters or a reserved object key.`);
  }
  if (clean === LOCAL_ORGANIZATION_ID) {
    throw new Error(`${label} cannot use reserved local execution scope as a company id.`);
  }
  return clean;
}

function cleanBindingKey(value: string, label: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 512 || /[\0\r\n]/.test(clean) || UNSAFE_OBJECT_KEYS.has(clean)) {
    throw new Error(`${label} is not a safe stable resource id.`);
  }
  return clean;
}

function displayName(value: string | undefined, fallbackId: string): string {
  const clean = value?.trim();
  if (clean) {
    if (/[\0\r\n]/.test(clean)) throw new Error('Company display name contains unsupported control characters.');
    if (clean.length > 160) throw new Error('Company name must be at most 160 characters.');
    return clean;
  }
  return fallbackId
    .split(/[-_.:]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || fallbackId;
}

function description(value: string | undefined): string | undefined {
  const clean = value?.trim();
  if (!clean) return undefined;
  if (clean.length > MAX_COMPANY_DESCRIPTION) {
    throw new Error(`Company description must be at most ${MAX_COMPANY_DESCRIPTION} characters.`);
  }
  if (/[\0]/.test(clean)) throw new Error('Company description contains unsupported control characters.');
  return clean;
}

function companyColor(value: string | undefined): string {
  const clean = (value?.trim() || DEFAULT_COMPANY_COLOR).toUpperCase();
  if (!COMPANY_COLOR.test(clean)) throw new Error('Company color must be a six-digit hex color such as #64748B.');
  return clean;
}

function companyIcon(value: string | undefined): CompanyIconId {
  const clean = value?.trim() || 'building-2';
  if (!COMPANY_ICONS.has(clean)) throw new Error(`Unsupported company icon: ${clean}.`);
  return clean as CompanyIconId;
}

function companyNameKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function freshFile(): CompanyContextFile {
  const now = new Date().toISOString();
  const companies = Object.create(null) as CompanyContextFile['companies'];
  companies[PERSONAL_COMPANY_ID] = {
    name: 'Personal',
    color: DEFAULT_COMPANY_COLOR,
    icon: 'building-2',
    order: 0,
    createdAt: now,
    updatedAt: now
  };
  return {
    version: 1,
    companies,
    connectionBindings: Object.create(null) as Record<string, string>,
    updatedAt: now
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneCompany(id: string, company: PersistedCompany): CompanyDefinition {
  return {
    id,
    name: company.name,
    description: company.description,
    color: company.color,
    icon: company.icon,
    archivedAt: company.archivedAt,
    order: company.order,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt
  };
}

function sortCompanies(left: CompanyDefinition, right: CompanyDefinition): number {
  const leftArchived = Boolean(left.archivedAt);
  const rightArchived = Boolean(right.archivedAt);
  if (leftArchived !== rightArchived) return leftArchived ? 1 : -1;
  return left.order - right.order || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function companyContextPath(): string {
  return process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH?.trim() ||
    path.join(os.homedir(), '.local-coder-mcp', 'company-context.json');
}

/**
 * Owns the stable mapping from product resources to company identity. The store
 * deliberately contains no workspace paths, provider tokens, MCP data, or
 * mutable account labels. Legacy organization metadata is read only long enough
 * to establish a stable binding and is never used again for that connection.
 */
export class CompanyContextStore {
  constructor(private readonly file = companyContextPath()) {}

  listCompanies(options: { includeArchived?: boolean; query?: string } = {}): CompanyDefinition[] {
    const state = this.read();
    const needle = options.query?.trim().toLocaleLowerCase('en-US') ?? '';
    return Object.entries(state.companies)
      .filter(([id]) => id !== PERSONAL_COMPANY_ID)
      .map(([id, company]) => cloneCompany(id, company))
      .filter((company) => options.includeArchived === true || !company.archivedAt)
      .filter((company) => !needle || [company.name, company.description ?? '']
        .some((value) => value.toLocaleLowerCase('en-US').includes(needle)))
      .sort(sortCompanies);
  }

  getCompany(idValue: string): CompanyDefinition {
    const id = cleanCompanyId(idValue, 'Company id');
    if (!id || id === PERSONAL_COMPANY_ID) throw new Error('Company not found.');
    const state = this.read();
    const company = hasOwn(state.companies, id) ? state.companies[id] : undefined;
    if (!company) throw new Error(`Company not found: ${id}`);
    return cloneCompany(id, company);
  }

  createCompany(input: CreateCompanyInput): CompanyDefinition {
    const state = this.read();
    const name = displayName(input.name, 'Company');
    this.assertUniqueName(state, name);
    const now = new Date().toISOString();
    const activeOrders = Object.entries(state.companies)
      .filter(([id, company]) => id !== PERSONAL_COMPANY_ID && !company.archivedAt)
      .map(([, company]) => company.order);
    const company: PersistedCompany = {
      name,
      description: description(input.description),
      color: companyColor(input.color),
      icon: companyIcon(input.icon),
      order: activeOrders.length > 0 ? Math.max(...activeOrders) + 1 : 0,
      createdAt: now,
      updatedAt: now
    };
    let id = randomUUID();
    while (hasOwn(state.companies, id)) id = randomUUID();
    state.companies[id] = company;
    state.updatedAt = now;
    this.write(state);
    return cloneCompany(id, company);
  }

  updateCompany(idValue: string, patch: UpdateCompanyInput): CompanyDefinition {
    const id = cleanCompanyId(idValue, 'Company id');
    if (!id || id === PERSONAL_COMPANY_ID) throw new Error('Personal is a reserved context and cannot be edited as a company.');
    const state = this.read();
    const current = hasOwn(state.companies, id) ? state.companies[id] : undefined;
    if (!current) throw new Error(`Company not found: ${id}`);
    const name = patch.name === undefined ? current.name : displayName(patch.name, id);
    if (name !== current.name) this.assertUniqueName(state, name, id);
    const next: PersistedCompany = {
      ...current,
      name,
      description: patch.description === undefined ? current.description : description(patch.description),
      color: patch.color === undefined ? current.color : companyColor(patch.color),
      icon: patch.icon === undefined ? current.icon : companyIcon(patch.icon),
      updatedAt: new Date().toISOString()
    };
    state.companies[id] = next;
    state.updatedAt = next.updatedAt;
    this.write(state);
    return cloneCompany(id, next);
  }

  setCompanyArchived(idValue: string, archived: boolean): CompanyDefinition {
    const id = cleanCompanyId(idValue, 'Company id');
    if (!id || id === PERSONAL_COMPANY_ID) throw new Error('Personal cannot be archived.');
    const state = this.read();
    const current = hasOwn(state.companies, id) ? state.companies[id] : undefined;
    if (!current) throw new Error(`Company not found: ${id}`);
    if (Boolean(current.archivedAt) === archived) return cloneCompany(id, current);
    const now = new Date().toISOString();
    const activeOrders = Object.entries(state.companies)
      .filter(([candidateId, company]) => candidateId !== PERSONAL_COMPANY_ID && candidateId !== id && !company.archivedAt)
      .map(([, company]) => company.order);
    const next: PersistedCompany = {
      ...current,
      archivedAt: archived ? now : undefined,
      order: archived ? current.order : activeOrders.length > 0 ? Math.max(...activeOrders) + 1 : 0,
      updatedAt: now
    };
    state.companies[id] = next;
    state.updatedAt = now;
    this.write(state);
    return cloneCompany(id, next);
  }

  reorderCompanies(ids: string[]): CompanyDefinition[] {
    const state = this.read();
    const active = Object.entries(state.companies)
      .filter(([id, company]) => id !== PERSONAL_COMPANY_ID && !company.archivedAt)
      .map(([id]) => id);
    const cleanIds = ids.map((id) => cleanCompanyId(id, 'Company id'));
    if (cleanIds.some((id): id is undefined => !id)) throw new Error('Company order contains an empty company id.');
    const normalized = cleanIds as string[];
    if (new Set(normalized).size !== normalized.length) throw new Error('Company order contains duplicate ids.');
    if (normalized.length !== active.length || active.some((id) => !normalized.includes(id))) {
      throw new Error('Company order must contain every active company exactly once.');
    }
    const now = new Date().toISOString();
    normalized.forEach((id, order) => {
      const current = state.companies[id];
      if (current.order !== order) state.companies[id] = { ...current, order, updatedAt: now };
    });
    state.updatedAt = now;
    this.write(state);
    return this.listCompanies();
  }

  reconcile(input: CompanyContextServiceInput): CompanyContextSnapshot {
    const state = this.read();
    let dirty = false;
    const now = new Date().toISOString();

    const ensure = (idValue: string | undefined, nameValue?: string): string => {
      const id = cleanCompanyId(idValue, 'Company id') ?? PERSONAL_COMPANY_ID;
      const existing = hasOwn(state.companies, id) ? state.companies[id] : undefined;
      if (!existing) {
        const activeOrders = Object.entries(state.companies)
          .filter(([candidateId, company]) => candidateId !== PERSONAL_COMPANY_ID && !company.archivedAt)
          .map(([, company]) => company.order);
        state.companies[id] = {
          name: id === PERSONAL_COMPANY_ID ? 'Personal' : displayName(nameValue, id),
          color: DEFAULT_COMPANY_COLOR,
          icon: 'building-2',
          order: id === PERSONAL_COMPANY_ID ? 0 : activeOrders.length > 0 ? Math.max(...activeOrders) + 1 : 0,
          createdAt: now,
          updatedAt: now
        };
        dirty = true;
      }
      return id;
    };

    ensure(PERSONAL_COMPANY_ID, 'Personal');

    const projectCompanies = new Map<string, string>();
    for (const project of input.projects) {
      const explicit = cleanCompanyId(project.companyId, `Project ${project.id} company id`);
      const legacy = cleanCompanyId(project.organizationId, `Project ${project.id} legacy organization id`);
      if (explicit && legacy && explicit !== legacy) {
        throw new Error(`Project ${project.id} has conflicting company and legacy organization identities.`);
      }
      const companyId = ensure(
        explicit ?? legacy ?? PERSONAL_COMPANY_ID,
        project.companyName ?? project.organizationName
      );
      projectCompanies.set(project.id, companyId);
    }

    const connectionCompanies = new Map<string, string>();
    const sharedConnectionIds: string[] = [];
    for (const connection of input.connections) {
      const connectionId = cleanBindingKey(connection.id, 'Connection id');
      // Execution locality is defined by the connection kind, never by a label
      // or a legacy company-looking string. A corporate account called "Local"
      // must not be mistaken for Ollama/local execution.
      if (connection.auth === 'local') {
        sharedConnectionIds.push(connectionId);
        continue;
      }

      const persistedRaw = hasOwn(state.connectionBindings, connectionId)
        ? state.connectionBindings[connectionId]
        : undefined;
      const persisted = cleanCompanyId(
        persistedRaw,
        `Connection ${connectionId} persisted company id`
      );
      const explicit = cleanCompanyId(connection.companyId, `Connection ${connectionId} company id`);
      if (persisted && explicit && persisted !== explicit) {
        throw new Error(`Connection ${connectionId} explicit company conflicts with its persisted company binding.`);
      }
      const legacy = cleanCompanyId(
        connection.organizationId,
        `Connection ${connectionId} legacy organization id`
      );
      const companyId = ensure(
        persisted ?? explicit ?? legacy ?? PERSONAL_COMPANY_ID,
        connection.organizationLabel
      );
      if (persistedRaw !== companyId) {
        state.connectionBindings[connectionId] = companyId;
        dirty = true;
      }
      connectionCompanies.set(connectionId, companyId);
    }

    const sessionCompanies = new Map<string, string>();
    for (const session of input.sessions) {
      const explicit = cleanCompanyId(session.input.companyId, `Session ${session.id} company id`);
      const projectId = session.input.projectId?.trim();
      const projectCompanyId = projectId ? projectCompanies.get(projectId) : undefined;
      if (projectId && !projectCompanyId) {
        throw new Error(`Session ${session.id} references unknown Project ${projectId}.`);
      }
      if (explicit && projectCompanyId && explicit !== projectCompanyId) {
        throw new Error(`Session ${session.id} company does not match Project ${projectId}.`);
      }
      sessionCompanies.set(session.id, ensure(explicit ?? projectCompanyId ?? PERSONAL_COMPANY_ID));
    }

    if (dirty) {
      state.updatedAt = now;
      this.write(state);
    }

    const companies = Object.entries(state.companies).map(([id, company]): CompanyContextCompany => ({
      ...cloneCompany(id, company),
      name: id === PERSONAL_COMPANY_ID ? 'Personal' : company.name,
      kind: id === PERSONAL_COMPANY_ID ? 'personal' : 'company',
      connectionIds: uniqueSorted(
        [...connectionCompanies.entries()].filter(([, companyId]) => companyId === id).map(([connectionId]) => connectionId)
      ),
      projectIds: uniqueSorted(
        [...projectCompanies.entries()].filter(([, companyId]) => companyId === id).map(([projectId]) => projectId)
      ),
      sessionIds: uniqueSorted(
        [...sessionCompanies.entries()].filter(([, companyId]) => companyId === id).map(([sessionId]) => sessionId)
      )
    }));

    companies.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'personal' ? -1 : 1;
      return sortCompanies(left, right);
    });

    return {
      version: 1,
      generatedAt: now,
      companies,
      sharedConnectionIds: uniqueSorted(sharedConnectionIds)
    };
  }

  private assertUniqueName(state: CompanyContextFile, name: string, ignoreId?: string): void {
    const key = companyNameKey(name);
    const conflict = Object.entries(state.companies).find(([id, company]) =>
      id !== PERSONAL_COMPANY_ID && id !== ignoreId && companyNameKey(company.name) === key
    );
    if (conflict) throw new Error(`A company named “${name}” already exists.`);
  }

  private read(): CompanyContextFile {
    if (!fs.existsSync(this.file)) return freshFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Could not read Axis company context: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(parsed)) throw new Error('Axis company context must be a JSON object.');
    if (parsed.version !== 1 || !isRecord(parsed.companies) || !isRecord(parsed.connectionBindings)) {
      throw new Error(`Unsupported Axis company context version: ${String(parsed.version)}`);
    }

    const state = freshFile();
    let fallbackOrder = 0;
    for (const [rawId, raw] of Object.entries(parsed.companies)) {
      if (!isRecord(raw)) throw new Error(`Invalid company context entry: ${rawId}`);
      const id = cleanCompanyId(rawId, 'Stored company id');
      if (!id) throw new Error('Stored company id cannot be empty.');
      const name = typeof raw.name === 'string' && raw.name.trim()
        ? displayName(raw.name, id)
        : displayName(undefined, id);
      const archivedAt = typeof raw.archivedAt === 'string' && raw.archivedAt.trim()
        ? raw.archivedAt
        : undefined;
      state.companies[id] = {
        name: id === PERSONAL_COMPANY_ID ? 'Personal' : name,
        description: typeof raw.description === 'string' ? description(raw.description) : undefined,
        color: typeof raw.color === 'string' ? companyColor(raw.color) : DEFAULT_COMPANY_COLOR,
        icon: typeof raw.icon === 'string' ? companyIcon(raw.icon) : 'building-2',
        archivedAt: id === PERSONAL_COMPANY_ID ? undefined : archivedAt,
        order: id === PERSONAL_COMPANY_ID ? 0 : nonNegativeInteger(raw.order, fallbackOrder++),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString()
      };
    }

    state.connectionBindings = Object.create(null) as Record<string, string>;
    for (const [rawConnectionId, rawCompanyId] of Object.entries(parsed.connectionBindings)) {
      const connectionId = cleanBindingKey(rawConnectionId, 'Stored connection id');
      if (typeof rawCompanyId !== 'string') throw new Error(`Invalid company binding for connection ${connectionId}.`);
      const companyId = cleanCompanyId(rawCompanyId, `Connection ${connectionId} company id`);
      if (!companyId) throw new Error(`Connection ${connectionId} company id cannot be empty.`);
      state.connectionBindings[connectionId] = companyId;
      if (!hasOwn(state.companies, companyId)) {
        state.companies[companyId] = {
          name: displayName(undefined, companyId),
          color: DEFAULT_COMPANY_COLOR,
          icon: 'building-2',
          order: fallbackOrder++,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        };
      }
    }
    state.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString();
    return state;
  }

  private write(state: CompanyContextFile): void {
    const directory = path.dirname(this.file);
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(directory, 0o700); } catch { /* best effort on non-POSIX */ }
      fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort on non-POSIX */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }
}
