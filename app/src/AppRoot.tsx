import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  Building2,
  ChevronDown,
  Folder,
  FolderOpen,
  History,
  LayoutDashboard,
  Mail,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Trash2
} from 'lucide-react';

import type { AdminProject, CompanyDefinition } from './app-types.js';
import { App } from './App.js';
import { CompaniesSettings } from './CompaniesSettings.js';
import { CompanyHub, type CompanyHubSection } from './CompanyHub.js';
import { ProjectGallery } from './ProjectGallery.js';
import { ProjectDetail } from './ProjectDetail.js';
import { RunInspector } from './RunInspector.js';
import { SettingsModal } from './SettingsModal.js';
import { ShellDialog, type ShellDialogRequest } from './ShellDialog.js';
import { displayProfileName, type DesktopCommand } from './native.js';
import { GlobalWorkHubLauncher, type WorkHubTab } from './GlobalWorkHubLauncher.js';

type Surface = 'agent' | 'projects' | 'project' | 'company' | 'companies' | 'runs' | 'archived' | 'work-hub';

interface SidebarJob {
  id: string;
  status: string;
  updatedAt: string;
  title?: string;
  archivedAt?: string;
  input: { goal: string; projectId?: string };
}

function jobTitle(job: SidebarJob): string {
  return job.title?.trim() || job.input.goal;
}

function storedSurface(): Surface {
  const value = localStorage.getItem('local-coder.surface');
  return value === 'projects' || value === 'project' || value === 'company' || value === 'companies' || value === 'runs' || value === 'archived' || value === 'work-hub' ? value : 'agent';
}

function storedWorkHubTab(): WorkHubTab {
  const value = localStorage.getItem('local-coder.work-hub-tab');
  return value === 'today' || value === 'calendar' || value === 'work' || value === 'sources' ? value : 'inbox';
}

function storedCompanySection(): CompanyHubSection {
  const value = localStorage.getItem('local-coder.company-hub-section');
  return value === 'projects' || value === 'connections' || value === 'mcps' || value === 'skills' || value === 'settings' ? value : 'overview';
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
  const [companies, setCompanies] = useState<CompanyDefinition[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(() => localStorage.getItem('local-coder.project') ?? '');
  const [selectedCompanyId, setSelectedCompanyId] = useState(() => localStorage.getItem('local-coder.company') ?? 'personal');
  const [companyHubSection, setCompanyHubSection] = useState<CompanyHubSection>(storedCompanySection);
  const [userCollapsed, setUserCollapsed] = useState(() => localStorage.getItem('local-coder.sidebar-collapsed') === 'true');
  const [autoCollapsed, setAutoCollapsed] = useState(() => window.innerWidth < 900);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('local-coder.sidebar-width') ?? 250));
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [agentEpoch, setAgentEpoch] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [workHubTab, setWorkHubTab] = useState<WorkHubTab>(storedWorkHubTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [jobMenuId, setJobMenuId] = useState<string>();
  const [projectMenuId, setProjectMenuId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [dialog, setDialog] = useState<ShellDialogRequest>();
  const [profileName, setProfileName] = useState('Local profile');
  const [runtimeOnline, setRuntimeOnline] = useState<boolean>();
  const [readJobs, setReadJobs] = useState<Set<string>>(() => storedIds(READ_KEY));
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => storedIds(EXPANDED_KEY));

  const sidebarCollapsed = userCollapsed || autoCollapsed;
  const isElectron = window.lc?.isElectron === true;
  const platform = window.lc?.platform ?? 'web';

  async function refreshSidebar() {
    const [{ context }, { jobs: nextJobs }, { projects: nextProjects }] = await Promise.all([
      api<{ context: { companies: CompanyDefinition[] } }>('/api/companies/context'),
      api<{ jobs: SidebarJob[] }>('/api/jobs'),
      api<{ projects: AdminProject[] }>('/api/projects')
    ]);
    const nextCompanies = context.companies;
    setJobs(nextJobs);
    setProjects(nextProjects);
    setCompanies(nextCompanies);
    if (!nextCompanies.some((company) => company.id === selectedCompanyId && !company.archivedAt)) {
      const fallback = nextCompanies.find((company) => company.id === 'personal' && !company.archivedAt) ?? nextCompanies.find((company) => !company.archivedAt);
      if (fallback) {
        localStorage.setItem('local-coder.company', fallback.id);
        setSelectedCompanyId(fallback.id);
      }
    }
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
    const refresh = () => { void refreshSidebar(); };
    window.addEventListener('local-coder:projects-changed', refresh);
    window.addEventListener('local-coder:companies-changed', refresh);
    return () => {
      events.close();
      window.removeEventListener('local-coder:projects-changed', refresh);
      window.removeEventListener('local-coder:companies-changed', refresh);
    };
  }, []);

  useEffect(() => {
    const onResize = () => setAutoCollapsed(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const activeCompanies = useMemo(() => companies
    .filter((company) => !company.archivedAt)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name)), [companies]);
  const selectedCompany = useMemo(() => activeCompanies.find((company) => company.id === selectedCompanyId), [activeCompanies, selectedCompanyId]);
  const recentJobs = useMemo(() => jobs.filter((job) => !job.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 24), [jobs]);
  const visibleProjects = useMemo(() => projects.filter((project) => !project.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10), [projects]);
  const archivedJobs = useMemo(() => jobs.filter((job) => job.archivedAt).sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')), [jobs]);
  const archivedProjects = useMemo(() => projects.filter((project) => project.archived), [projects]);
  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId), [projects, selectedProjectId]);

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
      projects: projects.filter((project) => !needle || project.name.toLowerCase().includes(needle) || project.workspace.toLowerCase().includes(needle)).slice(0, 8),
      companies: activeCompanies.filter((company) => !needle || company.name.toLowerCase().includes(needle) || company.description?.toLowerCase().includes(needle)).slice(0, 8)
    };
  }, [activeCompanies, projects, recentJobs, searchQuery]);

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
    setJobMenuId(undefined);
    setDialog({ kind: 'prompt', title: 'Rename chat', label: 'Name', value: jobTitle(job), confirmLabel: 'Rename', onConfirm: (next) => void mutate(() => api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { title: next } })) });
  }

  function archiveJob(job: SidebarJob, archived: boolean) {
    void mutate(() => api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { archived } }));
  }

  function deleteJob(job: SidebarJob) {
    setJobMenuId(undefined);
    setDialog({
      kind: 'confirm', title: 'Delete chat', message: `"${jobTitle(job)}" will be deleted. This cannot be undone — archive it instead to keep it out of the sidebar.`, confirmLabel: 'Delete', danger: true,
      onConfirm: () => void mutate(async () => {
        await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
        if (localStorage.getItem('local-coder.open-job') === job.id) {
          localStorage.removeItem('local-coder.open-job');
          setAgentEpoch((value) => value + 1);
        }
      })
    });
  }

  function renameProject(project: AdminProject) {
    setProjectMenuId(undefined);
    setDialog({ kind: 'prompt', title: 'Rename project', label: 'Name', value: project.name, confirmLabel: 'Rename', onConfirm: (next) => void mutate(() => api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: { name: next } })) });
  }

  function archiveProject(project: AdminProject, archived: boolean) {
    void mutate(() => api(`/api/projects/${encodeURIComponent(project.id)}/archive`, { method: 'POST', body: { archived } }));
  }

  function deleteProject(project: AdminProject) {
    setProjectMenuId(undefined);
    setDialog({ kind: 'confirm', title: 'Delete project', message: `"${project.name}" will be deleted. This cannot be undone, and a project that still holds conversations cannot be deleted at all.`, confirmLabel: 'Delete', danger: true, onConfirm: () => void mutate(() => api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' })) });
  }

  function selectSurface(next: Surface) {
    localStorage.setItem('local-coder.surface', next);
    setSurface(next);
  }

  function selectWorkHubTab(next: WorkHubTab) {
    localStorage.setItem('local-coder.work-hub-tab', next);
    setWorkHubTab(next);
  }

  function selectCompanySection(next: CompanyHubSection) {
    localStorage.setItem('local-coder.company-hub-section', next);
    setCompanyHubSection(next);
  }

  function openCompany(company: CompanyDefinition, section: CompanyHubSection = 'overview') {
    localStorage.setItem('local-coder.company', company.id);
    setSelectedCompanyId(company.id);
    selectCompanySection(section);
    selectSurface('company');
  }

  function openWorkHubForCompany(companyId: string) {
    localStorage.setItem('local-coder.work-hub-company-filter', companyId);
    selectSurface('work-hub');
  }

  function startNewTask() {
    localStorage.removeItem('local-coder.open-job');
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
      if (read) next.add(id); else next.delete(id);
      persistIds(READ_KEY, next);
      return next;
    });
  }

  function toggleProject(id: string) {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
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
      setExpandedProjects((current) => {
        if (current.has(job.input.projectId!)) return current;
        const next = new Set(current).add(job.input.projectId!);
        persistIds(EXPANDED_KEY, next);
        return next;
      });
    } else localStorage.removeItem('local-coder.project');
    selectSurface('agent');
    setAgentEpoch((value) => value + 1);
  }

  function runProject(project: AdminProject) {
    setSearchOpen(false);
    localStorage.removeItem('local-coder.open-job');
    localStorage.setItem('local-coder.project', project.id);
    localStorage.setItem('local-coder.company', project.companyId);
    setSelectedCompanyId(project.companyId);
    setSelectedProjectId(project.id);
    selectSurface('project');
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
        if (event.key === 'Escape') { setSearchOpen(false); setJobMenuId(undefined); setProjectMenuId(undefined); }
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

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.lc-shell-row-menu, .lc-shell-row-menu-button')) return;
      setJobMenuId(undefined); setProjectMenuId(undefined);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (sidebarCollapsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;
    setSidebarResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      latestWidth = Math.min(320, Math.max(220, startWidth + moveEvent.clientX - startX));
      setSidebarWidth(latestWidth);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp);
      setSidebarResizing(false); localStorage.setItem('local-coder.sidebar-width', String(Math.round(latestWidth)));
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
  }

  function handleSidebarResizeKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (sidebarCollapsed) return;
    const step = event.shiftKey ? 40 : 10;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const nextWidth = Math.min(320, Math.max(220, sidebarWidth + (event.key === 'ArrowLeft' ? -1 : 1) * step));
      setSidebarWidth(nextWidth); localStorage.setItem('local-coder.sidebar-width', String(nextWidth));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); const nextWidth = event.key === 'Home' ? 220 : 320; setSidebarWidth(nextWidth); localStorage.setItem('local-coder.sidebar-width', String(nextWidth));
    }
  }

  function renderJobRow(job: SidebarJob) {
    const running = isRunning(job.status);
    const read = readJobs.has(job.id);
    const state = running ? 'running' : read ? 'read' : 'unread';
    const dotLabel = running ? 'In progress' : read ? 'Mark as unread' : 'Mark as read';
    return <div className="lc-shell-sidebar-row-wrap" key={job.id}>
      <button className="lc-shell-chat-dot" data-state={state} onClick={() => { if (!running) markRead(job.id, !read); }} aria-label={`${dotLabel}: ${job.input.goal}`} aria-pressed={running ? undefined : !read} title={dotLabel} />
      <button className={`lc-shell-sidebar-row ${read || running ? '' : 'unread'}`} onClick={() => openJob(job)} title={jobTitle(job)}><span className="lc-shell-sidebar-row-copy"><strong>{jobTitle(job)}</strong><small>{relative(job.updatedAt)}</small></span></button>
      <button className="lc-shell-row-menu-button" aria-label={`More options for ${jobTitle(job)}`} aria-haspopup="menu" aria-expanded={jobMenuId === job.id} onClick={(event) => { event.stopPropagation(); setProjectMenuId(undefined); setJobMenuId((current) => current === job.id ? undefined : job.id); }}><MoreHorizontal size={14} /></button>
      {jobMenuId === job.id ? <div className="lc-shell-row-menu" role="menu" aria-label={`Actions for ${jobTitle(job)}`}>
        <button type="button" role="menuitem" onClick={() => openJob(job)}>Open chat<MessageSquare size={16} /></button>
        <button type="button" role="menuitem" onClick={() => { setJobMenuId(undefined); markRead(job.id, !read); }}>{read ? 'Mark as unread' : 'Mark as read'}<Mail size={16} /></button>
        <button type="button" role="menuitem" onClick={() => renameJob(job)}>Rename…<Pencil size={16} /></button>
        <button type="button" role="menuitem" onClick={() => { setJobMenuId(undefined); selectSurface('runs'); }}>View run details<History size={16} /></button>
        <div className="lc-shell-row-menu-separator" role="separator" />
        <button type="button" role="menuitem" onClick={() => archiveJob(job, true)}>Archive<Archive size={16} /></button>
        <button type="button" role="menuitem" className="danger" onClick={() => deleteJob(job)}>Delete…<Trash2 size={16} /></button>
      </div> : null}
    </div>;
  }

  const collapsedWidth = isElectron && platform === 'darwin' ? 78 : 56;
  const shellStyle = { '--lc-sidebar-width': `${sidebarCollapsed ? collapsedWidth : sidebarWidth}px` } as CSSProperties;
  const tooltip = (label: string) => sidebarCollapsed ? label : undefined;
  const avatar = profileName.trim().charAt(0).toUpperCase() || 'L';

  return <div className={`lc-shell-app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${autoCollapsed ? 'auto-sidebar-collapsed' : ''} ${sidebarResizing ? 'sidebar-resizing' : ''} surface-${surface}`} style={shellStyle} data-shell={isElectron ? 'electron' : 'web'} data-platform={platform}>
    <div className="lc-shell-window-chrome">
      <button className="lc-shell-icon-button" onClick={toggleSidebar} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} data-tooltip={tooltip(sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar')}><PanelLeft size={16} /></button>
      <button className="lc-shell-icon-button" onClick={() => setSearchOpen(true)} aria-label="Search" data-tooltip="Search  ⌘K"><Search size={16} /></button>
    </div>

    <aside className="lc-shell-sidebar" aria-label="Axis" data-collapsed={sidebarCollapsed ? 'true' : 'false'}>
      <nav className="lc-shell-primary-nav">
        <button className="lc-shell-new-chat" onClick={startNewTask} aria-label="New chat" data-tooltip={tooltip('New chat')}><i><Plus size={15} /></i><span>New chat</span></button>
        <div className="lc-shell-company-nav-heading"><span>Contexts</span><button type="button" onClick={() => selectSurface('companies')} aria-label="Manage Companies" data-tooltip={tooltip('Manage Companies')}><Plus size={13} /></button></div>
        {activeCompanies.map((company) => <button key={company.id} className={surface === 'company' && selectedCompanyId === company.id ? 'active' : ''} onClick={() => openCompany(company)} aria-label={company.name} data-tooltip={tooltip(company.name)} data-company-id={company.id}>
          <span className="lc-shell-company-dot" style={{ backgroundColor: company.color }}>{company.id === 'personal' ? <Building2 size={12} /> : null}</span><span>{company.name}</span>
        </button>)}
        <button className={surface === 'work-hub' ? 'active' : ''} onClick={() => { localStorage.setItem('local-coder.work-hub-company-filter', 'all'); selectSurface('work-hub'); }} aria-label="Work Hub" data-tooltip={tooltip('Work Hub')}><LayoutDashboard size={16} /><span>Work Hub</span></button>
        <button className={surface === 'runs' ? 'active' : ''} onClick={() => selectSurface('runs')} aria-label="Runs" data-tooltip={tooltip('Runs')}><History size={16} /><span>Runs</span></button>
        <button className={surface === 'archived' ? 'active' : ''} onClick={() => selectSurface('archived')} aria-label="Archived" data-tooltip={tooltip('Archived')}><Archive size={16} /><span>Archived</span></button>
      </nav>

      <div className="lc-shell-sidebar-scroll">
        <section className="lc-shell-sidebar-section lc-shell-project-tree">
          <div className="lc-shell-sidebar-section-title"><span>Recent projects</span><button onClick={() => selectSurface('projects')} aria-label="Open all projects"><Folder size={14} /></button></div>
          {visibleProjects.map((project) => {
            const children = jobsByProject.get(project.id) ?? [];
            const expanded = expandedProjects.has(project.id);
            return <div className="lc-shell-project-node" key={project.id}>
              <div className="lc-shell-sidebar-row-wrap">
                <button className="lc-shell-project-disclosure" onClick={() => toggleProject(project.id)} aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`} disabled={children.length === 0}>{expanded ? <FolderOpen size={15} /> : <Folder size={15} />}</button>
                <button className="lc-shell-sidebar-row project-row" onClick={() => runProject(project)} title={project.workspace}><span className="lc-shell-sidebar-row-copy"><strong>{project.name}</strong><small>{project.companyName}</small></span></button>
                <button className="lc-shell-row-menu-button" aria-label={`More options for ${project.name}`} aria-haspopup="menu" aria-expanded={projectMenuId === project.id} onClick={(event) => { event.stopPropagation(); setJobMenuId(undefined); setProjectMenuId((current) => current === project.id ? undefined : project.id); }}><MoreHorizontal size={14} /></button>
                {projectMenuId === project.id ? <div className="lc-shell-row-menu" role="menu" aria-label={`Actions for ${project.name}`}>
                  <button type="button" role="menuitem" onClick={() => { setProjectMenuId(undefined); runProject(project); }}>Open project<FolderOpen size={16} /></button>
                  <button type="button" role="menuitem" onClick={() => renameProject(project)}>Rename…<Pencil size={16} /></button>
                  <div className="lc-shell-row-menu-separator" role="separator" />
                  <button type="button" role="menuitem" onClick={() => archiveProject(project, true)}>Archive<Archive size={16} /></button>
                  <button type="button" role="menuitem" className="danger" onClick={() => deleteProject(project)}>Delete…<Trash2 size={16} /></button>
                </div> : null}
              </div>
              {expanded ? <div className="lc-shell-project-children">{children.map((job) => renderJobRow(job))}</div> : null}
            </div>;
          })}
          {visibleProjects.length === 0 ? <p className="lc-shell-sidebar-empty">No projects yet</p> : null}
        </section>

        <section className="lc-shell-sidebar-section">
          <div className="lc-shell-sidebar-section-title"><span>Chats</span><button onClick={startNewTask} aria-label="New chat without a project"><Plus size={14} /></button></div>
          {groupedLooseJobs.map(([label, group]) => <div className="lc-shell-recent-group" key={label}><div className="lc-shell-recent-label">{label}</div>{group.map((job) => renderJobRow(job))}</div>)}
          {looseJobs.length === 0 ? <p className="lc-shell-sidebar-empty">No chats yet</p> : null}
        </section>
      </div>

      <div className="lc-shell-sidebar-footer">
        <div className={`lc-shell-runtime-status ${runtimeOnline === false ? 'offline' : runtimeOnline === true ? 'online' : ''}`} title={runtimeOnline === false ? 'Local runtime unavailable' : 'Local runtime connected'}><i /><span>{runtimeOnline === false ? 'Runtime offline' : runtimeOnline === true ? 'Runtime connected' : 'Connecting…'}</span></div>
        <button className="lc-shell-account-row" onClick={() => openSettings()} aria-label={`${profileName} profile and settings`} data-tooltip={tooltip(profileName)}><span className="lc-shell-account-avatar">{avatar}</span><span><strong>{profileName}</strong><small>App-wide settings</small></span><ChevronDown size={14} className="lc-shell-account-chevron" /></button>
      </div>
      <div className="lc-shell-sidebar-resizer" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={320} aria-valuenow={Math.round(sidebarWidth)} tabIndex={sidebarCollapsed ? -1 : 0} onPointerDown={beginSidebarResize} onKeyDown={handleSidebarResizeKey} title="Drag to resize sidebar" />
    </aside>

    <main className="lc-shell-content-shell">
      {actionError ? <div className="lc-agent-error-banner" role="status" aria-live="polite"><span>{actionError}</span><button onClick={() => setActionError(undefined)} aria-label="Dismiss">Dismiss</button></div> : null}
      {surface === 'agent' ? <App key={agentEpoch} /> : null}
      {surface === 'projects' ? <ProjectGallery onOpenProject={runProject} /> : null}
      {surface === 'companies' ? <div className="company-manager-surface"><CompaniesSettings /></div> : null}
      {surface === 'company' && selectedCompany ? <CompanyHub company={selectedCompany} projects={projects} section={companyHubSection} onSectionChange={selectCompanySection} onOpenProject={runProject} onOpenWorkHub={openWorkHubForCompany} onCompanyChanged={() => void refreshSidebar()} /> : null}
      {surface === 'company' && !selectedCompany ? <div className="company-manager-surface"><CompaniesSettings /></div> : null}
      {surface === 'project' && selectedProject ? <ProjectDetail project={selectedProject} conversations={jobs} onBack={() => selectedCompany ? openCompany(selectedCompany, 'projects') : selectSurface('projects')} onOpenConversation={openJob} onCreated={openJob} onProjectChanged={(project) => setProjects((current) => current.map((item) => item.id === project.id ? project : item))} /> : null}
      {surface === 'project' && !selectedProject ? <ProjectGallery onOpenProject={runProject} /> : null}
      {surface === 'runs' ? <RunInspector /> : null}
      {surface === 'work-hub' ? <GlobalWorkHubLauncher tab={workHubTab} onTabChange={selectWorkHubTab} /> : null}
      {surface === 'archived' ? <ArchivedView jobs={archivedJobs} projects={archivedProjects} onOpenJob={openJob} onRestoreJob={(job) => archiveJob(job, false)} onDeleteJob={deleteJob} onRestoreProject={(project) => archiveProject(project, false)} onDeleteProject={deleteProject} /> : null}
    </main>

    {searchOpen ? <div className="global-search-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setSearchOpen(false); }}>
      <section className="global-search" role="dialog" aria-modal="true" aria-label="Search">
        <div className="global-search-input"><Search size={17} /><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search chats, projects and Companies" /><kbd>Esc</kbd></div>
        <div className="global-search-results">
          {searchResults.companies.length ? <div className="global-search-group"><span>Companies</span>{searchResults.companies.map((company) => <button key={company.id} onClick={() => { setSearchOpen(false); openCompany(company); }}><Building2 size={15} /><span><strong>{company.name}</strong><small>{company.id === 'personal' ? 'Personal context' : company.description || 'Company context'}</small></span></button>)}</div> : null}
          {searchResults.jobs.length ? <div className="global-search-group"><span>Chats</span>{searchResults.jobs.map((job) => <button key={job.id} onClick={() => openJob(job)}><MessageSquare size={15} /><span><strong>{job.input.goal}</strong><small>{relative(job.updatedAt)}</small></span></button>)}</div> : null}
          {searchResults.projects.length ? <div className="global-search-group"><span>Projects</span>{searchResults.projects.map((project) => <button key={project.id} onClick={() => runProject(project)}><Folder size={15} /><span><strong>{project.name}</strong><small>{project.companyName ?? project.workspace}</small></span></button>)}</div> : null}
          {!searchResults.companies.length && !searchResults.jobs.length && !searchResults.projects.length ? <p className="global-search-empty">No results</p> : null}
        </div>
      </section>
    </div> : null}

    <ShellDialog request={dialog} onClose={() => setDialog(undefined)} />
    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} onRunProject={(project) => { setSettingsOpen(false); runProject(project); }} />
  </div>;
}

const ARCHIVED_PAGE_SIZE = 20;

function ArchivedView(props: {
  jobs: SidebarJob[];
  projects: AdminProject[];
  onOpenJob: (job: SidebarJob) => void;
  onRestoreJob: (job: SidebarJob) => void;
  onDeleteJob: (job: SidebarJob) => void;
  onRestoreProject: (project: AdminProject) => void;
  onDeleteProject: (project: AdminProject) => void;
}) {
  const [visible, setVisible] = useState(ARCHIVED_PAGE_SIZE);
  const empty = props.jobs.length === 0 && props.projects.length === 0;
  const shown = props.jobs.slice(0, Math.min(visible, props.jobs.length));
  const remaining = props.jobs.length - shown.length;
  return <div className="archived-page">
    <h1 className="page-title">Archived</h1>
    {empty ? <p className="archived-empty">Nothing archived. Archiving a chat or a project hides it from the sidebar without deleting it.</p> : null}
    {props.projects.length ? <section className="archived-section"><h2>Projects</h2>{props.projects.map((project) => <div className="archived-row" key={project.id}><span className="archived-row-copy"><strong>{project.name}</strong><small>{project.workspace}</small></span><button className="btn-secondary" onClick={() => props.onRestoreProject(project)}><ArchiveRestore size={14} />Restore</button><button className="btn-secondary danger" onClick={() => props.onDeleteProject(project)}><Trash2 size={14} />Delete</button></div>)}</section> : null}
    {props.jobs.length ? <section className="archived-section"><h2>Chats<small>{props.jobs.length}</small></h2>{shown.map((job) => <div className="archived-row" key={job.id}><button className="archived-row-open" onClick={() => props.onOpenJob(job)} title={jobTitle(job)}><span className="archived-row-copy"><strong>{jobTitle(job)}</strong><small>Archived {relative(job.archivedAt ?? job.updatedAt)} ago</small></span></button><button className="btn-secondary" onClick={() => props.onRestoreJob(job)}><ArchiveRestore size={14} />Restore</button><button className="btn-secondary danger" onClick={() => props.onDeleteJob(job)}><Trash2 size={14} />Delete</button></div>)}{remaining > 0 ? <button className="archived-more" onClick={() => setVisible((current) => current + ARCHIVED_PAGE_SIZE)}>Show {Math.min(remaining, ARCHIVED_PAGE_SIZE)} more<small>{remaining} left</small></button> : null}</section> : null}
  </div>;
}
