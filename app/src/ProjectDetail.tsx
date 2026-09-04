import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Archive,
  ArrowUp,
  ChevronDown,
  Folder,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Trash2,
  X
} from 'lucide-react';

import type { AdminProject, ModelSelection } from './app-types.js';
import { ProjectConnectionsPanel } from './ProjectConnectionsPanel.js';
import { ProjectGitReview } from './ProjectGitReview.js';

export interface ProjectConversation {
  id: string;
  status: string;
  updatedAt: string;
  title?: string;
  input: { goal: string; projectId?: string; interactionMode?: 'chat' | 'cowork' };
}

const PINNED_PROJECTS_KEY = 'local-coder.pinned-projects';

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
  const hours = Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000);
  if (hours < 1) return 'now';
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

function projectInitiallyPinned(projectId: string): boolean {
  try {
    const value = JSON.parse(localStorage.getItem(PINNED_PROJECTS_KEY) ?? '[]') as unknown;
    return Array.isArray(value) && value.includes(projectId);
  } catch {
    return false;
  }
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pinned, setPinned] = useState(() => projectInitiallyPinned(props.project.id));
  const [menuOpen, setMenuOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [projectName, setProjectName] = useState(props.project.name);
  const conversations = useMemo(() => props.conversations
    .filter((job) => job.input.projectId === props.project.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [props.conversations, props.project.id]);

  useEffect(() => {
    setInstructions(props.project.instructions ?? '');
    setProjectName(props.project.name);
    setPinned(projectInitiallyPinned(props.project.id));
    setMenuOpen(false);
    setConnectionsOpen(false);
    setRenameOpen(false);
    setDeleteOpen(false);
    setError(undefined);
  }, [props.project.id]);

  const chatSelection = inheritedChatSelection(props.project);
  const companyLabel = props.project.companyName ?? props.project.companyId;
  const modelLabel = mode === 'chat'
    ? props.project.connectionPolicy?.chat.defaultConnectionId ?? (chatSelection?.mode === 'explicit' ? chatSelection.providerId : 'Auto')
    : props.project.defaultModel.mode === 'explicit'
      ? props.project.defaultModel.providerId
      : props.project.defaultModel.mode === 'local-first' ? 'Local-first' : 'Auto';

  function togglePin() {
    const nextPinned = !pinned;
    setPinned(nextPinned);
    let ids: string[] = [];
    try {
      const value = JSON.parse(localStorage.getItem(PINNED_PROJECTS_KEY) ?? '[]') as unknown;
      ids = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch { /* reset malformed local preference */ }
    const next = new Set(ids);
    if (nextPinned) next.add(props.project.id); else next.delete(props.project.id);
    localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify([...next]));
    window.dispatchEvent(new CustomEvent('local-coder:pins-changed'));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim() || busy) return;
    if (mode === 'cowork' && !props.project.workspace) {
      setError('Choose a folder for this project before starting Cowork.');
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
      setError('Choosing a project folder is available in the Axis desktop app.');
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

  async function renameProject(event: FormEvent) {
    event.preventDefault();
    const name = projectName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { project } = await api<{ project: AdminProject }>(`/api/projects/${encodeURIComponent(props.project.id)}`, {
        method: 'PATCH', body: { name }
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
      await api(`/api/projects/${encodeURIComponent(props.project.id)}/archive`, {
        method: 'POST', body: { archived: true }
      });
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
      const next = new Set(JSON.parse(localStorage.getItem(PINNED_PROJECTS_KEY) ?? '[]') as string[]);
      next.delete(props.project.id);
      localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify([...next]));
      window.dispatchEvent(new CustomEvent('local-coder:pins-changed'));
      window.dispatchEvent(new CustomEvent('local-coder:projects-changed'));
      props.onBack();
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return <section className="project-detail-page" data-company-id={props.project.companyId}>
    <button className="project-detail-breadcrumb" onClick={props.onBack}>Projects <span>/</span> <strong>{companyLabel}</strong> <span>/</span> <strong>{props.project.name}</strong></button>
    <header className="project-detail-header">
      <h1><Folder size={29} />{props.project.name}</h1>
      <div className="lc-shell-sort-anchor">
        <button aria-label={pinned ? 'Unpin project' : 'Pin project'} aria-pressed={pinned} title={pinned ? 'Unpin project' : 'Pin project'} onClick={togglePin}>{pinned ? <PinOff size={17} /> : <Pin size={17} />}</button>
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
          <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={mode === 'chat' ? `Ask about ${props.project.name}…` : `Ask Cowork to change ${props.project.name}…`} aria-label="Project prompt" />
          <div className="project-detail-composer-bar">
            <button className="project-detail-plus" type="button" aria-label="Choose project folder" title="Choose project folder" onClick={() => void chooseProjectFolder()}><Plus size={18} /></button>
            <div className="project-detail-mode" aria-label="Project mode"><button type="button" className={mode === 'chat' ? 'active' : ''} aria-pressed={mode === 'chat'} onClick={() => setMode('chat')}>Chat</button><button type="button" className={mode === 'cowork' ? 'active' : ''} aria-pressed={mode === 'cowork'} onClick={() => setMode('cowork')}>Cowork</button></div>
            <button className="project-detail-model" type="button" title={`${companyLabel} · ${modelLabel}`} onClick={() => setConnectionsOpen(true)}>{modelLabel} <ChevronDown size={13} /></button>
            <button className="project-detail-send" disabled={!goal.trim() || busy} aria-label="Send"><ArrowUp size={17} /></button>
          </div>
        </form>
        {error ? <div className="lc-shell-inline-error project-detail-error" role="status">{error}</div> : null}
        <section className="project-detail-recent">
          <h2>Recent</h2>
          {conversations.slice(0, 8).map((job) => <button key={job.id} onClick={() => props.onOpenConversation(job)}>
            <span><strong>{job.title?.trim() || job.input.goal}</strong><small>{job.input.interactionMode === 'cowork' ? 'Cowork' : 'Chat'} · {job.input.goal}</small></span><time>{relative(job.updatedAt)}</time>
          </button>)}
          {conversations.length === 0 ? <p>No conversations in this project yet.</p> : null}
        </section>
        <ProjectGitReview project={props.project} />
      </main>

      <aside className="project-detail-panel">
        <section className="project-detail-instructions">
          <header><h2>Instructions</h2><button aria-label="Edit instructions" onClick={() => { setInstructions(props.project.instructions ?? ''); setInstructionsOpen(true); }}><Pencil size={15} /></button></header>
          {instructionsOpen ? <div className="project-detail-instruction-editor"><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} autoFocus /><div><button onClick={cancelInstructions}>Cancel</button><button onClick={() => void saveInstructions()} disabled={busy}>Save</button></div></div> : <p>{props.project.instructions || 'Add instructions that should apply to every conversation in this project.'}</p>}
        </section>
        <section className="project-detail-context">
          <header><h2>Context</h2><span><button aria-label="Choose project folder" title="Choose project folder" onClick={() => void chooseProjectFolder()}><Plus size={17} /></button></span></header>
          <div className="project-detail-context-meter"><i /><span>{props.project.workspace ? 'Project folder connected' : 'No project folder connected'}</span></div>
          {props.project.workspace ? <><div className="project-detail-folder-card"><strong>{folderName(props.project.workspace)}</strong><small>1 folder · {companyLabel}</small><Folder size={17} /></div><p>Chat can read bounded repository context from this folder. Cowork can inspect, edit and validate it.</p></> : <p>Add a folder to give this Project bounded repository context.</p>}
        </section>
      </aside>
    </div>

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
        <p>“{props.project.name}” will be permanently deleted. A Project that still contains conversations cannot be deleted.</p>
        <div className="lc-shell-modal-actions"><button className="btn-secondary" type="button" onClick={() => setDeleteOpen(false)}>Cancel</button><button className="btn-secondary danger" type="button" onClick={() => void deleteProject()} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button></div>
      </section>
    </div> : null}

    {connectionsOpen ? <div className="lc-shell-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConnectionsOpen(false); }}>
      <section className="lc-shell-project-modal" role="dialog" aria-modal="true" aria-label="Project model and connections">
        <div className="lc-shell-modal-title"><h2 className="dialog-title">Model & connections</h2><button type="button" onClick={() => setConnectionsOpen(false)} aria-label="Close"><X size={18} /></button></div>
        <div className="global-search-results"><ProjectConnectionsPanel project={props.project} onProjectChanged={props.onProjectChanged} /></div>
      </section>
    </div> : null}
  </section>;
}
