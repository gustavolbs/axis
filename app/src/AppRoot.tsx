import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Folder,
  FolderOpen,
  History,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Trash2
} from 'lucide-react';

import type { AdminProject } from './app-types.js';
import { App } from './App.js';
import { ProjectGallery } from './ProjectGallery.js';
import { RunInspector } from './RunInspector.js';
import { SettingsModal } from './SettingsModal.js';
import { displayProfileName, type DesktopCommand } from './native.js';

/** Conversations live in the sidebar, under their project or in the
 *  project-less Chats section. Archived holds what has been hidden from it. */
type Surface = 'agent' | 'projects' | 'runs' | 'archived';

interface SidebarJob {
  id: string;
  status: string;
  updatedAt: string;
  /** User-chosen name; the goal is the fallback. */
  title?: string;
  archivedAt?: string;
  input: { goal: string; projectId?: string };
}

/** A conversation's name, falling back to the prompt that started it. */
function jobTitle(job: SidebarJob): string {
  return job.title?.trim() || job.input.goal;
}

function storedSurface(): Surface {
  const value = localStorage.getItem('local-coder.surface');
  return value === 'projects' || value === 'runs' || value === 'archived' ? value : 'agent';
}

const READ_KEY = 'local-coder.read-jobs';
const EXPANDED_KEY = 'local-coder.expanded-projects';

function storedIds(key: string): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function isRunning(status: string): boolean {
  return status === 'running' || status === 'queued' || status.startsWith('waiting');
}

async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body)
  });
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

export function AppRoot() {
  const [surface, setSurface] = useState<Surface>(storedSurface);
  const [jobs, setJobs] = useState<SidebarJob[]>([]);
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [userCollapsed, setUserCollapsed] = useState(() => localStorage.getItem('local-coder.sidebar-collapsed') === 'true');
  const [autoCollapsed, setAutoCollapsed] = useState(() => window.innerWidth < 900);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('local-coder.sidebar-width') ?? 250));
  const [agentEpoch, setAgentEpoch] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [jobMenuId, setJobMenuId] = useState<string>();
  const [projectMenuId, setProjectMenuId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [profileName, setProfileName] = useState('Local profile');
  const [runtimeOnline, setRuntimeOnline] = useState<boolean>();
  const [readJobs, setReadJobs] = useState<Set<string>>(() => storedIds(READ_KEY));
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => storedIds(EXPANDED_KEY));

  const sidebarCollapsed = userCollapsed || autoCollapsed;
  const isElectron = window.lc?.isElectron === true;
  const platform = window.lc?.platform ?? 'web';

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
    void window.lc?.getProfile().then(({ userName }) => setProfileName(displayProfileName(userName)));

    const events = new EventSource('/api/events');
    events.addEventListener('jobs', (event) => setJobs(JSON.parse((event as MessageEvent<string>).data) as SidebarJob[]));
    events.addEventListener('job', (event) => {
      const { job } = JSON.parse((event as MessageEvent<string>).data) as { job: SidebarJob };
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    });
    events.addEventListener('worker', () => setRuntimeOnline(true));
    events.addEventListener('worker-error', () => setRuntimeOnline(false));
    const onProjectsChanged = () => { void refreshSidebar(); };
    window.addEventListener('local-coder:projects-changed', onProjectsChanged);
    return () => {
      events.close();
      window.removeEventListener('local-coder:projects-changed', onProjectsChanged);
    };
  }, []);

  useEffect(() => {
    const onResize = () => setAutoCollapsed(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Archiving hides an item from the sidebar; the Archived surface lists it.
  const recentJobs = useMemo(() => jobs
    .filter((job) => !job.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 24), [jobs]);
  const visibleProjects = useMemo(() => projects
    .filter((project) => !project.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 10), [projects]);
  const archivedJobs = useMemo(() => jobs
    .filter((job) => job.archivedAt)
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')), [jobs]);
  const archivedProjects = useMemo(() => projects.filter((project) => project.archived), [projects]);

  /** A conversation belongs to its project, or to the loose Chats section. */
  const jobsByProject = useMemo(() => {
    const map = new Map<string, SidebarJob[]>();
    for (const job of recentJobs) {
      const key = job.input.projectId;
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), job]);
    }
    return map;
  }, [recentJobs]);

  const looseJobs = useMemo(() => recentJobs.filter((job) => !job.input.projectId), [recentJobs]);

  const groupedLooseJobs = useMemo(() => {
    const groups = new Map<string, SidebarJob[]>();
    for (const job of looseJobs) {
      const label = groupLabel(job.updatedAt);
      groups.set(label, [...(groups.get(label) ?? []), job]);
    }
    return [...groups.entries()];
  }, [looseJobs]);

  const searchResults = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    return {
      jobs: recentJobs.filter((job) => !needle || jobTitle(job).toLowerCase().includes(needle)).slice(0, 8),
      projects: projects.filter((project) => !needle || project.name.toLowerCase().includes(needle) || project.workspace.toLowerCase().includes(needle)).slice(0, 8)
    };
  }, [projects, recentJobs, searchQuery]);

  /** Every mutation refreshes from the runtime rather than guessing locally. */
  async function mutate(run: () => Promise<unknown>) {
    setJobMenuId(undefined);
    setProjectMenuId(undefined);
    try {
      await run();
      await refreshSidebar();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  function renameJob(job: SidebarJob) {
    const next = window.prompt('Rename chat', jobTitle(job));
    if (next === null || !next.trim()) return;
    void mutate(() => api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { title: next.trim() } }));
  }

  function archiveJob(job: SidebarJob, archived: boolean) {
    void mutate(() => api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { archived } }));
  }

  function deleteJob(job: SidebarJob) {
    if (!window.confirm(`Delete "${jobTitle(job)}"? This cannot be undone.`)) return;
    void mutate(async () => {
      await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
      if (localStorage.getItem('local-coder.open-job') === job.id) {
        localStorage.removeItem('local-coder.open-job');
        setAgentEpoch((value) => value + 1);
      }
    });
  }

  function renameProject(project: AdminProject) {
    const next = window.prompt('Rename project', project.name);
    if (next === null || !next.trim()) return;
    void mutate(() => api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: { name: next.trim() } }));
  }

  function archiveProject(project: AdminProject, archived: boolean) {
    void mutate(() => api(`/api/projects/${encodeURIComponent(project.id)}/archive`, { method: 'POST', body: { archived } }));
  }

  function deleteProject(project: AdminProject) {
    // The runtime refuses while the project still holds conversations, and says
    // how many; surface that instead of pre-empting it with our own count.
    if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
    void mutate(() => api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' }));
  }

  function selectSurface(next: Surface) {
    localStorage.setItem('local-coder.surface', next);
    setSurface(next);
  }

  function startNewTask() {
    localStorage.removeItem('local-coder.open-job');
    // The composer seeds its project from this key, so leaving it behind made
    // "New chat" silently inherit the last project — and the conversation then
    // landed inside a collapsed project disclosure instead of Chats.
    localStorage.removeItem('local-coder.project');
    selectSurface('agent');
    setAgentEpoch((value) => value + 1);
  }

  function persistIds(key: string, ids: Set<string>) {
    localStorage.setItem(key, JSON.stringify([...ids]));
  }

  function markRead(id: string, read: boolean) {
    setReadJobs((current) => {
      const next = new Set(current);
      if (read) next.add(id);
      else next.delete(id);
      persistIds(READ_KEY, next);
      return next;
    });
  }

  function toggleProject(id: string) {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistIds(EXPANDED_KEY, next);
      return next;
    });
  }

  function openJob(job: SidebarJob) {
    setSearchOpen(false);
    setJobMenuId(undefined);
    markRead(job.id, true);
    localStorage.setItem('local-coder.open-job', job.id);
    if (job.input.projectId) {
      localStorage.setItem('local-coder.project', job.input.projectId);
      // Never leave the open conversation hidden inside a closed disclosure.
      setExpandedProjects((current) => {
        if (current.has(job.input.projectId!)) return current;
        const next = new Set(current).add(job.input.projectId!);
        persistIds(EXPANDED_KEY, next);
        return next;
      });
    } else {
      localStorage.removeItem('local-coder.project');
    }
    selectSurface('agent');
    setAgentEpoch((value) => value + 1);
  }

  function runProject(project: AdminProject) {
    setSearchOpen(false);
    localStorage.removeItem('local-coder.open-job');
    localStorage.setItem('local-coder.project', project.id);
    selectSurface('agent');
    setAgentEpoch((value) => value + 1);
  }

  function openSettings(project?: AdminProject) {
    if (project) localStorage.setItem('local-coder.settings-project', project.id);
    setSettingsOpen(true);
  }

  function toggleSidebar() {
    setUserCollapsed((current) => {
      const next = !current;
      localStorage.setItem('local-coder.sidebar-collapsed', String(next));
      return next;
    });
  }

  function handleCommand(command: DesktopCommand) {
    if (command === 'new-chat') startNewTask();
    else if (command === 'toggle-sidebar') toggleSidebar();
    else if (command === 'settings') setSettingsOpen(true);
    else if (command === 'projects') selectSurface('projects');
    else if (command === 'runs') selectSurface('runs');
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        if (event.key === 'Escape') {
          setSearchOpen(false);
          setJobMenuId(undefined);
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'k') { event.preventDefault(); setSearchOpen(true); }
      else if (key === 'n') { event.preventDefault(); startNewTask(); }
      else if (key === '\\') { event.preventDefault(); toggleSidebar(); }
      else if (key === ',') { event.preventDefault(); setSettingsOpen(true); }
      else if (key === '1') { event.preventDefault(); selectSurface('projects'); }
      else if (key === '2') { event.preventDefault(); selectSurface('runs'); }
    };
    window.addEventListener('keydown', onKeyDown);
    const unsubscribe = window.lc?.onCommand(handleCommand);
    const openSettingsEvent = () => setSettingsOpen(true);
    window.addEventListener('local-coder:open-settings', openSettingsEvent);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('local-coder:open-settings', openSettingsEvent);
      unsubscribe?.();
    };
  }, []);

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

  /**
   * One conversation row. The dot carries three states — running (pulsing),
   * unread, read — and clicking it toggles read/unread without opening the
   * conversation.
   */
  function renderJobRow(job: SidebarJob) {
    const running = isRunning(job.status);
    const read = readJobs.has(job.id);
    const state = running ? 'running' : read ? 'read' : 'unread';
    const dotLabel = running ? 'In progress' : read ? 'Mark as unread' : 'Mark as read';
    return <div className="lc-shell-sidebar-row-wrap" key={job.id}>
      <button
        className="lc-shell-chat-dot"
        data-state={state}
        onClick={() => { if (!running) markRead(job.id, !read); }}
        aria-label={`${dotLabel}: ${job.input.goal}`}
        aria-pressed={running ? undefined : !read}
        title={dotLabel}
      />
      <button className={`lc-shell-sidebar-row ${read || running ? '' : 'unread'}`} onClick={() => openJob(job)} title={jobTitle(job)}>
        <span className="lc-shell-sidebar-row-copy"><strong>{jobTitle(job)}</strong><small>{relative(job.updatedAt)}</small></span>
      </button>
      <button className="lc-shell-row-menu-button" aria-label={`More options for ${jobTitle(job)}`} onClick={(event) => { event.stopPropagation(); setProjectMenuId(undefined); setJobMenuId((current) => current === job.id ? undefined : job.id); }}><MoreHorizontal size={14} /></button>
      {jobMenuId === job.id ? <div className="lc-shell-row-menu">
        <button onClick={() => openJob(job)}>Open chat</button>
        <button onClick={() => { setJobMenuId(undefined); markRead(job.id, !read); }}>{read ? 'Mark as unread' : 'Mark as read'}</button>
        <button onClick={() => renameJob(job)}>Rename…</button>
        <button onClick={() => archiveJob(job, true)}>Archive</button>
        <button onClick={() => { setJobMenuId(undefined); selectSurface('runs'); }}>View run details</button>
        <button className="danger" onClick={() => deleteJob(job)}>Delete…</button>
      </div> : null}
    </div>;
  }

  // The collapsed rail must be at least as wide as the macOS traffic lights,
  // otherwise they render on top of the content area.
  const collapsedWidth = isElectron && platform === 'darwin' ? 78 : 56;
  const shellStyle = {
    '--lc-sidebar-width': `${sidebarCollapsed ? collapsedWidth : sidebarWidth}px`
  } as CSSProperties;
  const tooltip = (label: string) => sidebarCollapsed ? label : undefined;
  const avatar = profileName.trim().charAt(0).toUpperCase() || 'L';

  return <div
    className={`lc-shell-app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${autoCollapsed ? 'auto-sidebar-collapsed' : ''} surface-${surface}`}
    style={shellStyle}
    data-shell={isElectron ? 'electron' : 'web'}
    data-platform={platform}
  >
    {/* Window-level row, deliberately outside the sidebar: it has to sit beside
        the traffic lights whatever the sidebar's width, and a 56px rail cannot
        hold 76px of lights plus a button. Toggle and search only — a wordmark
        here landed on top of the lights, and the reference app has none. */}
    <div className="lc-shell-window-chrome">
      <button className="lc-shell-icon-button" onClick={toggleSidebar} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} data-tooltip={tooltip(sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar')}>
        <PanelLeft size={16} aria-hidden="true" />
      </button>
      <button className="lc-shell-icon-button" onClick={() => setSearchOpen(true)} aria-label="Search" data-tooltip="Search  ⌘K">
        <Search size={16} aria-hidden="true" />
      </button>
    </div>

    <aside className="lc-shell-sidebar" aria-label="Local Coder" data-collapsed={sidebarCollapsed ? 'true' : 'false'}>
      <nav className="lc-shell-primary-nav">
        <button className="lc-shell-new-chat" onClick={startNewTask} aria-label="New chat" data-tooltip={tooltip('New chat')}><i aria-hidden="true"><Plus size={15} /></i><span>New chat</span></button>
        <button className={surface === 'projects' ? 'active' : ''} onClick={() => selectSurface('projects')} aria-label="Projects" data-tooltip={tooltip('Projects')}><Folder size={16} aria-hidden="true" /><span>Projects</span></button>
        <button className={surface === 'runs' ? 'active' : ''} onClick={() => selectSurface('runs')} aria-label="Runs" data-tooltip={tooltip('Runs')}><History size={16} aria-hidden="true" /><span>Runs</span></button>
        <button className={surface === 'archived' ? 'active' : ''} onClick={() => selectSurface('archived')} aria-label="Archived" data-tooltip={tooltip('Archived')}><Archive size={16} aria-hidden="true" /><span>Archived</span></button>
      </nav>

      <div className="lc-shell-sidebar-scroll">
        <section className="lc-shell-sidebar-section lc-shell-project-tree">
          <div className="lc-shell-sidebar-section-title"><span>Projects</span><button onClick={() => selectSurface('projects')} aria-label="Open projects"><Plus size={14} /></button></div>
          {visibleProjects.map((project) => {
            const children = jobsByProject.get(project.id) ?? [];
            const expanded = expandedProjects.has(project.id);
            return <div className="lc-shell-project-node" key={project.id}>
              <div className="lc-shell-sidebar-row-wrap">
                {/* The folder icon is the accordion; the rest of the row opens
                    the project. */}
                <button
                  className="lc-shell-project-disclosure"
                  onClick={() => toggleProject(project.id)}
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`}
                  disabled={children.length === 0}
                >
                  {expanded ? <FolderOpen size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />}
                </button>
                <button className="lc-shell-sidebar-row project-row" onClick={() => runProject(project)} title={project.workspace}>
                  <span className="lc-shell-sidebar-row-copy"><strong>{project.name}</strong></span>
                </button>
                <button className="lc-shell-row-menu-button" aria-label={`More options for ${project.name}`} onClick={(event) => { event.stopPropagation(); setJobMenuId(undefined); setProjectMenuId((current) => current === project.id ? undefined : project.id); }}><MoreHorizontal size={14} /></button>
                {projectMenuId === project.id ? <div className="lc-shell-row-menu">
                  <button onClick={() => { setProjectMenuId(undefined); runProject(project); }}>Open project</button>
                  <button onClick={() => renameProject(project)}>Rename…</button>
                  <button onClick={() => archiveProject(project, true)}>Archive</button>
                  <button className="danger" onClick={() => deleteProject(project)}>Delete…</button>
                </div> : null}
              </div>
              {expanded ? <div className="lc-shell-project-children">
                {children.map((job) => renderJobRow(job))}
              </div> : null}
            </div>;
          })}
          {visibleProjects.length === 0 ? <p className="lc-shell-sidebar-empty">No projects yet</p> : null}
        </section>

        {/* Conversations that belong to no project. */}
        <section className="lc-shell-sidebar-section">
          <div className="lc-shell-sidebar-section-title"><span>Chats</span><button onClick={startNewTask} aria-label="New chat without a project"><Plus size={14} /></button></div>
          {groupedLooseJobs.map(([label, group]) => <div className="lc-shell-recent-group" key={label}>
            <div className="lc-shell-recent-label">{label}</div>
            {group.map((job) => renderJobRow(job))}
          </div>)}
          {looseJobs.length === 0 ? <p className="lc-shell-sidebar-empty">No chats yet</p> : null}
        </section>
      </div>

      <div className="lc-shell-sidebar-footer">
        <div className={`lc-shell-runtime-status ${runtimeOnline === false ? 'offline' : runtimeOnline === true ? 'online' : ''}`} title={runtimeOnline === false ? 'Local runtime unavailable' : 'Local runtime connected'}><i /><span>{runtimeOnline === false ? 'Runtime offline' : runtimeOnline === true ? 'Runtime connected' : 'Connecting…'}</span></div>
        {/* No Settings row: the account row below opens the same modal. */}
        <button className="lc-shell-account-row" onClick={() => openSettings()} aria-label={`${profileName} profile and settings`} data-tooltip={tooltip(profileName)}>
          <span className="lc-shell-account-avatar">{avatar}</span>
          <span><strong>{profileName}</strong><small>On-device workspace</small></span>
          <ChevronDown size={14} className="lc-shell-account-chevron" aria-hidden="true" />
        </button>
      </div>
      <div className="lc-shell-sidebar-resizer" onPointerDown={beginSidebarResize} aria-hidden="true" />
    </aside>

    <main className="lc-shell-content-shell">
      {actionError ? <div className="lc-agent-error-banner" role="status" aria-live="polite">
        <span>{actionError}</span>
        <button onClick={() => setActionError(undefined)} aria-label="Dismiss">Dismiss</button>
      </div> : null}
      {surface === 'agent' ? <App key={agentEpoch} /> : null}
      {surface === 'projects' ? <ProjectGallery onOpenProject={runProject} onAdvanced={openSettings} /> : null}
      {surface === 'runs' ? <RunInspector /> : null}
      {surface === 'archived' ? <ArchivedView
        jobs={archivedJobs}
        projects={archivedProjects}
        onOpenJob={openJob}
        onRestoreJob={(job) => archiveJob(job, false)}
        onDeleteJob={deleteJob}
        onRestoreProject={(project) => archiveProject(project, false)}
        onDeleteProject={deleteProject}
      /> : null}
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

/**
 * Where archived conversations and projects live. Archiving never discards
 * anything, so everything here can be restored; delete is the only one-way
 * door and it asks first.
 */
function ArchivedView(props: {
  jobs: SidebarJob[];
  projects: AdminProject[];
  onOpenJob: (job: SidebarJob) => void;
  onRestoreJob: (job: SidebarJob) => void;
  onDeleteJob: (job: SidebarJob) => void;
  onRestoreProject: (project: AdminProject) => void;
  onDeleteProject: (project: AdminProject) => void;
}) {
  const empty = props.jobs.length === 0 && props.projects.length === 0;
  return <div className="archived-page">
    <h1 className="page-title">Archived</h1>

    {empty ? <p className="archived-empty">Nothing archived. Archiving a chat or a project hides it from the sidebar without deleting it.</p> : null}

    {props.projects.length ? <section className="archived-section">
      <h2>Projects</h2>
      {props.projects.map((project) => <div className="archived-row" key={project.id}>
        <span className="archived-row-copy"><strong>{project.name}</strong><small>{project.workspace}</small></span>
        <button className="btn-secondary" onClick={() => props.onRestoreProject(project)}><ArchiveRestore size={14} />Restore</button>
        <button className="btn-secondary danger" onClick={() => props.onDeleteProject(project)}><Trash2 size={14} />Delete</button>
      </div>)}
    </section> : null}

    {props.jobs.length ? <section className="archived-section">
      <h2>Chats</h2>
      {props.jobs.map((job) => <div className="archived-row" key={job.id}>
        <button className="archived-row-open" onClick={() => props.onOpenJob(job)} title={jobTitle(job)}>
          <span className="archived-row-copy"><strong>{jobTitle(job)}</strong><small>Archived {relative(job.archivedAt ?? job.updatedAt)} ago</small></span>
        </button>
        <button className="btn-secondary" onClick={() => props.onRestoreJob(job)}><ArchiveRestore size={14} />Restore</button>
        <button className="btn-secondary danger" onClick={() => props.onDeleteJob(job)}><Trash2 size={14} />Delete</button>
      </div>)}
    </section> : null}
  </div>;
}
