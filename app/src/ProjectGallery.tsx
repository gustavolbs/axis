import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Folder, Info, MoreHorizontal, Pin, Search, X } from 'lucide-react';

import type { AdminProject } from './AdminPanel.js';
import { FolderField } from './FolderField.js';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

function relative(value: string): string {
  const ms = Date.now() - new Date(value).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

type SortMode = 'updated' | 'name';

export function ProjectGallery({
  onOpenProject,
  onAdvanced
}: {
  onOpenProject: (project: AdminProject) => void;
  onAdvanced: (project?: AdminProject) => void;
}) {
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('updated');
  const [sortOpen, setSortOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function load() {
    const { projects: next } = await api<{ projects: AdminProject[] }>('/api/projects');
    setProjects(next);
  }

  useEffect(() => {
    void load().catch((next) => setError(next instanceof Error ? next.message : String(next)));
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = projects.filter((project) => !needle || project.name.toLowerCase().includes(needle) || project.workspace.toLowerCase().includes(needle));
    return [...filtered].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt));
  }, [projects, query, sort]);

  function closeCreate() {
    setCreating(false);
    setWorkspace('');
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const folder = workspace.trim();
    if (!name || !folder) return;
    setBusy(true);
    setError(undefined);
    try {
      const organizationId = slug(String(form.get('organizationId') ?? '').trim() || name);
      const { project } = await api<{ project: AdminProject }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name,
          workspace: folder,
          organizationId,
          organizationName: name,
          defaultRoutingPolicy: 'local-first',
          defaultModel: { mode: 'auto' },
          privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] },
          concurrency: 1
        })
      });
      await load();
      window.dispatchEvent(new CustomEvent('local-coder:projects-changed'));
      closeCreate();
      onOpenProject(project);
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
        <label className="lc-shell-project-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" aria-label="Search projects" />
        </label>
        <div className="lc-shell-sort-anchor">
          <button className="lc-shell-sort-button" type="button" onClick={() => setSortOpen((value) => !value)}>Sort by <strong>{sort === 'updated' ? 'Last updated' : 'Name'}</strong><ChevronDown size={13} /></button>
          {sortOpen ? <div className="lc-shell-sort-menu">
            <button className={sort === 'updated' ? 'selected' : ''} onClick={() => { setSort('updated'); setSortOpen(false); }}><span>Last updated</span>{sort === 'updated' ? <Check size={14} /> : null}</button>
            <button className={sort === 'name' ? 'selected' : ''} onClick={() => { setSort('name'); setSortOpen(false); }}><span>Name</span>{sort === 'name' ? <Check size={14} /> : null}</button>
          </div> : null}
        </div>
        <button className="lc-shell-primary-button btn-primary" type="button" onClick={() => setCreating(true)}>New project</button>
      </div>
    </header>

    {error ? <div className="lc-shell-inline-error">{error}</div> : null}

    <div className="lc-shell-project-grid">
      {visible.map((project) => <article className="lc-shell-project-card" key={project.id}>
        <button className="lc-shell-project-card-main" onClick={() => onOpenProject(project)}>
          <span className="lc-shell-project-card-title"><Folder size={15} /><strong>{project.name}</strong><Pin size={12} className="lc-shell-project-pin" /></span>
          <span className="lc-shell-project-card-workspace">{project.workspace}</span>
          <span className="lc-shell-project-card-time">{relative(project.updatedAt)}</span>
        </button>
        <button className="lc-shell-project-more" aria-label={`Configure ${project.name}`} onClick={() => onAdvanced(project)}><MoreHorizontal size={17} /></button>
      </article>)}
      {visible.length === 0 ? <div className="lc-shell-project-empty">No projects found.</div> : null}
    </div>

    {creating ? <div className="lc-shell-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeCreate(); }}>
      <form className="lc-shell-project-modal" onSubmit={(event) => void createProject(event)}>
        <div className="lc-shell-modal-title"><h2 className="dialog-title">Create a project</h2><button type="button" onClick={closeCreate} aria-label="Close"><X size={18} /></button></div>
        <label><span>What are you working on?</span><input name="name" required autoFocus placeholder="Give your project a name" /></label>
        <label><span>Project folder</span><FolderField value={workspace} onChange={setWorkspace} name="workspace" required /></label>
        <label className="lc-shell-modal-optional"><span>Organization <small>optional</small></span><input name="organizationId" placeholder="e.g. acme" /></label>
        <div className="lc-shell-modal-folder-hint"><Info size={14} /><span>The folder is used as the agent's isolated workspace.</span></div>
        <div className="lc-shell-modal-actions"><button className="btn-secondary" type="button" onClick={closeCreate}>Cancel</button><button className="lc-shell-primary-button btn-primary" disabled={busy || !workspace.trim()}>{busy ? 'Creating…' : 'Create project'}</button></div>
      </form>
    </div> : null}
  </section>;
}
