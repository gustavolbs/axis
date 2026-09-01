import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  ChevronRight,
  Folder,
  History,
  Plus,
  Settings,
  SlidersHorizontal
} from 'lucide-react';

import { AdminPanel, type AdminProject } from './AdminPanel.js';
import { App } from './App.js';
import { ProjectGallery } from './ProjectGallery.js';
import { RunInspector } from './RunInspector.js';

type Surface = 'agent' | 'projects' | 'runs' | 'settings';

interface SidebarJob {
  id: string;
  status: string;
  updatedAt: string;
  input: { goal: string; projectId?: string };
}

function storedSurface(): Surface {
  const value = localStorage.getItem('local-coder.surface');
  return value === 'projects' || value === 'runs' || value === 'settings' ? value : 'agent';
}

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function relative(value: string): string {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function ConsoleRoot() {
  const [surface, setSurface] = useState<Surface>(storedSurface);
  const [jobs, setJobs] = useState<SidebarJob[]>([]);
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [agentEpoch, setAgentEpoch] = useState(0);

  async function refreshSidebar() {
    const [{ jobs: nextJobs }, { projects: nextProjects }] = await Promise.all([
      api<{ jobs: SidebarJob[] }>('/api/jobs'),
      api<{ projects: AdminProject[] }>('/api/projects')
    ]);
    setJobs(nextJobs);
    setProjects(nextProjects);
  }

  useEffect(() => {
    void refreshSidebar();
    const events = new EventSource('/api/events');
    events.addEventListener('jobs', (event) => setJobs(JSON.parse((event as MessageEvent<string>).data) as SidebarJob[]));
    events.addEventListener('job', (event) => {
      const { job } = JSON.parse((event as MessageEvent<string>).data) as { job: SidebarJob };
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    });
    const onProjectsChanged = () => { void refreshSidebar(); };
    window.addEventListener('local-coder:projects-changed', onProjectsChanged);
    return () => {
      events.close();
      window.removeEventListener('local-coder:projects-changed', onProjectsChanged);
    };
  }, []);

  const recentJobs = useMemo(() => [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 7), [jobs]);
  const visibleProjects = useMemo(() => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 7), [projects]);

  function selectSurface(next: Surface) {
    localStorage.setItem('local-coder.surface', next);
    setSurface(next);
  }

  function startNewTask() {
    selectSurface('agent');
    setAgentEpoch((value) => value + 1);
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('.new-task-button')?.click(), 40);
  }

  function openJob(job: SidebarJob) {
    selectSurface('agent');
    setAgentEpoch((value) => value + 1);
    window.setTimeout(() => {
      const target = Array.from(document.querySelectorAll<HTMLButtonElement>('.claude-session'))
        .find((button) => button.textContent?.includes(job.input.goal));
      target?.click();
    }, 80);
  }

  function runProject(project: AdminProject) {
    localStorage.setItem('local-coder.project', project.id);
    selectSurface('agent');
    setAgentEpoch((value) => value + 1);
  }

  function openAdvanced(project?: AdminProject) {
    if (project) localStorage.setItem('local-coder.admin-project', project.id);
    selectSurface('settings');
  }

  return <div className={`reference-app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} surface-${surface}`}>
    <aside className="reference-sidebar" aria-label="Local Coder">
      <div className="reference-sidebar-titlebar">
        <button className="reference-sidebar-collapse" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? 'Expandir barra lateral' : 'Recolher barra lateral'}>
          <SlidersHorizontal size={15} />
        </button>
      </div>

      <nav className="reference-primary-nav">
        <button className={surface === 'agent' ? 'active' : ''} onClick={startNewTask}><Plus size={15} /><span>Novo</span></button>
        <button className={surface === 'projects' ? 'active' : ''} onClick={() => selectSurface('projects')}><Folder size={15} /><span>Projetos</span></button>
        <button className={surface === 'runs' ? 'active' : ''} onClick={() => selectSurface('runs')}><History size={15} /><span>Execuções</span></button>
      </nav>

      <div className="reference-sidebar-scroll">
        <section className="reference-sidebar-section">
          <div className="reference-sidebar-section-title"><span>Conversas e tarefas</span></div>
          {recentJobs.map((job) => <button className="reference-sidebar-row" key={job.id} onClick={() => openJob(job)} title={job.input.goal}>
            <span className={`reference-status-dot status-${job.status}`} />
            <span className="reference-sidebar-row-copy"><strong>{job.input.goal}</strong><small>{relative(job.updatedAt)}</small></span>
          </button>)}
          {recentJobs.length === 0 ? <p className="reference-sidebar-empty">Nenhuma tarefa ainda</p> : null}
        </section>

        <section className="reference-sidebar-section reference-project-tree">
          <div className="reference-sidebar-section-title"><span>Projetos</span><button onClick={() => selectSurface('projects')} aria-label="Abrir projetos"><Plus size={14} /></button></div>
          {visibleProjects.map((project) => <button className="reference-sidebar-row project-row" key={project.id} onClick={() => runProject(project)} title={project.workspace}>
            <Folder size={14} />
            <span className="reference-sidebar-row-copy"><strong>{project.name}</strong><small>{project.defaultRoutingPolicy}</small></span>
            <ChevronRight size={12} className="reference-row-chevron" />
          </button>)}
        </section>
      </div>

      <div className="reference-sidebar-footer">
        <button className={surface === 'settings' ? 'active' : ''} onClick={() => openAdvanced()}><Settings size={15} /><span>Configurações</span></button>
        <div className="reference-account-row"><span className="reference-account-avatar"><Bot size={14} /></span><span><strong>Local Coder</strong><small>Agent Runtime</small></span></div>
      </div>
    </aside>

    <main className="reference-content-shell">
      {surface === 'agent' ? <App key={agentEpoch} /> : null}
      {surface === 'projects' ? <ProjectGallery onOpenProject={runProject} onAdvanced={openAdvanced} /> : null}
      {surface === 'runs' ? <RunInspector /> : null}
      {surface === 'settings' ? <AdminPanel onRunProject={runProject} /> : null}
    </main>
  </div>;
}
