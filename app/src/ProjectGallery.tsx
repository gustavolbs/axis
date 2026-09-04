import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Folder, FolderPlus, MoreHorizontal, Pin, PinOff, Search, X } from 'lucide-react';

import type { AdminProject } from './app-types.js';
import { FolderField } from './FolderField.js';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

interface ActiveCompanyScope {
  activeCompanyId: string;
  company: { id: string; name: string };
}

const PINNED_PROJECTS_KEY = 'local-coder.pinned-projects';
const CREATE_PROJECT_KEY = 'local-coder.create-project';

function storedIds(key: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function canonicalProject(project: AdminProject): AdminProject {
  const companyId = project.companyId || project.organizationId || 'personal';
  return {
    ...project,
    companyId,
    companyName: project.companyName ?? project.organizationName ?? (companyId === 'personal' ? 'Personal' : companyId)
  };
}

function relative(value: string): string {
  const hours = Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000);
  if (hours < 1) return 'now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

type SortMode = 'updated' | 'name';

export function ProjectGallery({ onOpenProject }: { onOpenProject: (project: AdminProject) => void }) {
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [activeCompany, setActiveCompany] = useState<ActiveCompanyScope>();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('updated');
  const [sortOpen, setSortOpen] = useState(false);
  const [editing, setEditing] = useState<AdminProject | null>();
  const [workspace, setWorkspace] = useState('');
  const [folderOpen, setFolderOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pinnedProjects, setPinnedProjects] = useState<Set<string>>(() => storedIds(PINNED_PROJECTS_KEY));

  async function load() {
    // Reconcile legacy ownership first. The scoped desktop runtime then returns
    // only Projects from the active Company, so the create form cannot drift to
    // a different context than the one visible in the sidebar.
    await api('/api/companies/context');
    const [{ projects: nextProjects }, { scope }] = await Promise.all([
      api<{ projects: AdminProject[] }>('/api/projects'),
      api<{ scope: ActiveCompanyScope }>('/api/companies/active')
    ]);
    setProjects(nextProjects.map(canonicalProject));
    setActiveCompany(scope);
  }

  useEffect(() => {
    void load()
      .then(() => {
        if (localStorage.getItem(CREATE_PROJECT_KEY) === 'true') {
          localStorage.removeItem(CREATE_PROJECT_KEY);
          openModal(null);
        }
      })
      .catch((next) => setError(next instanceof Error ? next.message : String(next)));
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = projects.filter((project) => !needle || project.name.toLowerCase().includes(needle) || (project.description ?? '').toLowerCase().includes(needle));
    return [...filtered].sort((a, b) => {
      const pinDelta = Number(pinnedProjects.has(b.id)) - Number(pinnedProjects.has(a.id));
      if (pinDelta !== 0) return pinDelta;
      return sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [projects, query, sort, pinnedProjects]);

  function openModal(project: AdminProject | null) {
    setEditing(project);
    setWorkspace(project?.workspace ?? '');
    setFolderOpen(Boolean(project?.workspace));
    setError(undefined);
  }

  function closeModal() {
    setEditing(undefined);
    setWorkspace('');
    setFolderOpen(false);
  }

  function togglePin(projectId: string) {
    setPinnedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify([...next]));
      window.dispatchEvent(new CustomEvent('local-coder:pins-changed'));
      return next;
    });
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    if (!name) return;
    if (!activeCompany) {
      setError('Could not resolve the active context. Reopen Projects and try again.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const isEdit = Boolean(editing);
      const companyFields = {
        companyId: activeCompany.activeCompanyId,
        companyName: activeCompany.company.name,
        organizationId: activeCompany.activeCompanyId,
        organizationName: activeCompany.company.name
      };
      const payload = isEdit ? {
        name,
        description,
        workspace: folderOpen ? workspace.trim() : '',
        ...companyFields
      } : {
        name,
        description: description || undefined,
        workspace: folderOpen ? workspace.trim() || undefined : undefined,
        ...companyFields,
        defaultRoutingPolicy: 'local-first',
        defaultModel: { mode: 'auto' },
        privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] },
        connectionPolicy: {
          chat: { defaultConnectionId: 'ollama', allowedConnectionIds: ['ollama'] },
          inference: { allowedConnectionIds: ['ollama'], preferredConnectionId: 'ollama' },
          workSourceIds: []
        },
        concurrency: 1
      };
      const { project } = await api<{ project: AdminProject }>(isEdit ? `/api/projects/${encodeURIComponent(editing!.id)}` : '/api/projects', {
        method: isEdit ? 'PATCH' : 'POST', body: JSON.stringify(payload)
      });
      await load();
      window.dispatchEvent(new CustomEvent('local-coder:projects-changed'));
      closeModal();
      if (!isEdit) onOpenProject(canonicalProject(project));
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  return <section className="lc-shell-projects-page page-shell" aria-label="Projects">
    <header className="lc-shell-projects-header page-header">
      <div>
        <h1 className="page-title">Projects</h1>
        {activeCompany ? <p className="page-subtitle">{activeCompany.company.name}</p> : null}
      </div>
      <div className="lc-shell-project-actions">
        <label className="lc-shell-project-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" aria-label="Search projects" /></label>
        <div className="lc-shell-sort-anchor">
          <button className="lc-shell-sort-button" type="button" onClick={() => setSortOpen((value) => !value)}>Sort by <strong>{sort === 'updated' ? 'Last updated' : 'Name'}</strong><ChevronDown size={14} /></button>
          {sortOpen ? <div className="lc-shell-sort-menu">
            <button className={sort === 'updated' ? 'selected' : ''} onClick={() => { setSort('updated'); setSortOpen(false); }}><span>Last updated</span>{sort === 'updated' ? <Check size={14} /> : null}</button>
            <button className={sort === 'name' ? 'selected' : ''} onClick={() => { setSort('name'); setSortOpen(false); }}><span>Name</span>{sort === 'name' ? <Check size={14} /> : null}</button>
          </div> : null}
        </div>
        <button className="lc-shell-primary-button btn-primary" type="button" onClick={() => openModal(null)}>New project</button>
      </div>
    </header>

    {error && editing === undefined ? <div className="lc-shell-inline-error">{error}</div> : null}
    <div className="lc-shell-project-grid">
      {visible.map((project) => {
        const pinned = pinnedProjects.has(project.id);
        return <article className="lc-shell-project-card" key={project.id} data-pinned={pinned ? 'true' : 'false'}>
          <button className="lc-shell-project-card-main" onClick={() => onOpenProject(project)}>
            <span className="lc-shell-project-card-title"><Folder size={16} /><strong>{project.name}</strong></span>
            {project.description ? <span className="lc-shell-project-card-description">{project.description}</span> : null}
            <span className="lc-shell-project-card-time">{project.companyName ?? project.companyId} · {relative(project.updatedAt)}</span>
          </button>
          <button className="lc-shell-project-pin" type="button" aria-label={`${pinned ? 'Unpin' : 'Pin'} ${project.name}`} aria-pressed={pinned} title={pinned ? 'Unpin project' : 'Pin project'} onClick={() => togglePin(project.id)}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
          <button className="lc-shell-project-more" aria-label={`Edit ${project.name}`} onClick={() => openModal(project)}><MoreHorizontal size={17} /></button>
        </article>;
      })}
      {visible.length === 0 ? <div className="lc-shell-project-empty">No projects found.</div> : null}
    </div>

    {editing !== undefined ? <div className="lc-shell-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeModal(); }}>
      <form className="lc-shell-project-modal" onSubmit={(event) => void saveProject(event)}>
        <div className="lc-shell-modal-title"><h2 className="dialog-title">{editing ? 'Edit project' : 'Create a project'}</h2><button type="button" onClick={closeModal} aria-label="Close"><X size={18} /></button></div>
        {activeCompany ? <div className="lc-shell-project-context-label"><span>Context</span><strong>{activeCompany.company.name}</strong></div> : null}
        <label><span>What are you working on?</span><input name="name" required autoFocus defaultValue={editing?.name} placeholder="Give your project a name" /></label>
        <label><span>What do you want to accomplish?</span><textarea name="description" rows={4} defaultValue={editing?.description} placeholder="Describe your project, goals, topic, etc…" /></label>
        <button className="lc-shell-use-folder" type="button" onClick={() => setFolderOpen((value) => !value)}><FolderPlus size={15} />{folderOpen ? 'Remove folder' : 'Use a folder'}</button>
        {folderOpen ? <div className="lc-shell-project-folder-field"><FolderField value={workspace} onChange={setWorkspace} name="workspace" /></div> : null}
        {error ? <div className="lc-shell-inline-error lc-shell-modal-error">{error}</div> : null}
        <div className="lc-shell-modal-actions"><button className="btn-secondary" type="button" onClick={closeModal}>Cancel</button><button className="lc-shell-primary-button btn-primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Create project'}</button></div>
      </form>
    </div> : null}
  </section>;
}
