import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowUp,
  CalendarClock,
  ChevronDown,
  Folder,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Settings2,
  Star,
  Trash2,
  X
} from 'lucide-react';

import type { AdminProject, ModelSelection } from './app-types.js';
import { ProjectConnectionsPanel } from './ProjectConnectionsPanel.js';
import { runProjectScheduledTask } from './project-schedule-runner.js';
import {
  PROJECT_SCHEDULES_CHANGED,
  createProjectScheduledTask,
  deleteProjectScheduledTask,
  listProjectScheduledTasks,
  updateProjectScheduledTask,
  type ProjectScheduleDraft,
  type ProjectScheduledTask
} from './project-schedules.js';

export interface ProjectConversation {
  id: string;
  status: string;
  updatedAt: string;
  title?: string;
  input: { goal: string; projectId?: string; interactionMode?: 'chat' | 'cowork' };
}

const STARRED_PROJECTS_KEY = 'local-coder.starred-projects';

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
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

function folderName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace;
}

function inheritedChatSelection(project: AdminProject): ModelSelection | undefined {
  const policy = project.connectionPolicy;
  const connectionId = policy?.chat.defaultConnectionId;
  const modelId = policy?.chat.defaultModelId;
  if (connectionId && modelId) return { mode: 'explicit', providerId: connectionId, modelId };
  if (project.defaultModel.mode === 'explicit') return project.defaultModel;
  if (project.defaultModel.mode === 'local-first') {
    return { mode: 'explicit', providerId: 'ollama', modelId: project.defaultModel.modelId };
  }
  return undefined;
}

function storedStarredIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STARRED_PROJECTS_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function isStarred(projectId: string): boolean {
  return storedStarredIds().includes(projectId);
}

function blankSchedule(): ProjectScheduleDraft {
  return { name: '', prompt: '', frequency: 'weekly', time: '09:00', weekday: 1, enabled: true };
}

function scheduleLabel(task: ProjectScheduledTask): string {
  if (!task.enabled) return 'Paused';
  if (task.frequency === 'manual') return 'Manual';
  if (task.frequency === 'hourly') return 'Every hour';
  const time = task.time ?? '09:00';
  if (task.frequency === 'daily') return `Daily at ${time}`;
  if (task.frequency === 'weekdays') return `Weekdays at ${time}`;
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][task.weekday ?? 1];
  return `${day} at ${time}`;
}

function nextRunLabel(task: ProjectScheduledTask): string {
  if (task.lastError) return `Last run failed: ${task.lastError}`;
  if (!task.enabled) return 'Paused';
  if (!task.nextRunAt) return 'Run on demand';
  return `Next ${new Date(task.nextRunAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

export function ProjectDetail(props: {
  project: AdminProject;
  conversations: ProjectConversation[];
  onBack: () => void;
  onOpenConversation: (job: ProjectConversation) => void;
  onCreated: (job: ProjectConversation) => void;
  onProjectChanged: (project: AdminProject) => void;
}) {
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState<'chat' | 'cowork'>('chat');
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [instructions, setInstructions] = useState(props.project.instructions ?? '');
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [projectName, setProjectName] = useState(props.project.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [starred, setStarred] = useState(() => isStarred(props.project.id));
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ProjectScheduledTask>();
  const [scheduleDraft, setScheduleDraft] = useState<ProjectScheduleDraft>(blankSchedule);
  const [scheduledTasks, setScheduledTasks] = useState<ProjectScheduledTask[]>(() => listProjectScheduledTasks(props.project.id));
  const [runningScheduleId, setRunningScheduleId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const conversations = useMemo(() => props.conversations
    .filter((job) => job.input.projectId === props.project.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [props.conversations, props.project.id]);

  useEffect(() => {
    setInstructions(props.project.instructions ?? '');
    setProjectName(props.project.name);
    setStarred(isStarred(props.project.id));
    setScheduledTasks(listProjectScheduledTasks(props.project.id));
    setMenuOpen(false);
    setConnectionsOpen(false);
    setRenameOpen(false);
    setDeleteOpen(false);
    setScheduleOpen(false);
  }, [props.project.id]);

  useEffect(() => {
    const refresh = () => setScheduledTasks(listProjectScheduledTasks(props.project.id));
    window.addEventListener(PROJECT_SCHEDULES_CHANGED, refresh);
    return () => window.removeEventListener(PROJECT_SCHEDULES_CHANGED, refresh);
  }, [props.project.id]);

  const chatSelection = inheritedChatSelection(props.project);
  const companyLabel = props.project.companyName ?? props.project.organizationName ?? props.project.companyId ?? props.project.organizationId ?? 'Personal';
  const companyId = props.project.companyId || props.project.organizationId || 'personal';
  const modelLabel = mode === 'chat'
    ? props.project.connectionPolicy?.chat.defaultModelId
      ?? (chatSelection?.mode === 'explicit' ? chatSelection.modelId : 'Choose model')
    : props.project.defaultModel.mode === 'explicit'
      ? props.project.defaultModel.modelId
      : props.project.defaultModel.mode === 'local-first' ? props.project.defaultModel.modelId : 'Auto';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim() || busy) return;
    if (mode === 'cowork' && !props.project.workspace) {
      setError('Choose a Context folder before starting Cowork.');
      return;
    }
    if (mode === 'chat' && !chatSelection) {
      setError('Choose a default Chat connection and model for this project first.');
      setConnectionsOpen(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { job } = await api<{ job: ProjectConversation }>('/api/jobs', {
        method: 'POST',
        body: {
          projectId: props.project.id,
          goal: goal.trim(),
          interactionMode: mode,
          maxRepairRounds: 1,
          reasoningEffort: 'auto',
          modelSelection: mode === 'chat' ? chatSelection : props.project.defaultModel
        }
      });
      setGoal('');
      props.onCreated(job);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  function cancelInstructions() {
    setInstructions(props.project.instructions ?? '');
    setInstructionsOpen(false);
  }

  async function saveInstructions() {
    setBusy(true);
    setError(undefined);
    try {
      const { project } = await api<{ project: AdminProject }>(`/api/projects/${encodeURIComponent(props.project.id)}`, {
        method: 'PATCH', body: { instructions }
      });
      props.onProjectChanged(project);
      window.dispatchEvent(new CustomEvent('local-coder:projects-changed'));
      setInstructions(project.instructions ?? '');
      setInstructionsOpen(false);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  async function chooseProjectFolder() {
    if (busy) return;
    if (!window.lc) {
      setError('Choosing Context is available in the Axis desktop app.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const selected = await window.lc.pickDirectory(props.project.workspace || undefined);
      if (!selected) return;
      const { project } = await api<{ project: AdminProject }>(`/api/projects/${encodeURIComponent(props.project.id)}`, {
        method: 'PATCH', body: { workspace: selected }
      });
      props.onProjectChanged(project);
      window.dispatchEvent(new CustomEvent('local-coder:projects-changed'));
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  function toggleStar() {
    const ids = storedStarredIds();
    const nextStarred = !starred;
    const next = nextStarred ? [...new Set([...ids, props.project.id])] : ids.filter((id) => id !== props.project.id);
    localStorage.setItem(STARRED_PROJECTS_KEY, JSON.stringify(next));
    setStarred(nextStarred);
    window.dispatchEvent(new CustomEvent('local-coder:starred-projects-changed'));
  }

  function openSchedule(task?: ProjectScheduledTask) {
    setEditingSchedule(task);
    setScheduleDraft(task ? {
      name: task.name,
      prompt: task.prompt,
      frequency: task.frequency,
      time: task.time ?? '09:00',
      weekday: task.weekday ?? 1,
      enabled: task.enabled
    } : blankSchedule());
    setScheduleOpen(true);
    setError(undefined);
  }

  function saveSchedule(event: FormEvent) {
    event.preventDefault();
    try {
      if (editingSchedule) updateProjectScheduledTask(editingSchedule.id, scheduleDraft);
      else createProjectScheduledTask(props.project, scheduleDraft);
      setScheduledTasks(listProjectScheduledTasks(props.project.id));
      setScheduleOpen(false);
      setEditingSchedule(undefined);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    }
  }

  async function runSchedule(task: ProjectScheduledTask) {
    setRunningScheduleId(task.id);
    setError(undefined);
    try {
      await runProjectScheduledTask(task.id);
      setScheduledTasks(listProjectScheduledTasks(props.project.id));
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setRunningScheduleId(undefined);
    }
  }

  function toggleScheduleEnabled(task: ProjectScheduledTask) {
    updateProjectScheduledTask(task.id, {
      name: task.name,
      prompt: task.prompt,
      frequency: task.frequency,
      time: task.time,
      weekday: task.weekday,
      enabled: !task.enabled
    });
    setScheduledTasks(listProjectScheduledTasks(props.project.id));
    setScheduleOpen(false);
  }

  function removeSchedule(task: ProjectScheduledTask) {
    deleteProjectScheduledTask(task.id);
    setScheduledTasks(listProjectScheduledTasks(props.project.id));
    setScheduleOpen(false);
    setEditingSchedule(undefined);
  }

  async function renameProject(event: FormEvent) {
    event.preventDefault();
    const nextName = projectName.trim();
    if (!nextName || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { project } = await api<{ project: AdminProject }>(`/api/projects/${encodeURIComponent(props.project.id)}`, {
        method: 'PATCH', body: { name: nextName }
      });
      props.onProjectChanged(project);
      window.dispatchEvent(new CustomEvent('local-coder:projects-changed'));
      setRenameOpen(false);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  async function archiveProject() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/projects/${encodeURIComponent(props.project.id)}/archive`, { method: 'POST', body: { archived: true } });
      window.dispatchEvent(new CustomEvent('local-coder:projects-changed'));
      props.onBack();
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/projects/${encodeURIComponent(props.project.id)}`, { method: 'DELETE' });
      localStorage.setItem(STARRED_PROJECTS_KEY, JSON.stringify(storedStarredIds().filter((id) => id !== props.project.id)));
      for (const task of scheduledTasks) deleteProjectScheduledTask(task.id);
      window.dispatchEvent(new CustomEvent('local-coder:projects-changed'));
      window.dispatchEvent(new CustomEvent('local-coder:starred-projects-changed'));
      props.onBack();
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return <section className="project-detail-page" data-company-id={companyId}>
    <button className="project-detail-breadcrumb" onClick={props.onBack}><ArrowLeft size={13} /> All projects</button>
    <header className="project-detail-header">
      <h1>{props.project.name}</h1>
      <div className="lc-shell-sort-anchor">
        <button aria-label={starred ? 'Remove project from favorites' : 'Favorite project'} aria-pressed={starred} onClick={toggleStar} title={starred ? 'Remove from favorites' : 'Favorite project'}><Star size={18} fill={starred ? 'currentColor' : 'none'} /></button>
        <button aria-label="More project options" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={19} /></button>
        {menuOpen ? <div className="lc-shell-row-menu" role="menu" aria-label={`Actions for ${props.project.name}`}>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setProjectName(props.project.name); setRenameOpen(true); }}>Rename…<Pencil size={16} /></button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setConnectionsOpen(true); }}>Model & connections<Settings2 size={16} /></button>
          <div className="lc-shell-row-menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void archiveProject(); }}>Archive<Archive size={16} /></button>
          <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); setDeleteOpen(true); }}>Delete…<Trash2 size={16} /></button>
        </div> : null}
      </div>
    </header>

    <div className="project-detail-layout">
      <main>
        <form className="project-detail-composer" onSubmit={(event) => void submit(event)}>
          <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={`Ask about ${props.project.name}…`} aria-label="Project prompt" />
          <div className="project-detail-composer-bar">
            <button className="project-detail-plus" type="button" aria-label="Add Context" title="Add Context" onClick={() => void chooseProjectFolder()}><Plus size={18} /></button>
            <div className="project-detail-mode" aria-label="Project mode">
              <button type="button" className={mode === 'chat' ? 'active' : ''} aria-pressed={mode === 'chat'} onClick={() => setMode('chat')}>Chat</button>
              <button type="button" className={mode === 'cowork' ? 'active' : ''} aria-pressed={mode === 'cowork'} onClick={() => setMode('cowork')}>Cowork</button>
            </div>
            <button className="project-detail-model" type="button" title={`${companyLabel} · ${modelLabel}`} onClick={() => setConnectionsOpen(true)}>{modelLabel} <ChevronDown size={13} /></button>
            <button className="project-detail-send" disabled={!goal.trim() || busy} aria-label="Send"><ArrowUp size={17} /></button>
          </div>
        </form>
        {error ? <div className="lc-shell-inline-error project-detail-error" role="status">{error}</div> : null}
        <section className="project-detail-recent">
          <h2>Recent</h2>
          {conversations.slice(0, 12).map((job) => <button key={job.id} onClick={() => props.onOpenConversation(job)}>
            <span><strong>{job.title?.trim() || job.input.goal}</strong><small>{job.input.interactionMode === 'cowork' ? 'Cowork' : 'Chat'} · {job.input.goal}</small></span><time>{relative(job.updatedAt)}</time>
          </button>)}
          {conversations.length === 0 ? <p>No chats in this project yet.</p> : null}
        </section>
      </main>

      <aside className="project-detail-panel">
        <section className="project-detail-instructions">
          <header><h2>Instructions</h2><button aria-label="Edit instructions" onClick={() => { setInstructions(props.project.instructions ?? ''); setInstructionsOpen(true); }}><Pencil size={15} /></button></header>
          {instructionsOpen ? <div className="project-detail-instruction-editor"><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} autoFocus /><div><button onClick={cancelInstructions}>Cancel</button><button onClick={() => void saveInstructions()} disabled={busy}>Save</button></div></div> : <p>{props.project.instructions || 'Add instructions that should apply to every conversation in this project.'}</p>}
        </section>

        <section className="project-detail-context project-detail-scheduled">
          <header><h2>Scheduled</h2><span><button aria-label="Add scheduled task" title="Add scheduled task" onClick={() => openSchedule()}><Plus size={17} /></button></span></header>
          {scheduledTasks.length ? scheduledTasks.slice(0, 4).map((task) => <button className="project-detail-folder-card" key={task.id} onClick={() => openSchedule(task)}>
            <strong>{task.name}</strong><small>{scheduleLabel(task)} · {nextRunLabel(task)}</small><CalendarClock size={17} />
          </button>) : <p>Schedule recurring or on-demand work for this project.</p>}
        </section>

        <section className="project-detail-context">
          <header><h2>Context</h2><span><button aria-label="Choose Context folder" title="Choose Context folder" onClick={() => void chooseProjectFolder()}><Plus size={17} /></button></span></header>
          {props.project.workspace ? <><div className="project-detail-folder-card"><strong>{folderName(props.project.workspace)}</strong><small>Project folder · {companyLabel}</small><Folder size={17} /></div><p>Chat reads bounded project context. Cowork may inspect, edit and validate this folder within the Project boundary.</p></> : <p>Add the local folder that should provide shared context for this project.</p>}
        </section>

        <section className="project-detail-context project-detail-memory">
          <header><h2>Memory</h2></header>
          <div className="project-detail-context-meter"><i /><span>{props.project.workspace ? 'Enabled for this project' : 'Waiting for Context'}</span></div>
          <p>{props.project.workspace ? `Axis retains scoped project handoffs for ${props.project.name} and reuses them across authorized Chat and Cowork sessions.` : 'Add Context so Memory can bind to an exact project root without crossing Company or Project boundaries.'}</p>
        </section>
      </aside>
    </div>

    {scheduleOpen ? <div className="lc-shell-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setScheduleOpen(false); }}>
      <form className="lc-shell-project-modal" onSubmit={saveSchedule}>
        <div className="lc-shell-modal-title"><h2 className="dialog-title">{editingSchedule ? 'Edit scheduled task' : 'Schedule a task'}</h2><button type="button" onClick={() => setScheduleOpen(false)} aria-label="Close"><X size={18} /></button></div>
        <label><span>Name</span><input value={scheduleDraft.name} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, name: event.target.value }))} autoFocus required placeholder="Weekly project review" /></label>
        <label><span>Prompt</span><textarea rows={5} value={scheduleDraft.prompt} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, prompt: event.target.value }))} required placeholder="What should Axis do each time this task runs?" /></label>
        <label><span>Frequency</span><select value={scheduleDraft.frequency} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, frequency: event.target.value as ProjectScheduleDraft['frequency'] }))}>
          <option value="manual">Manually</option><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option>
        </select></label>
        {['daily', 'weekdays', 'weekly'].includes(scheduleDraft.frequency) ? <label><span>Time</span><input type="time" value={scheduleDraft.time ?? '09:00'} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, time: event.target.value }))} required /></label> : null}
        {scheduleDraft.frequency === 'weekly' ? <label><span>Day</span><select value={scheduleDraft.weekday ?? 1} onChange={(event) => setScheduleDraft((draft) => ({ ...draft, weekday: Number(event.target.value) }))}>
          <option value={1}>Monday</option><option value={2}>Tuesday</option><option value={3}>Wednesday</option><option value={4}>Thursday</option><option value={5}>Friday</option><option value={6}>Saturday</option><option value={0}>Sunday</option>
        </select></label> : null}
        <small>Runs as a real Project conversation using this Project's model, permissions, connections and Context. Local schedules run while Axis is open; overdue work is picked up on the next launch.</small>
        {editingSchedule ? <div className="lc-shell-modal-actions">
          <button className="btn-secondary danger" type="button" onClick={() => removeSchedule(editingSchedule)}><Trash2 size={14} /> Delete</button>
          <button className="btn-secondary" type="button" onClick={() => toggleScheduleEnabled(editingSchedule)}>{editingSchedule.enabled ? <Pause size={14} /> : <Play size={14} />} {editingSchedule.enabled ? 'Pause' : 'Resume'}</button>
          <button className="btn-secondary" type="button" onClick={() => void runSchedule(editingSchedule)} disabled={runningScheduleId === editingSchedule.id}><Play size={14} /> {runningScheduleId === editingSchedule.id ? 'Starting…' : 'Run now'}</button>
        </div> : null}
        {error ? <div className="lc-shell-inline-error lc-shell-modal-error">{error}</div> : null}
        <div className="lc-shell-modal-actions"><button className="btn-secondary" type="button" onClick={() => setScheduleOpen(false)}>Cancel</button><button className="lc-shell-primary-button btn-primary" type="submit">{editingSchedule ? 'Save' : 'Create task'}</button></div>
      </form>
    </div> : null}

    {renameOpen ? <div className="lc-shell-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setRenameOpen(false); }}>
      <form className="lc-shell-project-modal" onSubmit={(event) => void renameProject(event)}>
        <div className="lc-shell-modal-title"><h2 className="dialog-title">Rename project</h2><button type="button" onClick={() => setRenameOpen(false)} aria-label="Close"><X size={18} /></button></div>
        <label><span>Name</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} autoFocus required /></label>
        <div className="lc-shell-modal-actions"><button className="btn-secondary" type="button" onClick={() => setRenameOpen(false)}>Cancel</button><button className="lc-shell-primary-button btn-primary" disabled={busy || !projectName.trim()}>{busy ? 'Saving…' : 'Rename'}</button></div>
      </form>
    </div> : null}

    {deleteOpen ? <div className="lc-shell-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setDeleteOpen(false); }}>
      <section className="lc-shell-project-modal" role="dialog" aria-modal="true" aria-label="Delete project">
        <div className="lc-shell-modal-title"><h2 className="dialog-title">Delete project</h2><button type="button" onClick={() => setDeleteOpen(false)} aria-label="Close"><X size={18} /></button></div>
        <p>“{props.project.name}” will be permanently deleted. Projects that still contain chats cannot be deleted.</p>
        <div className="lc-shell-modal-actions"><button className="btn-secondary" type="button" onClick={() => setDeleteOpen(false)}>Cancel</button><button className="btn-secondary danger" type="button" onClick={() => void deleteProject()} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button></div>
      </section>
    </div> : null}

    {connectionsOpen ? <div className="lc-shell-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConnectionsOpen(false); }}>
      <section className="lc-shell-project-modal" role="dialog" aria-modal="true" aria-label="Project model and connections">
        <div className="lc-shell-modal-title"><h2 className="dialog-title">Model & connections</h2><button type="button" onClick={() => setConnectionsOpen(false)} aria-label="Close"><X size={18} /></button></div>
        <ProjectConnectionsPanel project={props.project} onProjectChanged={(project) => props.onProjectChanged(project)} />
      </section>
    </div> : null}
  </section>;
}
