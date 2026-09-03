import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
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
import { CompanySourcesSettings } from './CompanySourcesSettings.js';
import type { McpConnectorView, ProviderConnectionView } from './native.js';

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
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return <button type="button" className={active ? 'active' : ''} onClick={onClick}>{icon}<span>{children}</span></button>;
}

function CompanyPageHeader({ eyebrow, title, description, action }: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return <header className="work-hub-header">
    <div><small>{eyebrow}</small><h2>{title}</h2><p>{description}</p></div>
    {action ? <div className="work-hub-actions">{action}</div> : null}
  </header>;
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

  return <section className="work-hub-shell work-hub-page company-hub" data-company-id={company.id} aria-label={`${company.name} Company Hub`}>
    <aside className="work-hub-rail company-hub-rail" aria-label={`${company.name} navigation`}>
      <div className="work-hub-rail-title"><Building2 size={14} style={{ color: company.color }} /> {company.name}</div>
      <SectionButton active={section === 'overview'} icon={<LayoutDashboard size={15} />} onClick={() => onSectionChange('overview')}>Overview</SectionButton>
      <SectionButton active={section === 'projects'} icon={<FolderKanban size={15} />} onClick={() => onSectionChange('projects')}>Projects</SectionButton>
      <SectionButton active={section === 'connections'} icon={<KeyRound size={15} />} onClick={() => onSectionChange('connections')}>Connections</SectionButton>
      <SectionButton active={section === 'mcps'} icon={<Network size={15} />} onClick={() => onSectionChange('mcps')}>MCPs</SectionButton>
      <SectionButton active={section === 'skills'} icon={<Sparkles size={15} />} onClick={() => onSectionChange('skills')}>Skills</SectionButton>
      <SectionButton active={section === 'settings'} icon={<Settings2 size={15} />} onClick={() => onSectionChange('settings')}>Settings</SectionButton>
      <div className="work-hub-rail-footer"><span />{company.id === 'personal' ? 'Personal context' : 'Company context'}</div>
    </aside>

    <main className="work-hub-main company-hub-content">
      {notice ? <div className="settings-inline-message" role="status">{notice}</div> : null}

      {section === 'overview' ? <>
        <CompanyPageHeader eyebrow="Company Hub" title={company.name} description={company.description || 'Company-scoped resources, projects and provider identities.'} action={<button type="button" className="btn-primary" onClick={() => onOpenWorkHub(company.id)}>Open in Work Hub</button>} />
        <div className="work-hub-summary-grid company-hub-metrics">
          <button type="button" className="work-hub-stat" onClick={() => onSectionChange('projects')}><FolderKanban size={16} /><strong>{scopedProjects.length}</strong><small>Projects</small></button>
          <button type="button" className="work-hub-stat" onClick={() => onSectionChange('connections')}><KeyRound size={16} /><strong>{scopedConnections.length}</strong><small>Connections</small></button>
          <button type="button" className="work-hub-stat" onClick={() => onSectionChange('connections')}><Building2 size={16} /><strong>{accountConnections.length}</strong><small>Account connections</small></button>
          <button type="button" className="work-hub-stat" onClick={() => onSectionChange('connections')}><KeyRound size={16} /><strong>{apiKeys}</strong><small>API Keys</small></button>
        </div>
        <section className="work-hub-section company-hub-card">
          <div className="work-hub-section-heading"><h3>Ownership boundary</h3></div>
          <p>Projects, connections, MCP discovery and later Company resources on this surface are scoped by the canonical Company id <code>{company.id}</code>. The Work Hub remains one separate global surface and only aggregates this context with explicit provenance.</p>
        </section>
        <section className="work-hub-section company-hub-card">
          <div className="work-hub-section-heading"><h3>Recent projects</h3><button type="button" onClick={() => onSectionChange('projects')}>View all</button></div>
          <div className="work-hub-list company-project-list">
            {scopedProjects.slice(0, 5).map((project) => <button type="button" className="work-hub-item" key={project.id} onClick={() => onOpenProject(project)}><FolderKanban size={15} /><span className="work-hub-item-copy"><strong>{project.name}</strong><small>{project.workspace || 'No workspace selected'}</small></span></button>)}
            {scopedProjects.length === 0 ? <div className="work-hub-empty"><FolderKanban size={20} /><strong>No projects yet</strong><span>No projects belong to this context yet.</span></div> : null}
          </div>
        </section>
      </> : null}

      {section === 'projects' ? <>
        <CompanyPageHeader eyebrow={company.name} title="Projects" description="Projects are filtered by canonical Company ownership, never by workspace path or label." />
        <div className="work-hub-list company-project-grid">
          {scopedProjects.map((project) => <button type="button" className="work-hub-item company-project-card" key={project.id} onClick={() => onOpenProject(project)}>
            <FolderKanban size={18} /><span className="work-hub-item-copy"><strong>{project.name}</strong><small>{project.workspace || 'No workspace selected'} · {project.defaultConnectionId || 'No default connection'}</small></span>
          </button>)}
          {scopedProjects.length === 0 ? <div className="work-hub-empty large"><FolderKanban size={24} /><strong>No active projects</strong><span>No active projects belong to {company.name}.</span></div> : null}
        </div>
      </> : null}

      {section === 'connections' ? <div className="company-connections-page">
        <ConnectionCenterSettings companyId={company.id} companyName={company.name} showConnectors={false} />
        <CompanySourcesSettings companyId={company.id} companyName={company.name} />
      </div> : null}

      {section === 'mcps' ? <>
        <CompanyPageHeader eyebrow={company.name} title="MCPs" description="Provider-managed MCP discovery is resolved only through account connections owned by this Company." />
        <div className="company-mcp-list">
          {accountConnections.map((connection) => {
            const state = mcpState[connection.id];
            return <section className="work-hub-section company-hub-card" key={connection.id} data-connection-id={connection.id}>
              <div className="work-hub-section-heading"><h3>{connection.label}</h3><button type="button" disabled={state?.loading} onClick={() => void loadMcps(connection, true)}>{state?.loading ? 'Refreshing…' : 'Refresh'}</button></div>
              <p>{connection.auth === 'claude-account' ? 'Claude Account' : 'ChatGPT / Codex Account'}</p>
              {state?.error ? <div className="work-hub-error"><span>{state.error}</span></div> : null}
              {state?.connectors?.length ? <div className="work-hub-list company-mcp-connectors">{state.connectors.map((connector) => <div className="work-hub-item" key={connector.name}><Network size={14} /><span className="work-hub-item-copy"><strong>{connector.name}</strong><small>{connector.status}{connector.managed ? ' · provider-managed' : ''}</small></span></div>)}</div> : state?.loading ? <div className="work-hub-empty"><strong>Discovering MCPs…</strong></div> : <div className="work-hub-empty"><strong>No MCPs discovered</strong><span>No MCPs were reported for this account.</span></div>}
            </section>;
          })}
          {accountConnections.length === 0 ? <div className="work-hub-empty large"><Network size={24} /><strong>No account MCP sources</strong><span>Add a Claude or ChatGPT/Codex Account connection to discover provider MCPs for this Company.</span></div> : null}
        </div>
      </> : null}

      {section === 'skills' ? <>
        <CompanyPageHeader eyebrow={company.name} title="Skills" description="Company-scoped skills will be administered here as the unified agent runtime is implemented." />
        <section className="work-hub-section company-hub-card"><div className="work-hub-section-heading"><h3>Company skill scope</h3></div><p>This first-class location reserves the ownership boundary now; it does not invent or inherit skills from another Company. The skill lifecycle remains an open parity item in P2.5.</p></section>
      </> : null}

      {section === 'settings' ? <>
        <CompanyPageHeader eyebrow={company.name} title="Settings" description="Settings on this page belong to this Company. App-wide settings remain in the global Settings dialog." />
        {company.id === 'personal' ? <section className="work-hub-section company-hub-card"><div className="work-hub-section-heading"><h3>Personal context</h3></div><p>Personal is a reserved canonical isolation boundary. Its identity cannot be renamed, archived or converted into a Company.</p></section> : <form className="nested-settings-dialog company-settings-form" onSubmit={(event) => void saveCompany(event)}>
          <label><span>Name</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>Description</span><input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label><span>Color</span><input type="color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} /></label>
          <div className="nested-settings-dialog-actions"><button type="submit" className="settings-save-button" disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Save Company'}</button></div>
        </form>}
      </> : null}
    </main>
  </section>;
}
