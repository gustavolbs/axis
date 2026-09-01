import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Folder, MoreHorizontal, Pin, Plus, Search, X } from 'lucide-react';

import type { AdminProject } from './AdminPanel.js';

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
  if (hours < 1) return 'agora';
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'ontem';
  return `há ${days} dias`;
}

export function ProjectGallery({
  onOpenProject,
  onAdvanced
}: {
  onOpenProject: (project: AdminProject) => void;
  onAdvanced: (project?: AdminProject) => void;
}) {
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
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
    return [...projects]
      .filter((project) => !needle || project.name.toLowerCase().includes(needle) || project.workspace.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [projects, query]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const workspace = String(form.get('workspace') ?? '').trim();
    if (!name || !workspace) return;
    setBusy(true);
    setError(undefined);
    try {
      const organizationId = slug(String(form.get('organizationId') ?? '').trim() || name);
      const { project } = await api<{ project: AdminProject }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name,
          workspace,
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
      setCreating(false);
      onOpenProject(project);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  return <section className="reference-projects-page" aria-label="Projects">
    <header className="reference-projects-header">
      <h1>Projetos</h1>
      <div className="reference-project-actions">
        <label className="reference-project-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Procurar" aria-label="Procurar projetos" />
        </label>
        <button className="reference-sort-button" type="button">Ordenar por <strong>Última atualização</strong></button>
        <button className="reference-primary-button" type="button" onClick={() => setCreating(true)}>Novo projeto</button>
      </div>
    </header>

    {error ? <div className="reference-inline-error">{error}</div> : null}

    <div className="reference-project-grid">
      {visible.map((project) => <article className="reference-project-card" key={project.id}>
        <button className="reference-project-card-main" onClick={() => onOpenProject(project)}>
          <span className="reference-project-card-title"><Folder size={15} /><strong>{project.name}</strong><Pin size={12} className="reference-project-pin" /></span>
          <span className="reference-project-card-workspace">{project.workspace}</span>
          <span className="reference-project-card-time">{relative(project.updatedAt)}</span>
        </button>
        <button className="reference-project-more" aria-label={`Configurar ${project.name}`} onClick={() => onAdvanced(project)}><MoreHorizontal size={17} /></button>
      </article>)}
      {visible.length === 0 ? <div className="reference-project-empty">Nenhum projeto encontrado.</div> : null}
    </div>

    {creating ? <div className="reference-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setCreating(false); }}>
      <form className="reference-project-modal" onSubmit={(event) => void createProject(event)}>
        <div className="reference-modal-title"><h2>Criar um projeto</h2><button type="button" onClick={() => setCreating(false)} aria-label="Fechar"><X size={18} /></button></div>
        <label><span>No que você está trabalhando?</span><input name="name" required autoFocus placeholder="Dê um nome ao projeto" /></label>
        <label><span>Pasta do projeto</span><input name="workspace" required placeholder="/Users/voce/codigo/projeto" /></label>
        <label className="reference-modal-optional"><span>Organização <small>opcional</small></span><input name="organizationId" placeholder="Ex.: acme" /></label>
        <div className="reference-modal-folder-hint"><Plus size={16} /><span>A pasta é usada como workspace isolado do agente.</span></div>
        <div className="reference-modal-actions"><button type="button" onClick={() => setCreating(false)}>Cancelar</button><button className="reference-primary-button" disabled={busy}>{busy ? 'Criando…' : 'Criar projeto'}</button></div>
      </form>
    </div> : null}
  </section>;
}
