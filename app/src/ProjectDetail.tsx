import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  Archive,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderGit2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X,
  Zap
} from 'lucide-react';

import type { AdminProject, ModelSelection, ProjectConnectionPolicy } from './app-types.js';
import { ProjectGitReview } from './ProjectGitReview.js';

export interface ProjectConversation {
  id: string;
  status: string;
  updatedAt: string;
  title?: string;
  input: { goal: string; projectId?: string; interactionMode?: 'chat' | 'cowork' };
}

interface CatalogModel {
  id: string;
  displayName: string;
  available: boolean;
}

interface CatalogProvider {
  id: string;
  label?: string;
  providerFamily?: 'ollama' | 'anthropic' | 'openai';
  auth?: 'local' | 'api-key' | 'claude-account' | 'chatgpt-account';
  organizationLabel?: string;
  kind: 'local' | 'cloud';
  ready: boolean;
  reason?: string;
  models: CatalogModel[];
}

interface ProjectCatalog {
  defaultModel: ModelSelection;
  chatDefaultModel?: ModelSelection;
  coworkDefaultModel?: ModelSelection;
  connectionPolicy?: ProjectConnectionPolicy;
  providers: CatalogProvider[];
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

function pinnedProjectIds(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PINNED_PROJECTS_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function projectInitiallyPinned(projectId: string): boolean {
  return pinnedProjectIds().includes(projectId);
}

function providerFallbackLabel(providerId: string): string {
  if (providerId === 'anthropic') return 'Claude';
  if (providerId === 'openai') return 'GPT';
  if (providerId === 'ollama') return 'Ollama';
  return providerId
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function providerAuthLabel(provider: CatalogProvider): string {
  if (provider.auth === 'api-key') return 'API key';
  if (provider.auth === 'claude-account') return 'Claude account';
  if (provider.auth === 'chatgpt-account') return 'ChatGPT account';
  if (provider.auth === 'local' || provider.kind === 'local') return 'Local';
  return 'Provider';
}

function providerDescription(provider: CatalogProvider): string {
  if (provider.auth === 'local' || provider.kind === 'local') return 'Local model · stays on this computer';
  if (provider.auth === 'api-key') return 'API key · provider model list updates live';
  if (provider.auth === 'claude-account') return `Claude subscription${provider.organizationLabel ? ` · ${provider.organizationLabel}` : ''} · uses your CLI account`;
  if (provider.auth === 'chatgpt-account') return `ChatGPT subscription${provider.organizationLabel ? ` · ${provider.organizationLabel}` : ''} · uses your CLI account`;
  return `Use the selected ${provider.label ?? providerFallbackLabel(provider.id)} model directly`;
}

function selectionProviderId(selection: ModelSelection): string | undefined {
  if (selection.mode === 'explicit') return selection.providerId;
  if (selection.mode === 'local-first') return 'ollama';
  return undefined;
}

function projectCatalogProviderAllowed(
  catalog: ProjectCatalog,
  providerId: string,
  mode: 'chat' | 'cowork'
): boolean {
  const policy = catalog.connectionPolicy;
  if (!policy) return true;
  const allowed = mode === 'chat'
    ? policy.chat.allowedConnectionIds
    : policy.inference.allowedConnectionIds;
  return allowed.includes(providerId);
}

function catalogHasSelection(
  catalog: ProjectCatalog,
  selection: ModelSelection,
  mode: 'chat' | 'cowork'
): boolean {
  const providerId = selectionProviderId(selection);
  if (!providerId || selection.mode === 'auto' || !projectCatalogProviderAllowed(catalog, providerId, mode)) return false;
  const provider = catalog.providers.find((item) => item.id === providerId && item.ready);
  return Boolean(provider?.models.some((model) => model.id === selection.modelId && model.available));
}

function firstCatalogSelection(catalog: ProjectCatalog, mode: 'chat' | 'cowork'): ModelSelection {
  const scopedDefault = mode === 'chat' ? catalog.chatDefaultModel : catalog.coworkDefaultModel;
  const configured = scopedDefault ?? catalog.defaultModel;
  if (configured.mode !== 'auto' && catalogHasSelection(catalog, configured, mode)) return configured;
  const local = catalog.providers.find((provider) =>
    provider.id === 'ollama' && provider.ready && projectCatalogProviderAllowed(catalog, provider.id, mode)
  )?.models.find((model) => model.available);
  if (local) return mode === 'chat'
    ? { mode: 'explicit', providerId: 'ollama', modelId: local.id }
    : { mode: 'local-first', modelId: local.id };
  for (const provider of catalog.providers) {
    if (!projectCatalogProviderAllowed(catalog, provider.id, mode)) continue;
    const model = provider.ready ? provider.models.find((candidate) => candidate.available) : undefined;
    if (model) return { mode: 'explicit', providerId: provider.id, modelId: model.id };
  }
  return { mode: 'auto' };
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
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [projectName, setProjectName] = useState(props.project.name);
  const [catalog, setCatalog] = useState<ProjectCatalog>();
  const [catalogRefreshNonce, setCatalogRefreshNonce] = useState(0);
  const [modelSelection, setModelSelection] = useState<ModelSelection>({ mode: 'auto' });
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuProvider, setModelMenuProvider] = useState<string>();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const conversations = useMemo(() => props.conversations
    .filter((job) => job.input.projectId === props.project.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [props.conversations, props.project.id]);

  useEffect(() => {
    setGoal('');
    setMode('chat');
    setInstructions(props.project.instructions ?? '');
    setProjectName(props.project.name);
    setPinned(projectInitiallyPinned(props.project.id));
    setMenuOpen(false);
    setRenameOpen(false);
    setDeleteOpen(false);
    setModelSelection({ mode: 'auto' });
    setModelMenuOpen(false);
    setModelMenuProvider(undefined);
    setError(undefined);
  }, [props.project.id]);

  useEffect(() => {
    const element = promptRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, Math.min(320, window.innerHeight * 0.4))}px`;
  }, [goal]);

  useEffect(() => {
    let cancelled = false;
    void api<{ catalog: ProjectCatalog }>(`/api/projects/${encodeURIComponent(props.project.id)}/catalog`)
      .then(({ catalog: next }) => {
        if (cancelled) return;
        setCatalog(next);
        setModelSelection((current) => catalogHasSelection(next, current, mode) ? current : firstCatalogSelection(next, mode));
      })
      .catch((next) => {
        if (cancelled) return;
        setCatalog(undefined);
        setError(next instanceof Error ? next.message : String(next));
      });
    return () => { cancelled = true; };
  }, [props.project.id, catalogRefreshNonce, mode]);

  useEffect(() => {
    function closeModelMenu(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest('.model-menu-anchor')) return;
      setModelMenuOpen(false);
      setModelMenuProvider(undefined);
    }
    document.addEventListener('pointerdown', closeModelMenu);
    return () => document.removeEventListener('pointerdown', closeModelMenu);
  }, []);

  const companyLabel = props.project.companyName ?? props.project.companyId;
  const selectedProviderId = selectionProviderId(modelSelection);
  const selectedProvider = catalog?.providers.find((provider) =>
    provider.id === selectedProviderId && projectCatalogProviderAllowed(catalog, provider.id, mode)
  );
  const selectedModelId = modelSelection.mode === 'auto' ? undefined : modelSelection.modelId;
  const selectedModel = selectedProvider?.models.find((model) => model.id === selectedModelId);
  const modelLabel = modelSelection.mode === 'local-first'
    ? 'Local-first'
    : selectedProvider?.label ?? (selectedProviderId ? providerFallbackLabel(selectedProviderId) : 'Auto');
  const activeMenuProviderId = modelMenuProvider === 'local-first' ? 'ollama' : modelMenuProvider;
  const activeMenuProvider = catalog?.providers.find((provider) =>
    provider.id === activeMenuProviderId && projectCatalogProviderAllowed(catalog, provider.id, mode)
  );

  function chooseMode(next: 'chat' | 'cowork') {
    setMode(next);
    setModelMenuProvider(undefined);
    if (catalog && !catalogHasSelection(catalog, modelSelection, next)) {
      setModelSelection(firstCatalogSelection(catalog, next));
    }
  }

  function togglePin() {
    const nextPinned = !pinned;
    setPinned(nextPinned);
    const next = new Set(pinnedProjectIds());
    if (nextPinned) next.add(props.project.id); else next.delete(props.project.id);
    localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify([...next]));
    window.dispatchEvent(new CustomEvent('local-coder:pins-changed'));
  }

  async function submitGoal() {
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
          modelSelection
        }
      });
      setGoal('');
      setModelMenuOpen(false);
      setModelMenuProvider(undefined);
      props.onCreated(job);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void submitGoal();
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitGoal();
  }

  function chooseModel(providerId: string, modelId: string, localFirst = false) {
    setModelSelection(localFirst
      ? { mode: 'local-first', modelId }
      : { mode: 'explicit', providerId, modelId });
    setModelMenuOpen(false);
    setModelMenuProvider(undefined);
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
      const next = new Set(pinnedProjectIds());
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
          <div className="lc-shell-row-menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void archiveProject(); }}>Archive<Archive size={16} /></button>
          <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); setDeleteOpen(true); }}>Delete…<Trash2 size={16} /></button>
        </div> : null}
      </div>
    </header>

    <div className="project-detail-layout">
      <main>
        <form className="lc-agent-composer-wrap" onSubmit={submit}>
          <div className="lc-agent-composer">
            <div className="composer-context-chips">
              <span><FolderGit2 size={13} />{props.project.name}</span>
            </div>
            <textarea
              ref={promptRef}
              className="lc-agent-prompt-input"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={onComposerKeyDown}
              rows={1}
              placeholder={mode === 'chat' ? `Ask about ${props.project.name}…` : `Ask Cowork to change ${props.project.name}…`}
              aria-label="Project prompt"
            />
            <div className="composer-toolbar">
              <div className="composer-toolbar-left">
                <button className="composer-icon-button" type="button" aria-label="Choose project folder" title="Choose project folder" onClick={() => void chooseProjectFolder()}><Plus size={19} strokeWidth={1.7} /></button>
                <div className="composer-mode-switch" role="radiogroup" aria-label="Project mode">
                  <button type="button" role="radio" aria-checked={mode === 'chat'} className={mode === 'chat' ? 'selected' : ''} onClick={() => chooseMode('chat')}>Chat</button>
                  <button type="button" role="radio" aria-checked={mode === 'cowork'} className={mode === 'cowork' ? 'selected' : ''} onClick={() => chooseMode('cowork')}>Cowork</button>
                </div>
              </div>
              <div className="composer-toolbar-right">
                <div className="composer-menu-anchor model-menu-anchor">
                  <button
                    className="model-effort-trigger"
                    type="button"
                    title={`${companyLabel} · ${modelLabel}${selectedModel ? ` · ${selectedModel.displayName}` : ''}`}
                    aria-haspopup="menu"
                    aria-expanded={modelMenuOpen}
                    onClick={() => {
                      setModelMenuProvider(undefined);
                      if (!modelMenuOpen) setCatalogRefreshNonce((value) => value + 1);
                      setModelMenuOpen((open) => !open);
                    }}
                  >
                    <Zap size={13} strokeWidth={1.7} />
                    <span>{modelLabel}</span>
                    {selectedModel ? <><span className="model-trigger-dot">·</span><span>{selectedModel.displayName}</span></> : null}
                    <ChevronDown size={13} strokeWidth={1.6} />
                  </button>
                  {modelMenuOpen ? <div className="lc-agent-popover model-popover" role="menu">
                    {modelMenuProvider && activeMenuProvider ? <>
                      <button className="popover-back" type="button" onClick={() => setModelMenuProvider(undefined)}><ChevronLeft size={16} /><strong>{modelMenuProvider === 'local-first' ? 'Local-first models' : `${activeMenuProvider.label ?? providerFallbackLabel(activeMenuProvider.id)} models`}</strong></button>
                      <div className="popover-separator" />
                      {activeMenuProvider.models.map((model) => {
                        const selected = modelSelection.mode !== 'auto'
                          && modelSelection.modelId === model.id
                          && (modelMenuProvider === 'local-first'
                            ? modelSelection.mode === 'local-first'
                            : modelSelection.mode === 'explicit' && modelSelection.providerId === activeMenuProvider.id);
                        return <button key={`${modelMenuProvider}:${model.id}`} type="button" className={selected ? 'selected' : ''} disabled={!activeMenuProvider.ready || !model.available} title={!activeMenuProvider.ready || !model.available ? activeMenuProvider.reason ?? 'Provider unavailable' : undefined} onClick={() => chooseModel(activeMenuProvider.id, model.id, modelMenuProvider === 'local-first')}>
                          <span><strong>{model.displayName}</strong><small>{activeMenuProvider.label ?? providerFallbackLabel(activeMenuProvider.id)}</small></span>
                          {selected ? <Check size={16} /> : null}
                        </button>;
                      })}
                      {activeMenuProvider.models.length === 0 ? <div className="model-menu-note">No models are available for this provider.</div> : null}
                    </> : <>
                      <div className="model-provider-label">Provider or account</div>
                      {(catalog?.providers ?? [])
                        .filter((provider) => !catalog || projectCatalogProviderAllowed(catalog, provider.id, mode))
                        .flatMap((provider) => {
                        const ready = provider.ready && provider.models.some((model) => model.available);
                        const selected = modelSelection.mode === 'explicit' && modelSelection.providerId === provider.id;
                        const rows = [<button key={provider.id} type="button" className={selected ? 'selected' : ''} disabled={!ready} title={!ready ? provider.reason : undefined} onClick={() => setModelMenuProvider(provider.id)}>
                          <span><strong>{provider.label ?? providerFallbackLabel(provider.id)}<em>{providerAuthLabel(provider)}</em></strong><small>{providerDescription(provider)}{ready ? '' : ` · ${provider.reason ?? 'unavailable'}`}</small></span>
                          {ready ? <ChevronRight size={16} /> : null}
                        </button>];
                        if (provider.id === 'ollama') rows.push(<button key="local-first" type="button" className={modelSelection.mode === 'local-first' ? 'selected' : ''} disabled={!ready} title={!ready ? provider.reason : undefined} onClick={() => setModelMenuProvider('local-first')}>
                          <span><strong>Local-first<em>Local</em></strong><small>Start on Ollama; ask before bounded cloud escalation</small></span>
                          {ready ? <ChevronRight size={16} /> : null}
                        </button>);
                        return rows;
                      })}
                      {!catalog ? <div className="model-menu-note">Loading available models…</div> : null}
                    </>}
                  </div> : null}
                </div>
                <button className="lc-agent-send-button" type="submit" disabled={!goal.trim() || busy} aria-label="Send task"><ArrowUp size={18} strokeWidth={2} /></button>
              </div>
            </div>
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
  </section>;
}