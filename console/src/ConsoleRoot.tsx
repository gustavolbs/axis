import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ChevronRight,
  Folder,
  History,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Sparkles
} from 'lucide-react';

import type { AdminProject } from './AdminPanel.js';
import { App } from './App.js';
import { ProjectGallery } from './ProjectGallery.js';
import { RunInspector } from './RunInspector.js';
import { SettingsModal } from './SettingsModal.js';

type Surface = 'agent' | 'projects' | 'runs';

interface SidebarJob {
  id: string;
  status: string;
  updatedAt: string;
  input: { goal: string; projectId?: string };
}

function storedSurface(): Surface {
  const value = localStorage.getItem('local-coder.surface');
  return value === 'projects' || value === 'runs' ? value : 'agent';
}

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function relative(value: string): string {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function groupLabel(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startValue = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.floor((startToday - startValue) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  return 'Older';
}

export function ConsoleRoot() {
  const [surface, setSurface] = useState<Surface>(storedSurface);
  const [jobs, setJobs] = useState<SidebarJob[]>([]);
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('local-coder.sidebar-width') ?? 250));
  const [agentEpoch, setAgentEpoch] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [jobMenuId, setJobMenuId] = useState<string>();

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === 'Escape') {
        setSearchOpen(false);
        setJobMenuId(undefined);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const recentJobs = useMemo(() => [...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 24), [jobs]);
  const visibleProjects = useMemo(() => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10), [projects]);
  const groupedJobs = useMemo(() => {
    const groups = new Map<string, SidebarJob[]>();
    for (const job of recentJobs) {
      const label = groupLabel(job.updatedAt);
      groups.set(label, [...(groups.get(label) ?? []), job]);
    }
    return [...groups.entries()];
  }, [recentJobs]);

  const searchResults = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    return {
      jobs: recentJobs.filter((job) => !needle || job.input.goal.toLowerCase().includes(needle)).slice(0, 8),
      projects: projects.filter((project) => !needle || project.name.toLowerCase().includes(needle) || project.workspace.toLowerCase().includes(needle)).slice(0, 8)
    };
  }, [projects, recentJobs, searchQuery]);

  function selectSurface(next: Surface) {
    localStorage.setItem('local-coder.surface', next);
    setSurface(next);
  }

  function startNewTask() {
    selectSurface('agent');
    setAgentEpoch((value) => value + 1);
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('.new-task-button')?.click(), 40);
  }

  function openChats() {
    selectSurface('agent');
  }

  function openJob(job: SidebarJob) {
    setSearchOpen(false);
    setJobMenuId(undefined);
    selectSurface('agent');
    setAgentEpoch((value) => value + 1);
    window.setTimeout(() => {
      const target = Array.from(document.querySelectorAll<HTMLButtonElement>('.claude-session'))
        .find((button) => button.textContent?.includes(job.input.goal));
      target?.click();
    }, 80);
  }

  function runProject(project: AdminProject) {
    setSearchOpen(false);
    localStorage.setItem('local-coder.project', project.id);
    selectSurface('agent');
    setAgentEpoch((value) => value + 1);
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('.new-task-button')?.click(), 80);
  }

  function openAdvanced(project?: AdminProject) {
    if (project) localStorage.setItem('local-coder.admin-project', project.id);
    setSettingsOpen(true);
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (sidebarCollapsed) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;
    const onMove = (moveEvent: PointerEvent) => {
      latestWidth = Math.min(320, Math.max(220, startWidth + moveEvent.clientX - startX));
      setSidebarWidth(latestWidth);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      localStorage.setItem('local-coder.sidebar-width', String(latestWidth));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  const shellStyle = { '--ref-sidebar-width': `${sidebarWidth}px` } as CSSProperties;

  return <div className={`reference-app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} surface-${surface}`} style={shellStyle}>
    <aside className="reference-sidebar" aria-label="Local Coder">
      <div className="reference-sidebar-titlebar">
        <div className="reference-product-mark" aria-label="Local Coder"><span><Sparkles size={15} /></span><strong>Local Coder</strong></div>
        <button className="reference-sidebar-collapse" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <PanelLeft size={16} />
        </button>
      </div>

      <nav className="reference-primary-nav">
        <button onClick={startNewTask}><Plus size={16} /><span>New chat</span></button>
        <button onClick={() => setSearchOpen(true)}><Search size={15} /><span>Search</span><kbd>⌘K</kbd></button>
        <button className={surface === 'agent' ? 'active' : ''} onClick={openChats}><MessageSquare size={15} /><span>Chats</span></button>
        <button className={surface === 'projects' ? 'active' : ''} onClick={() => selectSurface('projects')}><Folder size={15} /><span>Projects</span></button>
        <button className={surface === 'runs' ? 'active' : ''} onClick={() => selectSurface('runs')}><History size={15} /><span>Runs</span></button>
      </nav>

      <div className="reference-sidebar-scroll">
        <section className="reference-sidebar-section">
          <div className="reference-sidebar-section-title"><span>Recents</span></div>
          {groupedJobs.map(([label, group]) => <div className="reference-recent-group" key={label}>
            <div className="reference-recent-label">{label}</div>
            {group.map((job) => <div className="reference-sidebar-row-wrap" key={job.id}>
              <button className="reference-sidebar-row" onClick={() => openJob(job)} title={job.input.goal}>
                <span className={`reference-status-dot status-${job.status}`} />
                <span className="reference-sidebar-row-copy"><strong>{job.input.goal}</strong><small>{relative(job.updatedAt)}</small></span>
              </button>
              <button className="reference-row-menu-button" aria-label={`More options for ${job.input.goal}`} onClick={(event) => { event.stopPropagation(); setJobMenuId((current) => current === job.id ? undefined : job.id); }}><MoreHorizontal size={14} /></button>
              {jobMenuId === job.id ? <div className="reference-row-menu"><button onClick={() => openJob(job)}>Open chat</button><button onClick={() => { setJobMenuId(undefined); selectSurface('runs'); }}>View run details</button></div> : null}
            </div>)}
          </div>)}
          {recentJobs.length === 0 ? <p className="reference-sidebar-empty">No chats yet</p> : null}
        </section>

        <section className="reference-sidebar-section reference-project-tree">
          <div className="reference-sidebar-section-title"><span>Projects</span><button onClick={() => selectSurface('projects')} aria-label="Open projects"><Plus size={14} /></button></div>
          {visibleProjects.map((project) => <button className="reference-sidebar-row project-row" key={project.id} onClick={() => runProject(project)} title={project.workspace}>
            <Folder size={14} />
            <span className="reference-sidebar-row-copy"><strong>{project.name}</strong><small>{project.defaultRoutingPolicy}</small></span>
            <ChevronRight size={12} className="reference-row-chevron" />
          </button>)}
        </section>
      </div>

      <div className="reference-sidebar-footer">
        <button onClick={() => openAdvanced()}><Settings size={15} /><span>Settings</span></button>
        <button className="reference-account-row" onClick={() => setSettingsOpen(true)}>
          <span className="reference-account-avatar">L</span><span><strong>Local profile</strong><small>On-device workspace</small></span>
        </button>
      </div>
      <div className="reference-sidebar-resizer" onPointerDown={beginSidebarResize} aria-hidden="true" />
    </aside>

    <main className="reference-content-shell">
      {surface === 'agent' ? <App key={agentEpoch} /> : null}
      {surface === 'projects' ? <ProjectGallery onOpenProject={runProject} onAdvanced={openAdvanced} /> : null}
      {surface === 'runs' ? <RunInspector /> : null}
    </main>

    {searchOpen ? <div className="global-search-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setSearchOpen(false); }}>
      <section className="global-search" role="dialog" aria-modal="true" aria-label="Search">
        <div className="global-search-input"><Search size={17} /><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search chats and projects" /><kbd>Esc</kbd></div>
        <div className="global-search-results">
          {searchResults.jobs.length ? <div className="global-search-group"><span>Chats</span>{searchResults.jobs.map((job) => <button key={job.id} onClick={() => openJob(job)}><MessageSquare size={15} /><span><strong>{job.input.goal}</strong><small>{relative(job.updatedAt)}</small></span></button>)}</div> : null}
          {searchResults.projects.length ? <div className="global-search-group"><span>Projects</span>{searchResults.projects.map((project) => <button key={project.id} onClick={() => runProject(project)}><Folder size={15} /><span><strong>{project.name}</strong><small>{project.workspace}</small></span></button>)}</div> : null}
          {!searchResults.jobs.length && !searchResults.projects.length ? <p className="global-search-empty">No results</p> : null}
        </div>
      </section>
    </div> : null}

    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} onRunProject={(project) => { setSettingsOpen(false); runProject(project); }} />
  </div>;
}
