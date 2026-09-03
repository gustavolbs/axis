import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Building2,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  Network,
  Settings2,
  Sparkles,
  UserRound
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

function CompanyPageHeader({ title, description, action }: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return <header className="work-hub-header">
    <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
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
  const isPersonal = company.id === 'personal';

  const scopedProjects = useMemo(() => projects
    .filter((project) => project.companyId === company.id && !project.archived)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [company.id, projects]);

  const ownedConnections = useMemo(() => connections
    .filter((connection) => connection.companyId === company.id && connection.auth !== 'local'), [company.id, connections]);
  const localConnections = useMemo(() => isPersonal
    ? connections.filter((connection) => connection.auth === 'local')
    : [], [connections, isPersonal]);
  const visibleConnections = useMemo(() => [...ownedConnections, ...localConnections], [ownedConnections, localConnections]);

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
    for (const connection of ownedConnections) {
      if ((connection.auth === 'claude-account' || connection.auth === 'chatgpt-account') && !mcpState[connection.id]) {
        void loadMcps(connection);
      }
    }
  }, [section, ownedConnections]);

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

  const accountConnections = ownedConnections.filter((connection) => connection.auth === 'claude-account' || connection.auth === 'chatgpt-account');
  const ContextIcon = isPersonal ? UserRound : Building2;

  return <section className="work-hub-shell work-hub-page company-hub" data-company-id={company.id} aria-label={`${company.name} Company Hub`}>
    <aside className="work-hub-rail company-hub-rail" aria-label={`${company.name} navigation`}>
      <div className="work-hub-rail-title"><ContextIcon size={14} style={{ color: company.color }} /> {company.name}</div>
      <SectionButton active={section === 'overview'} icon={<LayoutDashboard size={15} />} onClick={() => onSectionChange('overview')}>Overview</SectionButton>
      <SectionButton active={section === 'projects'} icon={<FolderKanban size={15} />} onClick={() => onSectionChange('projects')}>Projects</SectionButton>
      <SectionButton active={section === 'connections'} icon={<KeyRound size={15} />} onClick={() => onSectionChange('connections')}>Connections</SectionButton>
      <SectionButton active={section === 'mcps'} icon={<Network size={15} />} onClick={() => onSectionChange('mcps')}>MCPs</SectionButton>
      <SectionButton active={section === 'skills'} icon={<Sparkles size={15} />} onClick={() => onSectionChange('skills')}>Skills</SectionButton>
      <SectionButton active={section === 'settings'} icon={<Settings2 size={15} />} onClick={() => onSectionChange('settings')}>Settings</SectionButton>
      <div className="work-hub-rail-footer"><span />{isPersonal ? 'Personal context' : 'Company context'}</div>
    </aside>

    <main className="work-hub-main company-hub-content">
      {notice ? <div className="settings-inline-message" role="status">{notice}</div> : null}

      {section === 'overview' ? <>
        <CompanyPageHeader
          title={company.name}
          description={company.description || (isPersonal ? 'Your personal projects, connections and tools.' : 'Projects, connections and tools for this company.')}
          action={<button type="button" className="btn-primary" onClick={() => onOpenWorkHub(company.id)}>Open in Work Hub</button>}
        />

        <section className="company-overview-section">
          <div className="work-hub-section-heading">
            <h3>Recent projects</h3>
            {scopedProjects.length > 0 ? <button type="button" onClick={() => onSectionChange('projects')}>View all</button> : null}
          </div>
          <div className="work-hub-list company-project-list">
            {scopedProjects.slice(0, 5).map((project) => <button type="button" className="work-hub-item" key={project.id} onClick={() => onOpenProject(project)}>
              <FolderKanban size={15} />
              <span className="work-hub-item-copy"><strong>{project.name}</strong><small>{project.workspace || 'Workspace not selected'}</small></span>
            </button>)}
            {scopedProjects.length === 0 ? <div className="work-hub-empty company-compact-empty"><FolderKanban size={19} /><strong>No projects yet</strong><span>Projects added to this context will appear here.</span></div> : null}
          </div>
        </section>

        <nav className="company-overview-shortcuts" aria-label={`${company.name} shortcuts`}>
          <button type="button" onClick={() => onSectionChange('connections')}>
            <span className="company-overview-shortcut-icon"><KeyRound size={16} /></span>
            <span><strong>Connections</strong><small>{visibleConnections.length === 0 ? 'No connections yet' : `${visibleConnections.length} configured`}</small></span>
          </button>
          <button type="button" onClick={() => onSectionChange('mcps')}>
            <span className="company-overview-shortcut-icon"><Network size={16} /></span>
            <span><strong>MCPs</strong><small>{accountConnections.length === 0 ? 'No connected accounts' : `${accountConnections.length} account${accountConnections.length === 1 ? '' : 's'} available`}</small></span>
          </button>
        </nav>
      </> : null}

      {section === 'projects' ? <>
        <CompanyPageHeader title="Projects" description="Open a project to continue working in this context." />
        <div className="work-hub-list company-project-grid">
          {scopedProjects.map((project) => <button type="button" className="work-hub-item company-project-card" key={project.id} onClick={() => onOpenProject(project)}>
            <FolderKanban size={17} />
            <span className="work-hub-item-copy"><strong>{project.name}</strong><small>{project.workspace || 'Workspace not selected'}</small></span>
          </button>)}
          {scopedProjects.length === 0 ? <div className="work-hub-empty large"><FolderKanban size={24} /><strong>No projects yet</strong><span>Projects added to {company.name} will appear here.</span></div> : null}
        </div>
      </> : null}

      {section === 'connections' ? <>
        <CompanyPageHeader title="Connections" description={isPersonal ? 'Accounts, API keys and shared local runtimes.' : `Accounts, API keys and Work Hub sources for ${company.name}.`} />
        <div className="company-connections-page">
          <ConnectionCenterSettings companyId={company.id} companyName={company.name} showConnectors={false} embedded />
          <CompanySourcesSettings companyId={company.id} companyName={company.name} />
        </div>
      </> : null}

      {section === 'mcps' ? <>
        <CompanyPageHeader title="MCPs" description="Tools available through connected accounts." />
        <div className="company-mcp-list">
          {accountConnections.map((connection) => {
            const state = mcpState[connection.id];
            const accountType = connection.auth === 'claude-account' ? 'Claude' : 'ChatGPT / Codex';
            return <section className="company-mcp-account" key={connection.id} data-connection-id={connection.id}>
              <header className="company-mcp-account-header">
                <div><strong>{connection.label}</strong><small>{accountType}</small></div>
                <button type="button" disabled={state?.loading} onClick={() => void loadMcps(connection, true)}>{state?.loading ? 'Refreshing…' : 'Refresh'}</button>
              </header>
              {state?.error ? <div className="work-hub-error"><span>{state.error}</span></div> : null}
              {state?.connectors?.length ? <div className="work-hub-list company-mcp-connectors">{state.connectors.map((connector) => <div className="work-hub-item" key={connector.name}>
                <Network size={14} />
                <span className="work-hub-item-copy"><strong>{connector.name}</strong><small>{connector.status}</small></span>
              </div>)}</div> : state?.loading ? <div className="company-mcp-empty">Looking for MCPs…</div> : <div className="company-mcp-empty">No MCPs found</div>}
            </section>;
          })}
          {accountConnections.length === 0 ? <div className="work-hub-empty large company-action-empty">
            <Network size={24} />
            <strong>Connect an account to use MCPs</strong>
            <span>Claude and ChatGPT/Codex accounts can expose tools here.</span>
            <button type="button" className="btn-secondary" onClick={() => onSectionChange('connections')}>Open Connections</button>
          </div> : null}
        </div>
      </> : null}

      {section === 'skills' ? <>
        <CompanyPageHeader title="Skills" description="Reusable instructions and workflows for this context." />
        <div className="work-hub-empty large company-skills-empty">
          <Sparkles size={24} />
          <strong>Skills are coming soon</strong>
          <span>Skills added to {company.name} will appear here.</span>
        </div>
      </> : null}

      {section === 'settings' ? <>
        <CompanyPageHeader title="Settings" description={isPersonal ? 'Personal is a fixed context in Axis.' : 'Update how this context appears in Axis.'} />
        {isPersonal ? <section className="company-personal-settings">
          <span className="company-personal-settings-icon"><UserRound size={18} /></span>
          <div><strong>Personal</strong><p>This context cannot be renamed or converted into a company.</p></div>
        </section> : <form className="company-settings-form" onSubmit={(event) => void saveCompany(event)}>
          <section className="settings-form-section">
            <div className="settings-section-copy"><strong>Name</strong></div>
            <input required aria-label="Company name" value={name} onChange={(event) => setName(event.target.value)} />
          </section>
          <section className="settings-form-section">
            <div className="settings-section-copy"><strong>Description</strong></div>
            <input aria-label="Company description" value={description} onChange={(event) => setDescription(event.target.value)} />
          </section>
          <section className="settings-form-section">
            <div className="settings-section-copy"><strong>Accent color</strong></div>
            <input aria-label="Company color" type="color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} />
          </section>
          <div className="work-hub-actions company-settings-actions"><button type="submit" className="btn-primary" disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Save changes'}</button></div>
        </form>}
      </> : null}
    </main>
  </section>;
}