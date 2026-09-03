import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Folder, FolderPlus, MoreHorizontal, Pin, Search, X } from 'lucide-react';

import type { AdminProject } from './app-types.js';
import { FolderField } from './FolderField.js';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-|-$/g, '') || 'personal';
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
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('updated');
  const [sortOpen, setSortOpen] = useState(false);
  const [editing, setEditing] = useState<AdminProject | null>();
  const [workspace, setWorkspace] = useState('');
  const [folderOpen, setFolderOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function load() {
    const { projects: next } = await api<{ projects: AdminProject[] }>('/api/projects');
    setProjects(next);
  }

  useEffect(() => { void load().catch((next) => setError(next instanceof Error ? next.message : String(next))); }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = projects.filter((project) => !needle || project.name.toLowerCase().includes(needle) || (project.description ?? '').toLowerCase().includes(needle));
    return [...filtered].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt));
  }, [projects, query, sort]);

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

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    const companyId = slug(String(form.get('companyId') ?? '').trim() || 'personal');
    const companyName = String(form.get('companyName') ?? '').trim() || (companyId === 'personal' ? 'Personal' : companyId);
    if (!name) return;
    setBusy(true);
    setError(undefined);
    try {
      const isEdit = Boolean(editing);
      const payload = isEdit ? {
        name,
        description,
        workspace: folderOpen ? workspace.trim() : '',
        companyId,
        companyName
      } : {
        name,
        description: description || undefined,
        workspace: folderOpen ? workspace.trim() || undefined : undefined,
        companyId,
        companyName,
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
      if (!isEdit) onOpenProject(project);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  return <section className="lc-shell-projects-page page-shell" aria-label="Projects">
    <header className="lc-shell-projects-header page-header">
      <h1 className="page-title">Projects</h1>
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
      {visible.map((project) => <article className="lc-shell-project-card" key={project.id}>
        <button className="lc-shell-project-card-main" onClick={() => onOpenProject(project)}>
          <span className="lc-shell-project-card-title"><Folder size={16} /><strong>{project.name}</strong><Pin size={12} className="lc-shell-project-pin" /></span>
          {project.description ? <span className="lc-shell-project-card-description">{project.description}</span> : null}
          <span className="lc-shell-project-card-time">{project.companyName ?? project.companyId} · {relative(project.updatedAt)}</span>
        </button>
        <button className="lc-shell-project-more" aria-label={`Edit ${project.name}`} onClick={() => openModal(project)}><MoreHorizontal size={17} /></button>
      </article>)}
      {visible.length === 0 ? <div className="lc-shell-project-empty">No projects found.</div> : null}
    </div>

    {editing !== undefined ? <div className="lc-shell-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeModal(); }}>
      <form className="lc-shell-project-modal" onSubmit={(event) => void saveProject(event)}>
        <div className="lc-shell-modal-title"><h2 className="dialog-title">{editing ? 'Edit project' : 'Create a project'}</h2><button type="button" onClick={closeModal} aria-label="Close"><X size={18} /></button></div>
        <label><span>What are you working on?</span><input name="name" required autoFocus defaultValue={editing?.name} placeholder="Give your project a name" /></label>
        <label><span>What do you want to accomplish?</span><textarea name="description" rows={4} defaultValue={editing?.description} placeholder="Describe your project, goals, topic, etc…" /></label>
        <label><span>Company identifier</span><input name="companyId" required defaultValue={editing?.companyId ?? 'personal'} placeholder="personal or company-id" /><small>This is the Project's company isolation identity. A workspace is only a folder and never changes this Company.</small></label>
        <label><span>Company name</span><input name="companyName" defaultValue={editing?.companyName ?? 'Personal'} placeholder="Personal, LiveNation, Company B…" /></label>
        <button className="lc-shell-use-folder" type="button" onClick={() => setFolderOpen((value) => !value)}><FolderPlus size={15} />{folderOpen ? 'Remove folder' : 'Use a folder'}</button>
        {folderOpen ? <div className="lc-shell-project-folder-field"><FolderField value={workspace} onChange={setWorkspace} name="workspace" /></div> : null}
        {error ? <div className="lc-shell-inline-error lc-shell-modal-error">{error}</div> : null}
        <div className="lc-shell-modal-actions"><button className="btn-secondary" type="button" onClick={closeModal}>Cancel</button><button className="lc-shell-primary-button btn-primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Create project'}</button></div>
      </form>
    </div> : null}
  </section>;
}