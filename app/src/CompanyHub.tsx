import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Building2,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  Network,
  Settings2,
  Sparkles
} from 'lucide-react';

import type { AdminProject, CompanyDefinition } from './app-types.js';
import { ConnectionCenterSettings } from './ConnectionCenterSettings.js';
import type { McpConnectorView, ProviderConnectionView } from './native.js';
import './company-hub.css';

export type CompanyHubSection = 'overview' | 'projects' | 'connections' | 'mcps' | 'skills' | 'settings';

interface CompanyHubProps {
  company: CompanyDefinition;
  projects: AdminProject[];
  section: CompanyHubSection;
  onSectionChange: (section: CompanyHubSection) => void;
  onOpenProject: (project: AdminProject) => void;
  onOpenWorkHub: (companyId: string) => void;
  onCompanyChanged: () => void;
}

interface CompanyConnectionSummary {
  connection: ProviderConnectionView;
  connectors?: McpConnectorView[];
  error?: string;
  loading?: boolean;
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SectionButton({ active, icon, children, onClick }: {
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return <button type="button" className={active ? 'active' : ''} onClick={onClick}>{icon}<span>{children}</span></button>;
}

export function CompanyHub({
  company,
  projects,
  section,
  onSectionChange,
  onOpenProject,
  onOpenWorkHub,
  onCompanyChanged
}: CompanyHubProps) {
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [mcpState, setMcpState] = useState<Record<string, CompanyConnectionSummary>>({});
  const [notice, setNotice] = useState<string>();
  const [name, setName] = useState(company.name);
  const [description, setDescription] = useState(company.description ?? '');
  const [color, setColor] = useState(company.color);
  const [saving, setSaving] = useState(false);

  const scopedProjects = useMemo(() => projects
    .filter((project) => project.companyId === company.id && !project.archived)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [company.id, projects]);

  const scopedConnections = useMemo(() => connections
    .filter((connection) => connection.companyId === company.id && connection.auth !== 'local'), [company.id, connections]);

  useEffect(() => {
    setName(company.name);
    setDescription(company.description ?? '');
    setColor(company.color);
  }, [company]);

  useEffect(() => {
    let cancelled = false;
    void window.lc?.providerConnections().then((next) => {
      if (!cancelled) setConnections(next);
    }).catch((error) => {
      if (!cancelled) setNotice(errorMessage(error));
    });
    return () => { cancelled = true; };
  }, [company.id]);

  async function loadMcps(connection: ProviderConnectionView, refresh = false) {
    if (!connection.accountProfileId || !window.lc) return;
    setMcpState((current) => ({ ...current, [connection.id]: { connection, loading: true } }));
    try {
      const result = connection.auth === 'claude-account'
        ? await window.lc.listClaudeAccountMcps(connection.accountProfileId, refresh)
        : connection.auth === 'chatgpt-account'
          ? await window.lc.listCodexAccountMcps(connection.accountProfileId, refresh)
          : undefined;
      setMcpState((current) => ({
        ...current,
        [connection.id]: { connection, connectors: result?.connectors ?? [] }
      }));
    } catch (error) {
      setMcpState((current) => ({ ...current, [connection.id]: { connection, error: errorMessage(error) } }));
    }
  }

  useEffect(() => {
    if (section !== 'mcps') return;
    for (const connection of scopedConnections) {
      if ((connection.auth === 'claude-account' || connection.auth === 'chatgpt-account') && !mcpState[connection.id]) {
        void loadMcps(connection);
      }
    }
  }, [section, scopedConnections]);

  async function saveCompany(event: FormEvent) {
    event.preventDefault();
    if (company.id === 'personal') return;
    setSaving(true);
    setNotice(undefined);
    try {
      await api(`/api/companies/${encodeURIComponent(company.id)}`, {
        method: 'PATCH',
        body: { name: name.trim(), description: description.trim(), color }
      });
      window.dispatchEvent(new Event('local-coder:companies-changed'));
      onCompanyChanged();
      setNotice('Company settings saved.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const accountConnections = scopedConnections.filter((connection) => connection.auth === 'claude-account' || connection.auth === 'chatgpt-account');
  const apiKeys = scopedConnections.filter((connection) => connection.auth === 'api-key').length;

  return <div className="company-hub" data-company-id={company.id}>
    <aside className="company-hub-rail" aria-label={`${company.name} navigation`}>
      <div className="company-hub-identity">
        <span className="company-hub-mark" style={{ backgroundColor: company.color }}><Building2 size={16} /></span>
        <div><strong>{company.name}</strong><small>{company.id === 'personal' ? 'Personal context' : 'Company context'}</small></div>
      </div>
      <nav>
        <SectionButton active={section === 'overview'} icon={<LayoutDashboard size={15} />} onClick={() => onSectionChange('overview')}>Overview</SectionButton>
        <SectionButton active={section === 'projects'} icon={<FolderKanban size={15} />} onClick={() => onSectionChange('projects')}>Projects</SectionButton>
        <SectionButton active={section === 'connections'} icon={<KeyRound size={15} />} onClick={() => onSectionChange('connections')}>Connections</SectionButton>
        <SectionButton active={section === 'mcps'} icon={<Network size={15} />} onClick={() => onSectionChange('mcps')}>MCPs</SectionButton>
        <SectionButton active={section === 'skills'} icon={<Sparkles size={15} />} onClick={() => onSectionChange('skills')}>Skills</SectionButton>
        <SectionButton active={section === 'settings'} icon={<Settings2 size={15} />} onClick={() => onSectionChange('settings')}>Settings</SectionButton>
      </nav>
    </aside>

    <section className="company-hub-content">
      {notice ? <div className="settings-inline-message" role="status">{notice}</div> : null}

      {section === 'overview' ? <div className="company-hub-page company-overview-page">
        <header><div><span className="company-hub-eyebrow">Company Hub</span><h1>{company.name}</h1><p>{company.description || 'Company-scoped resources, projects and provider identities.'}</p></div><button type="button" className="settings-save-button" onClick={() => onOpenWorkHub(company.id)}>Open in Work Hub</button></header>
        <div className="company-hub-metrics">
          <article><strong>{scopedProjects.length}</strong><span>Projects</span></article>
          <article><strong>{scopedConnections.length}</strong><span>Connections</span></article>
          <article><strong>{accountConnections.length}</strong><span>Account connections</span></article>
          <article><strong>{apiKeys}</strong><span>API Keys</span></article>
        </div>
        <section className="company-hub-card">
          <h2>Ownership boundary</h2>
          <p>Projects, connections, MCP discovery and later Company resources on this surface are scoped by the canonical Company id <code>{company.id}</code>. The Work Hub remains one separate global surface and only aggregates this context with explicit provenance.</p>
        </section>
        <section className="company-hub-card">
          <div className="company-hub-card-heading"><div><h2>Recent projects</h2><p>Only projects owned by this Company.</p></div><button type="button" onClick={() => onSectionChange('projects')}>View all</button></div>
          <div className="company-project-list compact">
            {scopedProjects.slice(0, 5).map((project) => <button type="button" key={project.id} onClick={() => onOpenProject(project)}><FolderKanban size={15} /><span><strong>{project.name}</strong><small>{project.workspace || 'No workspace selected'}</small></span></button>)}
            {scopedProjects.length === 0 ? <p className="company-hub-empty">No projects belong to this context yet.</p> : null}
          </div>
        </section>
      </div> : null}

      {section === 'projects' ? <div className="company-hub-page">
        <header><div><span className="company-hub-eyebrow">{company.name}</span><h1>Projects</h1><p>Projects are filtered by canonical Company ownership, never by workspace path or label.</p></div></header>
        <div className="company-project-grid">
          {scopedProjects.map((project) => <button type="button" className="company-project-card" key={project.id} onClick={() => onOpenProject(project)}>
            <span><FolderKanban size={18} /></span><div><strong>{project.name}</strong><small>{project.workspace || 'No workspace selected'}</small><em>{project.defaultConnectionId || 'No default connection'}</em></div>
          </button>)}
          {scopedProjects.length === 0 ? <p className="company-hub-empty">No active projects in {company.name}.</p> : null}
        </div>
      </div> : null}

      {section === 'connections' ? <div className="company-hub-page company-connections-page">
        <ConnectionCenterSettings companyId={company.id} companyName={company.name} showConnectors={false} />
      </div> : null}

      {section === 'mcps' ? <div className="company-hub-page">
        <header><div><span className="company-hub-eyebrow">{company.name}</span><h1>MCPs</h1><p>Provider-managed MCP discovery is resolved only through account connections owned by this Company.</p></div></header>
        <div className="company-mcp-list">
          {accountConnections.map((connection) => {
            const state = mcpState[connection.id];
            return <article className="company-hub-card" key={connection.id} data-connection-id={connection.id}>
              <div className="company-hub-card-heading"><div><h2>{connection.label}</h2><p>{connection.auth === 'claude-account' ? 'Claude Account' : 'ChatGPT / Codex Account'}</p></div><button type="button" disabled={state?.loading} onClick={() => void loadMcps(connection, true)}>{state?.loading ? 'Refreshing…' : 'Refresh'}</button></div>
              {state?.error ? <p className="company-hub-error">{state.error}</p> : null}
              {state?.connectors?.length ? <div className="company-mcp-connectors">{state.connectors.map((connector) => <div key={connector.name}><span className={`company-mcp-status status-${connector.status}`} /><strong>{connector.name}</strong><small>{connector.status}{connector.managed ? ' · provider-managed' : ''}</small></div>)}</div> : state?.loading ? <p className="company-hub-empty">Discovering MCPs…</p> : <p className="company-hub-empty">No MCPs discovered for this account.</p>}
            </article>;
          })}
          {accountConnections.length === 0 ? <p className="company-hub-empty">Add a Claude or ChatGPT/Codex Account connection to discover provider MCPs for this Company.</p> : null}
        </div>
      </div> : null}

      {section === 'skills' ? <div className="company-hub-page">
        <header><div><span className="company-hub-eyebrow">{company.name}</span><h1>Skills</h1><p>Company-scoped skills will be administered here as the unified agent runtime is implemented.</p></div></header>
        <section className="company-hub-card"><h2>Company skill scope</h2><p>This first-class location reserves the ownership boundary now; it does not invent or inherit skills from another Company. The skill lifecycle remains an open parity item in P2.5.</p></section>
      </div> : null}

      {section === 'settings' ? <div className="company-hub-page">
        <header><div><span className="company-hub-eyebrow">{company.name}</span><h1>Settings</h1><p>Settings on this page belong to this Company. App-wide settings remain in the global Settings dialog.</p></div></header>
        {company.id === 'personal' ? <section className="company-hub-card"><h2>Personal context</h2><p>Personal is a reserved canonical isolation boundary. Its identity cannot be renamed, archived or converted into a Company.</p></section> : <form className="company-settings-form company-hub-card" onSubmit={(event) => void saveCompany(event)}>
          <label><span>Name</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></label>
          <label><span>Color</span><div className="company-color-field"><input type="color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} /><code>{color}</code></div></label>
          <div className="company-settings-actions"><button type="submit" className="settings-save-button" disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Save Company'}</button></div>
        </form>}
      </div> : null}
    </section>
  </div>;
}
