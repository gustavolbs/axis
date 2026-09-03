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

function cleanCompanyId(value: string | undefined, label: string): string | undefined {
  const clean = value?.trim();
  if (!clean) return undefined;
  if (!SAFE_COMPANY_ID.test(clean)) throw new Error(`${label} contains unsupported characters.`);
  if (clean === LOCAL_ORGANIZATION_ID) {
    throw new Error(`${label} cannot use reserved local execution scope as a company id.`);
  }
  return clean;
}

function displayName(value: string | undefined, fallbackId: string): string {
  const clean = value?.trim();
  if (clean) return clean.slice(0, 160);
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
  return {
    version: 1,
    companies: {
      [PERSONAL_COMPANY_ID]: { name: 'Personal', createdAt: now, updatedAt: now }
    },
    connectionBindings: {},
    updatedAt: now
  };
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

  snapshotState(): CompanyContextFile {
    const state = this.read();
    return structuredClone(state);
  }

  reconcile(input: CompanyContextServiceInput): CompanyContextSnapshot {
    const state = this.read();
    let dirty = false;
    const now = new Date().toISOString();

    const ensure = (idValue: string | undefined, nameValue?: string): string => {
      const id = cleanCompanyId(idValue, 'Company id') ?? PERSONAL_COMPANY_ID;
      const existing = state.companies[id];
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
      if (connection.auth === 'local' || connection.organizationId === LOCAL_ORGANIZATION_ID) {
        sharedConnectionIds.push(connection.id);
        continue;
      }

      const persisted = cleanCompanyId(
        state.connectionBindings[connection.id],
        `Connection ${connection.id} persisted company id`
      );
      const explicit = cleanCompanyId(connection.companyId, `Connection ${connection.id} company id`);
      const legacy = cleanCompanyId(
        connection.organizationId,
        `Connection ${connection.id} legacy organization id`
      );
      const companyId = ensure(
        persisted ?? explicit ?? legacy ?? PERSONAL_COMPANY_ID,
        connection.organizationLabel
      );
      if (state.connectionBindings[connection.id] !== companyId) {
        state.connectionBindings[connection.id] = companyId;
        dirty = true;
      }
      connectionCompanies.set(connection.id, companyId);
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Axis company context must be a JSON object.');
    }
    const value = parsed as Partial<CompanyContextFile>;
    if (value.version !== 1 || !value.companies || !value.connectionBindings) {
      throw new Error(`Unsupported Axis company context version: ${String(value.version)}`);
    }
    const state = freshFile();
    for (const [rawId, raw] of Object.entries(value.companies)) {
      if (!raw || typeof raw !== 'object') throw new Error(`Invalid company context entry: ${rawId}`);
      const id = cleanCompanyId(rawId, 'Stored company id');
      if (!id) throw new Error('Stored company id cannot be empty.');
      const item = raw as { name?: unknown; createdAt?: unknown; updatedAt?: unknown };
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 160) : displayName(undefined, id);
      state.companies[id] = {
        name: id === PERSONAL_COMPANY_ID ? 'Personal' : name,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString()
      };
    }
    state.connectionBindings = {};
    for (const [connectionId, rawCompanyId] of Object.entries(value.connectionBindings)) {
      if (!connectionId.trim() || typeof rawCompanyId !== 'string') throw new Error('Invalid company connection binding.');
      const companyId = cleanCompanyId(rawCompanyId, `Connection ${connectionId} company id`);
      if (!companyId) throw new Error(`Connection ${connectionId} company id cannot be empty.`);
      state.connectionBindings[connectionId] = companyId;
      if (!state.companies[companyId]) {
        state.companies[companyId] = {
          name: displayName(undefined, companyId),
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        };
      }
    }
    state.updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString();
    return state;
  }

  private write(state: CompanyContextFile): void {
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
