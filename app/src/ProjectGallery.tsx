import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Folder, FolderPlus, MoreHorizontal, Pin, Search, X } from 'lucide-react';

import type { AdminProject, CompanyDefinition } from './app-types.js';
import { FolderField } from './FolderField.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
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
  const [companies, setCompanies] = useState<CompanyDefinition[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('updated');
  const [sortOpen, setSortOpen] = useState(false);
  const [editing, setEditing] = useState<AdminProject | null>();
  const [companyId, setCompanyId] = useState('personal');
  const [workspace, setWorkspace] = useState('');
  const [folderOpen, setFolderOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function load() {
    // Reconcile the legacy project/account metadata first so the company picker
    // always refers to canonical company identities instead of inventing slugs.
    await api('/api/companies/context');
    const [{ projects: nextProjects }, { companies: nextCompanies }] = await Promise.all([
      api<{ projects: AdminProject[] }>('/api/projects'),
      api<{ companies: CompanyDefinition[] }>('/api/companies?archived=all')
    ]);
    setProjects(nextProjects.map(canonicalProject));
    setCompanies(nextCompanies);
  }

  useEffect(() => { void load().catch((next) => setError(next instanceof Error ? next.message : String(next))); }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = projects.filter((project) => !needle || project.name.toLowerCase().includes(needle) || (project.description ?? '').toLowerCase().includes(needle));
    return [...filtered].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt));
  }, [projects, query, sort]);

  const companyOptions = useMemo<UiSelectOption[]>(() => {
    const currentCompanyId = editing?.companyId;
    return [
      { value: 'personal', label: 'Personal', description: 'Personal context on this device' },
      ...companies
        .filter((company) => !company.archivedAt || company.id === currentCompanyId)
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
        .map((company) => ({
          value: company.id,
          label: company.name,
          description: company.archivedAt ? 'Archived company' : company.description
        }))
    ];
  }, [companies, editing?.companyId]);

  function openModal(project: AdminProject | null) {
    setEditing(project);
    setCompanyId(project?.companyId ?? 'personal');
    setWorkspace(project?.workspace ?? '');
    setFolderOpen(Boolean(project?.workspace));
    setError(undefined);
  }

  function closeModal() {
    setEditing(undefined);
    setCompanyId('personal');
    setWorkspace('');
    setFolderOpen(false);
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    const selectedCompany = companies.find((company) => company.id === companyId);
    const companyName = companyId === 'personal' ? 'Personal' : selectedCompany?.name;
    if (!name) return;
    if (!companyName) {
      setError('Choose an existing active company for this Project.');
      return;
    }
    if (selectedCompany?.archivedAt && companyId !== editing?.companyId) {
      setError('Archived companies cannot receive new Projects. Restore the company first.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const isEdit = Boolean(editing);
      // companyId/companyName are the product contract. organization* remains a
      // write-through compatibility alias until ProjectStore's legacy file
      // schema is migrated by a later storage-focused change.
      const companyFields = {
        companyId,
        companyName,
        organizationId: companyId,
        organizationName: companyName
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
        <label><span>Company</span><UiSelect ariaLabel="Project company" value={companyId} options={companyOptions} onChange={setCompanyId} /><small>A Project belongs to one stable Company identity. Its folder never changes that ownership.</small></label>
        <button className="lc-shell-use-folder" type="button" onClick={() => setFolderOpen((value) => !value)}><FolderPlus size={15} />{folderOpen ? 'Remove folder' : 'Use a folder'}</button>
        {folderOpen ? <div className="lc-shell-project-folder-field"><FolderField value={workspace} onChange={setWorkspace} name="workspace" /></div> : null}
        {error ? <div className="lc-shell-inline-error lc-shell-modal-error">{error}</div> : null}
        <div className="lc-shell-modal-actions"><button className="btn-secondary" type="button" onClick={closeModal}>Cancel</button><button className="lc-shell-primary-button btn-primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Create project'}</button></div>
      </form>
    </div> : null}
  </section>;
}
