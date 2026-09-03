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

export interface CompanyContextCompany {
  id: string;
  name: string;
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

interface CompanyContextFile {
  version: 1;
  companies: Record<string, { name: string; createdAt: string; updatedAt: string }>;
  connectionBindings: Record<string, string>;
  updatedAt: string;
}

export interface CompanyContextServiceInput {
  projects: CompanyContextProjectInput[];
  connections: CompanyContextConnectionInput[];
  sessions: CompanyContextSessionInput[];
}

const SAFE_COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

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
    return clean.slice(0, 160);
  }
  return fallbackId
    .split(/[-_.:]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || fallbackId;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function freshFile(): CompanyContextFile {
  const now = new Date().toISOString();
  const companies = Object.create(null) as CompanyContextFile['companies'];
  companies[PERSONAL_COMPANY_ID] = { name: 'Personal', createdAt: now, updatedAt: now };
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

  reconcile(input: CompanyContextServiceInput): CompanyContextSnapshot {
    const state = this.read();
    let dirty = false;
    const now = new Date().toISOString();

    const ensure = (idValue: string | undefined, nameValue?: string): string => {
      const id = cleanCompanyId(idValue, 'Company id') ?? PERSONAL_COMPANY_ID;
      const existing = hasOwn(state.companies, id) ? state.companies[id] : undefined;
      if (!existing) {
        state.companies[id] = {
          name: id === PERSONAL_COMPANY_ID ? 'Personal' : displayName(nameValue, id),
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
      id,
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
    })).filter((company) =>
      company.kind === 'personal' ||
      company.connectionIds.length > 0 ||
      company.projectIds.length > 0 ||
      company.sessionIds.length > 0
    );

    companies.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'personal' ? -1 : 1;
      return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });

    return {
      version: 1,
      generatedAt: now,
      companies,
      sharedConnectionIds: uniqueSorted(sharedConnectionIds)
    };
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
    for (const [rawId, raw] of Object.entries(parsed.companies)) {
      if (!isRecord(raw)) throw new Error(`Invalid company context entry: ${rawId}`);
      const id = cleanCompanyId(rawId, 'Stored company id');
      if (!id) throw new Error('Stored company id cannot be empty.');
      const name = typeof raw.name === 'string' && raw.name.trim()
        ? displayName(raw.name, id)
        : displayName(undefined, id);
      state.companies[id] = {
        name: id === PERSONAL_COMPANY_ID ? 'Personal' : name,
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
