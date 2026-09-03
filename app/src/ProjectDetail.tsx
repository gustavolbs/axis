import { useMemo, useState, type FormEvent } from 'react';
import { ArrowUp, ChevronDown, Folder, MoreHorizontal, Pencil, Pin, Plus, Search } from 'lucide-react';

import type { AdminProject, ModelSelection } from './app-types.js';
import { ProjectConnectionsPanel } from './ProjectConnectionsPanel.js';

export interface ProjectConversation {
  id: string;
  status: string;
  updatedAt: string;
  title?: string;
  input: { goal: string; projectId?: string; interactionMode?: 'chat' | 'cowork' };
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
  const conversations = useMemo(() => props.conversations
    .filter((job) => job.input.projectId === props.project.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [props.conversations, props.project.id]);

  const chatSelection = inheritedChatSelection(props.project);
  const companyLabel = props.project.companyName ?? props.project.companyId;
  const modelLabel = mode === 'chat'
    ? props.project.connectionPolicy?.chat.defaultConnectionId ?? (chatSelection?.mode === 'explicit' ? chatSelection.providerId : 'Auto')
    : props.project.defaultModel.mode === 'explicit'
      ? props.project.defaultModel.providerId
      : props.project.defaultModel.mode === 'local-first' ? 'Local-first' : 'Auto';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim() || busy) return;
    if (mode === 'cowork' && !props.project.workspace) {
      setError('Choose a folder for this project before starting Cowork.');
      return;
    }
    if (mode === 'chat' && !chatSelection) {
      setError('Configure a default Chat connection and model for this Project first.');
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
      props.onCreated(job);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
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
      setInstructionsOpen(false);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  return <section className="project-detail-page" data-company-id={props.project.companyId}>
    <button className="project-detail-breadcrumb" onClick={props.onBack}>Projects <span>/</span> <strong>{companyLabel}</strong> <span>/</span> <strong>{props.project.name}</strong></button>
    <header className="project-detail-header">
      <h1><Folder size={29} />{props.project.name}</h1>
      <div><button aria-label="Pin project"><Pin size={17} /></button><button aria-label="More project options"><MoreHorizontal size={19} /></button></div>
    </header>

    <div className="project-detail-layout">
      <main>
        <form className="project-detail-composer" onSubmit={(event) => void submit(event)}>
          <textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={mode === 'chat' ? `Ask about ${props.project.name}…` : `Ask Cowork to change ${props.project.name}…`} aria-label="Project prompt" />
          <div className="project-detail-composer-bar">
            <button className="project-detail-plus" type="button" aria-label="Add context"><Plus size={18} /></button>
            <div className="project-detail-mode"><button type="button" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>Chat</button><button type="button" className={mode === 'cowork' ? 'active' : ''} onClick={() => setMode('cowork')}>Cowork</button></div>
            <span className="project-detail-model" title={`${companyLabel} · ${modelLabel}`}>{modelLabel} <ChevronDown size={13} /></span>
            <button className="project-detail-send" disabled={!goal.trim() || busy} aria-label="Send"><ArrowUp size={17} /></button>
          </div>
        </form>
        {error ? <div className="lc-shell-inline-error project-detail-error">{error}</div> : null}
        <section className="project-detail-recent">
          <h2>Recent</h2>
          {conversations.slice(0, 8).map((job) => <button key={job.id} onClick={() => props.onOpenConversation(job)}>
            <span><strong>{job.title?.trim() || job.input.goal}</strong><small>{job.input.interactionMode === 'cowork' ? 'Cowork' : 'Chat'} · {job.input.goal}</small></span><time>{relative(job.updatedAt)}</time>
          </button>)}
          {conversations.length === 0 ? <p>No conversations in this project yet.</p> : null}
        </section>
      </main>

      <aside className="project-detail-panel">
        <section className="project-detail-instructions">
          <header><h2>Instructions</h2><button aria-label="Edit instructions" onClick={() => setInstructionsOpen(true)}><Pencil size={15} /></button></header>
          {instructionsOpen ? <div className="project-detail-instruction-editor"><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} autoFocus /><div><button onClick={() => setInstructionsOpen(false)}>Cancel</button><button onClick={() => void saveInstructions()} disabled={busy}>Save</button></div></div> : <p>{props.project.instructions || 'Add instructions that should apply to every conversation in this project.'}</p>}
        </section>
        <ProjectConnectionsPanel project={props.project} onProjectChanged={props.onProjectChanged} />
        <section className="project-detail-context">
          <header><h2>Context</h2><span><button aria-label="Search context"><Search size={16} /></button><button aria-label="Add context"><Plus size={17} /></button></span></header>
          <div className="project-detail-context-meter"><i /><span>{props.project.workspace ? 'Project folder connected' : 'No project folder connected'}</span></div>
          {props.project.workspace ? <><div className="project-detail-folder-card"><strong>{folderName(props.project.workspace)}</strong><small>1 folder · {companyLabel}</small><Folder size={17} /></div><p>Chat can read bounded repository context from this folder. Cowork can inspect, edit and validate it.</p></> : null}
        </section>
        <section className="project-detail-scheduled">
          <header><h2>Scheduled</h2><button aria-label="Add scheduled task"><Plus size={17} /></button></header>
          <p>Configure recurring tasks for this project.</p>
        </section>
      </aside>
    </div>
  </section>;
}
