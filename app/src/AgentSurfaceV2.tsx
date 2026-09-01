import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction
} from 'react';
import {
  ArrowUp,
  Bug,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleStop,
  Code,
  FileText,
  FlaskConical,
  FolderGit2,
  Lightbulb,
  LoaderCircle,
  Plus,
  Sparkles,
  X,
  Zap
} from 'lucide-react';

import type { AdminProject, ModelSelection } from './app-types.js';
import { FolderField } from './FolderField.js';
import { displayProfileName } from './native.js';

type ReasoningEffortSelection = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type JobReasoningEffort = ReasoningEffortSelection | 'none';
type ModelMenuView = 'closed' | 'models' | 'effort';

const NEW_TASK_ID = '__new__';

/**
 * Cowork is bound to a folder: it needs a project or a workspace path before it
 * can run anything. Chat is a loose conversation — a project is optional.
 */
type ComposerMode = 'chat' | 'cowork';

function storedMode(): ComposerMode {
  return localStorage.getItem('local-coder.composer-mode') === 'cowork' ? 'cowork' : 'chat';
}

interface DecisionOption { id: string; label: string; tradeoff: string }
interface DecisionQuestion {
  id: string;
  question: string;
  rationale: string;
  options: DecisionOption[];
  recommendedOptionId?: string;
}
interface DecisionRequest { message: string; questions: DecisionQuestion[] }
interface Validation { command: string; args: string[]; ok: boolean; durationMs: number; output?: string }
interface EngineerResult {
  status: string;
  phase: string;
  summary: string;
  changedFiles: string[];
  diff: string;
  validation: Validation[];
  repairRounds: number;
  decisionRequest?: DecisionRequest;
  escalation?: { kind: string; questions: string[]; researchRequests: string[]; reason: string };
  preflight?: { summary?: string; risks?: string[]; testStrategy?: string[]; cognitive?: { effort?: string } };
  plan?: { confidence: number; tasks: Array<{ id: string; task: string; dependsOn: string[]; editableFiles: string[] }>; riskTags: string[] };
  modelCalls?: Array<{ stage: string; model: string; promptTokens?: number; completionTokens?: number }>;
}
interface JobEvent {
  id: string;
  jobId: string;
  type: string;
  timestamp: string;
  title: string;
  data?: Record<string, unknown>;
}
interface Job {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  rounds: number;
  input: {
    projectId?: string;
    workspace: string;
    goal: string;
    context?: string;
    modelSelection?: ModelSelection;
    reasoningEffort?: JobReasoningEffort;
  };
  decisionRequest?: DecisionRequest;
  result?: EngineerResult;
  error?: string;
  events: JobEvent[];
}
interface WorkerStatus {
  ok?: boolean;
  hostname?: string;
  inference?: {
    current?: {
      stage?: string;
      model?: string;
      runningMs?: number;
      streamState?: string;
    } | null;
  };
}
interface CatalogModel {
  id: string;
  displayName: string;
  available: boolean;
  providerDefault: boolean;
  projectDefault: boolean;
}
interface CatalogProvider {
  id: string;
  kind: 'local' | 'cloud';
  ready: boolean;
  reason?: string;
  models: CatalogModel[];
}
interface ProjectCatalog {
  projectId: string;
  defaultModel: ModelSelection;
  providers: CatalogProvider[];
}
interface ModelOption {
  value: string;
  providerId: string;
  modelId: string;
  label: string;
  description: string;
  available: boolean;
  reason?: string;
}

const effortOptions: Array<{ id: ReasoningEffortSelection; label: string; description: string }> = [
  { id: 'auto', label: 'Default', description: 'Let Local Coder choose the right effort for each stage' },
  { id: 'low', label: 'Low', description: 'Faster for routine, bounded work' },
  { id: 'medium', label: 'Medium', description: 'Balanced speed and depth' },
  { id: 'high', label: 'High', description: 'More thorough reasoning for difficult work' },
  { id: 'xhigh', label: 'Extra high', description: 'Deep reasoning for long-running agentic tasks' },
  { id: 'max', label: 'Max', description: 'Maximum supported reasoning depth' }
];

function time(value?: string) {
  return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}
function duration(ms?: number) {
  if (!Number.isFinite(ms)) return '';
  if ((ms ?? 0) < 60_000) return `${Math.max(1, Math.round((ms ?? 0) / 1000))}s`;
  return `${Math.floor((ms ?? 0) / 60_000)}m`;
}
function modelValue(selection: ModelSelection): string {
  return selection.mode === 'auto' ? 'auto' : `${selection.providerId}\0${selection.modelId}`;
}
function parseModelValue(value: string): ModelSelection {
  if (value === 'auto') return { mode: 'auto' };
  const split = value.indexOf('\0');
  if (split <= 0) return { mode: 'auto' };
  return { mode: 'explicit', providerId: value.slice(0, split), modelId: value.slice(split + 1) };
}
function isWorking(status?: string) {
  return status === 'queued' || status === 'running';
}
function greeting(name?: string) {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : `${part}.`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export function AgentSurfaceV2() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeId, setActiveId] = useState<string>(() => localStorage.getItem('local-coder.open-job') ?? NEW_TASK_ID);
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(() => localStorage.getItem('local-coder.project') ?? '');
  const [catalog, setCatalog] = useState<ProjectCatalog>();
  const [worker, setWorker] = useState<WorkerStatus>();
  const [error, setError] = useState<string>();
  const [workspace, setWorkspace] = useState(() => localStorage.getItem('local-coder.workspace') ?? '');
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [mode, setMode] = useState<ComposerMode>(storedMode);
  const [submitting, setSubmitting] = useState(false);
  const [modelSelection, setModelSelection] = useState('auto');
  const [effort, setEffort] = useState<ReasoningEffortSelection>('auto');
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [modelMenu, setModelMenu] = useState<ModelMenuView>('closed');
  const [projectMenu, setProjectMenu] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [decisionSelections, setDecisionSelections] = useState<Record<string, string>>({});
  const [guidance, setGuidance] = useState('');
  const [profileName, setProfileName] = useState<string>();

  const active = activeId === NEW_TASK_ID ? undefined : jobs.find((job) => job.id === activeId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const currentInference = worker?.inference?.current ?? undefined;

  useEffect(() => {
    localStorage.removeItem('local-coder.open-job');
    void window.lc?.getProfile().then(({ userName }) => setProfileName(displayProfileName(userName)));
    void Promise.all([
      api<{ jobs: Job[] }>('/api/jobs'),
      api<{ projects: AdminProject[] }>('/api/projects')
    ]).then(([{ jobs: initialJobs }, { projects: initialProjects }]) => {
      setJobs(initialJobs);
      setProjects(initialProjects);
      setActiveId((current) => current !== NEW_TASK_ID && initialJobs.some((job) => job.id === current) ? current : NEW_TASK_ID);
      const storedProjectValid = selectedProjectId && initialProjects.some((project) => project.id === selectedProjectId);
      if (selectedProjectId && !storedProjectValid) {
        setSelectedProjectId('');
        localStorage.removeItem('local-coder.project');
      }
    }).catch((next) => setError(next instanceof Error ? next.message : String(next)));

    const events = new EventSource('/api/events');
    events.addEventListener('jobs', (event) => setJobs(JSON.parse((event as MessageEvent<string>).data) as Job[]));
    events.addEventListener('job', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { job: Job };
      setJobs((current) => [payload.job, ...current.filter((job) => job.id !== payload.job.id)]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    });
    events.addEventListener('worker', (event) => {
      setWorker(JSON.parse((event as MessageEvent<string>).data) as WorkerStatus);
    });
    events.addEventListener('worker-error', (event) => {
      const body = JSON.parse((event as MessageEvent<string>).data) as { error?: string };
      setWorker({ ok: false });
      setError(body.error ?? 'Local runtime unavailable.');
    });
    return () => events.close();
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(undefined), 8_000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!selectedProjectId) {
      setCatalog(undefined);
      setModelSelection('auto');
      return;
    }
    void api<{ catalog: ProjectCatalog }>(`/api/projects/${encodeURIComponent(selectedProjectId)}/catalog`)
      .then(({ catalog: next }) => {
        setCatalog(next);
        setModelSelection(modelValue(next.defaultModel));
      })
      .catch((next) => {
        setCatalog(undefined);
        setModelSelection('auto');
        setError(next instanceof Error ? next.message : String(next));
      });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!active?.decisionRequest) return;
    const recommended: Record<string, string> = {};
    for (const question of active.decisionRequest.questions) {
      if (question.recommendedOptionId) recommended[question.id] = question.recommendedOptionId;
    }
    setDecisionSelections(recommended);
  }, [active?.id, active?.decisionRequest]);

  useEffect(() => {
    function closeMenus(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest('.composer-menu-anchor')) return;
      setModelMenu('closed');
      setProjectMenu(false);
      setExtrasOpen(false);
    }
    document.addEventListener('pointerdown', closeMenus);
    return () => document.removeEventListener('pointerdown', closeMenus);
  }, []);

  const modelOptions = useMemo<ModelOption[]>(() => {
    const options: ModelOption[] = [];
    for (const provider of catalog?.providers ?? []) {
      for (const model of provider.models) {
        options.push({
          value: `${provider.id}\0${model.id}`,
          providerId: provider.id,
          modelId: model.id,
          label: model.displayName,
          description: provider.kind === 'local' ? `Local · ${provider.id}` : `Cloud · ${provider.id}`,
          available: provider.ready && model.available,
          reason: provider.reason
        });
      }
    }
    return options;
  }, [catalog]);

  const selectedModel = modelOptions.find((model) => model.value === modelSelection);
  const modelLabel = modelSelection === 'auto' ? 'Auto' : selectedModel?.label ?? 'Model';
  const effortLabel = effortOptions.find((option) => option.id === effort)?.label ?? 'Default';
  const displayedEffortLabel = thinkingEnabled ? effortLabel : 'Thinking off';

  function chooseProject(projectId: string) {
    setSelectedProjectId(projectId);
    setProjectMenu(false);
    if (projectId) localStorage.setItem('local-coder.project', projectId);
    else localStorage.removeItem('local-coder.project');
  }

  function chooseMode(next: ComposerMode) {
    localStorage.setItem('local-coder.composer-mode', next);
    setMode(next);
    // Cowork cannot run without a folder, so ask for one straight away instead
    // of failing on submit.
    if (next === 'cowork' && !selectedProject && !workspace.trim()) {
      setModelMenu('closed');
      if (projects.length > 0) setProjectMenu(true);
      else setExtrasOpen(true);
    }
  }

  async function createJob() {
    if (!goal.trim()) return;
    const effectiveWorkspace = selectedProject?.workspace ?? workspace.trim();
    if (!effectiveWorkspace) {
      setModelMenu('closed');
      if (projects.length > 0) setProjectMenu(true);
      else setExtrasOpen(true);
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const { job } = await api<{ job: Job }>('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          projectId: selectedProject?.id || undefined,
          workspace: effectiveWorkspace,
          goal: goal.trim(),
          context: context.trim() || undefined,
          maxRepairRounds: 1,
          modelSelection: selectedProject ? parseModelValue(modelSelection) : undefined,
          reasoningEffort: selectedProject ? (thinkingEnabled ? effort : 'none') : undefined
        })
      });
      if (!selectedProject) localStorage.setItem('local-coder.workspace', effectiveWorkspace);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setActiveId(job.id);
      setGoal('');
      setContext('');
      setExtrasOpen(false);
      setModelMenu('closed');
      setProjectMenu(false);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setSubmitting(false);
    }
  }

  async function retryRuntime() {
    try {
      await api('/api/health');
      setError(undefined);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    }
  }

  async function cancelActive() {
    if (!active || !isWorking(active.status)) return;
    try {
      const { job } = await api<{ job: Job }>(`/api/jobs/${active.id}/cancel`, { method: 'POST' });
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    }
  }

  async function sendDecision() {
    if (!active) return;
    try {
      await api(`/api/jobs/${active.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ selections: decisionSelections })
      });
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    }
  }

  async function sendGuidance() {
    if (!active || !guidance.trim()) return;
    try {
      await api(`/api/jobs/${active.id}/guidance`, {
        method: 'POST',
        body: JSON.stringify({ guidance })
      });
      setGuidance('');
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void createJob();
    }
  }

  return <div className="lc-agent-agent-shell lc-agent-shell">
    <main className="lc-agent-thread-pane lc-thread-pane">
      {error ? <div className="lc-agent-error-banner" role="status" aria-live="polite">
        <span>{error}</span>
        <button onClick={() => void retryRuntime()}>Retry</button>
        <button onClick={() => window.dispatchEvent(new CustomEvent('local-coder:open-settings'))}>Settings</button>
        <button onClick={() => setError(undefined)} aria-label="Dismiss"><X size={14} /></button>
      </div> : null}

      {!active ? <EmptyStart selectedProject={selectedProject} profileName={profileName} /> : <TaskThread
        job={active}
        currentInference={currentInference}
        decisionSelections={decisionSelections}
        setDecisionSelections={setDecisionSelections}
        sendDecision={sendDecision}
        guidance={guidance}
        setGuidance={setGuidance}
        sendGuidance={sendGuidance}
      />}

      <Composer
        goal={goal}
        setGoal={setGoal}
        context={context}
        setContext={setContext}
        workspace={workspace}
        setWorkspace={setWorkspace}
        selectedProject={selectedProject}
        projects={projects}
        projectMenu={projectMenu}
        setProjectMenu={setProjectMenu}
        chooseProject={chooseProject}
        extrasOpen={extrasOpen}
        setExtrasOpen={setExtrasOpen}
        modelMenu={modelMenu}
        setModelMenu={setModelMenu}
        modelOptions={modelOptions}
        modelSelection={modelSelection}
        setModelSelection={setModelSelection}
        modelLabel={modelLabel}
        effort={effort}
        setEffort={setEffort}
        effortLabel={displayedEffortLabel}
        thinkingEnabled={thinkingEnabled}
        setThinkingEnabled={setThinkingEnabled}
        submitting={submitting}
        canSubmit={Boolean(goal.trim())}
        activeWorking={Boolean(active && isWorking(active.status))}
        createJob={createJob}
        cancelActive={cancelActive}
        onKeyDown={onComposerKeyDown}
        mode={mode}
        chooseMode={chooseMode}
      />

      {/* Chat offers starting points; Cowork says which folder it will act on. */}
      {!active && mode === 'chat' ? <Suggestions onPick={setGoal} /> : null}
      {!active && mode === 'cowork' ? <p className="lc-agent-cowork-hint">
        {selectedProject ? `Cowork runs in ${selectedProject.name}.` : workspace.trim() ? `Cowork runs in ${workspace.trim()}.` : 'Pick a project or folder for Cowork to act on.'}
      </p> : null}
    </main>
    {active ? <ProgressRail job={active} currentInference={currentInference} /> : null}
  </div>;
}

/**
 * Greeting only — the mark sits inline with the text, and there is no
 * breadcrumb or explanatory paragraph. The suggestions moved below the
 * composer, where they belong.
 */
function EmptyStart({ selectedProject, profileName }: { selectedProject?: AdminProject; profileName?: string }) {
  return <section className="lc-agent-empty-start">
    <h1><Sparkles className="lc-agent-empty-mark" size={30} strokeWidth={1.4} aria-hidden="true" />{selectedProject ? selectedProject.name : greeting(profileName)}</h1>
  </section>;
}

const SUGGESTIONS: Array<{ label: string; icon: typeof Code; prompt: string }> = [
  { label: 'Code', icon: Code, prompt: 'Review this code' },
  { label: 'Fix a bug', icon: Bug, prompt: 'Fix a bug' },
  { label: 'Tests', icon: FlaskConical, prompt: 'Improve the tests' },
  { label: 'Explain', icon: Lightbulb, prompt: 'Explain this project' }
];

function Suggestions({ onPick }: { onPick: (value: string) => void }) {
  return <div className="lc-agent-quick-actions">
    {SUGGESTIONS.map(({ label, icon: Icon, prompt }) => <button key={label} onClick={() => onPick(prompt)}>
      <Icon size={14} strokeWidth={1.7} aria-hidden="true" /><span>{label}</span>
    </button>)}
  </div>;
}

function Composer(props: {
  goal: string;
  setGoal: (value: string) => void;
  context: string;
  setContext: (value: string) => void;
  workspace: string;
  setWorkspace: (value: string) => void;
  selectedProject?: AdminProject;
  projects: AdminProject[];
  projectMenu: boolean;
  setProjectMenu: (value: boolean) => void;
  chooseProject: (id: string) => void;
  mode: ComposerMode;
  chooseMode: (value: ComposerMode) => void;
  extrasOpen: boolean;
  setExtrasOpen: (value: boolean) => void;
  modelMenu: ModelMenuView;
  setModelMenu: (value: ModelMenuView) => void;
  modelOptions: ModelOption[];
  modelSelection: string;
  setModelSelection: (value: string) => void;
  modelLabel: string;
  effort: ReasoningEffortSelection;
  setEffort: (value: ReasoningEffortSelection) => void;
  effortLabel: string;
  thinkingEnabled: boolean;
  setThinkingEnabled: (value: boolean) => void;
  submitting: boolean;
  canSubmit: boolean;
  activeWorking: boolean;
  createJob: () => Promise<void>;
  cancelActive: () => Promise<void>;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, Math.min(320, window.innerHeight * 0.4))}px`;
  }, [props.goal]);

  return <div className="lc-agent-composer-wrap">
    <div className="lc-agent-composer">
      {(props.selectedProject || props.workspace || props.context) ? <div className="composer-context-chips">
        {props.selectedProject ? <span><FolderGit2 size={13} />{props.selectedProject.name}</span> : props.workspace ? <span><FolderGit2 size={13} />{props.workspace}<button aria-label="Remove workspace" onClick={() => props.setWorkspace('')}><X size={11} /></button></span> : null}
        {props.context ? <span><FileText size={13} />Context<button aria-label="Remove context" onClick={() => props.setContext('')}><X size={11} /></button></span> : null}
      </div> : null}

      <textarea
        ref={inputRef}
        className="lc-agent-prompt-input"
        value={props.goal}
        onChange={(event) => props.setGoal(event.target.value)}
        onKeyDown={props.onKeyDown}
        rows={1}
        placeholder="How can I help you today?"
        aria-label="Task prompt"
      />

      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          <div className="composer-menu-anchor composer-add-anchor">
            <button className={`composer-icon-button ${props.extrasOpen ? 'active' : ''}`} onClick={() => { props.setProjectMenu(false); props.setModelMenu('closed'); props.setExtrasOpen(!props.extrasOpen); }} aria-label="Add context" aria-expanded={props.extrasOpen}>
              <Plus size={19} strokeWidth={1.7} />
            </button>
            {props.extrasOpen ? <div className="lc-agent-popover composer-add-popover" role="menu">
              {!props.selectedProject ? <label className="composer-popover-field"><span><FolderGit2 size={14} /><strong>Workspace</strong></span><FolderField value={props.workspace} onChange={props.setWorkspace} placeholder="/Users/you/project" /></label> : null}
              <label className="composer-popover-field"><span><FileText size={14} /><strong>Context</strong></span><textarea value={props.context} onChange={(event) => props.setContext(event.target.value)} rows={3} placeholder="Add optional context or constraints" /></label>
            </div> : null}
          </div>

          {/* Chat or Cowork. Cowork is bound to a folder; Chat is not. */}
          <div className="composer-mode-switch" role="radiogroup" aria-label="Conversation mode">
            {(['chat', 'cowork'] as const).map((value) => <button
              key={value}
              role="radio"
              aria-checked={props.mode === value}
              className={props.mode === value ? 'selected' : ''}
              onClick={() => props.chooseMode(value)}
            >{value === 'chat' ? 'Chat' : 'Cowork'}</button>)}
          </div>

          <div className={`composer-menu-anchor project-menu-anchor ${props.mode === 'cowork' ? 'required' : ''}`}>
            <button className="composer-text-button" aria-haspopup="menu" aria-expanded={props.projectMenu} onClick={() => { props.setExtrasOpen(false); props.setModelMenu('closed'); props.setProjectMenu(!props.projectMenu); }}>
              <FolderGit2 size={14} strokeWidth={1.6} />
              <span>{props.selectedProject?.name ?? (props.mode === 'cowork' ? 'Project or folder' : 'No project')}</span>
              <ChevronDown size={13} strokeWidth={1.6} />
            </button>
            {props.projectMenu ? <div className="lc-agent-popover project-popover" role="menu">
              <button className={!props.selectedProject ? 'selected' : ''} onClick={() => props.chooseProject('')}>
                <span><strong>No project</strong><small>Use a workspace path directly</small></span>
                {!props.selectedProject ? <Check size={15} /> : null}
              </button>
              {props.projects.map((project) => <button key={project.id} className={props.selectedProject?.id === project.id ? 'selected' : ''} onClick={() => props.chooseProject(project.id)}>
                <span><strong>{project.name}</strong><small>{project.organizationName ?? project.organizationId}</small></span>
                {props.selectedProject?.id === project.id ? <Check size={15} /> : null}
              </button>)}
            </div> : null}
          </div>
        </div>

        <div className="composer-toolbar-right">
          <div className="composer-menu-anchor model-menu-anchor">
            <button className="model-effort-trigger" aria-haspopup="menu" aria-expanded={props.modelMenu !== 'closed'} onClick={() => { props.setExtrasOpen(false); props.setProjectMenu(false); props.setModelMenu(props.modelMenu === 'closed' ? 'models' : 'closed'); }}>
              <Zap size={13} strokeWidth={1.7} />
              <span>{props.modelLabel}</span><span className="model-trigger-dot">·</span><span>{props.effortLabel}</span>
              <ChevronDown size={13} strokeWidth={1.6} />
            </button>
            {props.modelMenu !== 'closed' ? <ModelMenu {...props} /> : null}
          </div>

          {props.activeWorking ? <button className="lc-agent-stop-button" onClick={() => void props.cancelActive()} aria-label="Stop task"><CircleStop size={18} strokeWidth={1.65} /></button>
            : <button className="lc-agent-send-button" disabled={props.submitting || !props.canSubmit} onClick={() => void props.createJob()} aria-label="Send task"><ArrowUp size={18} strokeWidth={2} /></button>}
        </div>
      </div>
    </div>
  </div>;
}

function ModelMenu(props: {
  modelMenu: ModelMenuView;
  setModelMenu: (value: ModelMenuView) => void;
  modelOptions: ModelOption[];
  modelSelection: string;
  setModelSelection: (value: string) => void;
  effort: ReasoningEffortSelection;
  setEffort: (value: ReasoningEffortSelection) => void;
  effortLabel: string;
  thinkingEnabled: boolean;
  setThinkingEnabled: (value: boolean) => void;
}) {
  if (props.modelMenu === 'effort') {
    return <div className="lc-agent-popover model-popover effort-popover" role="menu">
      <button className="popover-back" onClick={() => props.setModelMenu('models')}><ChevronLeft size={16} /><strong>Effort</strong></button>
      <div className="popover-separator" />
      {effortOptions.map((option) => <button key={option.id} className={props.effort === option.id ? 'selected' : ''} onClick={() => { props.setEffort(option.id); props.setModelMenu('models'); }}>
        <span><strong>{option.label}{option.id === 'auto' ? <em>Default</em> : null}</strong><small>{option.description}</small></span>
        {props.effort === option.id ? <Check size={16} /> : null}
      </button>)}
    </div>;
  }

  const providers = [...new Set(props.modelOptions.map((model) => model.providerId))];
  return <div className="lc-agent-popover model-popover" role="menu">
    <button className={props.modelSelection === 'auto' ? 'selected' : ''} onClick={() => { props.setModelSelection('auto'); props.setModelMenu('closed'); }}>
      <span><strong>Auto</strong><small>Route each stage to the best allowed model</small></span>
      {props.modelSelection === 'auto' ? <Check size={16} /> : null}
    </button>
    {providers.map((providerId) => <div className="model-provider-group" key={providerId}>
      <div className="model-provider-label">{providerId}</div>
      {props.modelOptions.filter((model) => model.providerId === providerId).map((model) => <button key={model.value} className={props.modelSelection === model.value ? 'selected' : ''} disabled={!model.available} title={!model.available ? model.reason ?? 'Provider unavailable' : undefined} onClick={() => { props.setModelSelection(model.value); props.setModelMenu('closed'); }}>
        <span><strong>{model.label}</strong><small>{model.description}{model.available ? '' : ` · ${model.reason ?? 'unavailable'}`}</small></span>
        {props.modelSelection === model.value ? <Check size={16} /> : null}
      </button>)}
    </div>)}
    {props.modelOptions.length === 0 ? <div className="model-menu-note">Choose or create a project to discover provider models. Auto remains available.</div> : null}
    <div className="popover-separator" />
    <button className="popover-row-link" onClick={() => props.setModelMenu('effort')}>
      <span><strong>Effort</strong><small>Control how deeply the selected model reasons</small></span>
      <span className="popover-row-value">{props.effortLabel.replace('Thinking off', 'Default')} ›</span>
    </button>
    <button className="popover-row-link thinking-row" aria-pressed={props.thinkingEnabled} onClick={() => props.setThinkingEnabled(!props.thinkingEnabled)}>
      <span><strong>Thinking</strong><small>Allow extended reasoning when supported</small></span>
      <span className={`lc-agent-switch ${props.thinkingEnabled ? 'on' : ''}`} aria-hidden="true"><i /></span>
    </button>
  </div>;
}

function TaskThread(props: {
  job: Job;
  currentInference?: NonNullable<WorkerStatus['inference']>['current'];
  decisionSelections: Record<string, string>;
  setDecisionSelections: Dispatch<SetStateAction<Record<string, string>>>;
  sendDecision: () => Promise<void>;
  guidance: string;
  setGuidance: (value: string) => void;
  sendGuidance: () => Promise<void>;
}) {
  const { job, currentInference } = props;
  const working = isWorking(job.status);
  const latestEvent = job.events.at(-1);
  const result = job.result;
  return <div className="lc-agent-thread" aria-live="polite">
    <div className="thread-user-turn"><div className="user-message">{job.input.goal}</div>{job.input.context ? <div className="user-context-note">Context attached</div> : null}</div>
    <div className="thread-assistant-turn">
      <div className={`assistant-mark ${working ? 'working' : ''}`}><Sparkles size={18} strokeWidth={1.55} /></div>
      <div className="assistant-body">
        {working ? <div className="assistant-stream-state">
          <div className="assistant-stream-title"><LoaderCircle className="assistant-spinner" size={16} /><strong>{currentInference?.streamState === 'generating' ? 'Writing' : currentInference?.streamState === 'reasoning' ? 'Thinking' : 'Working'}</strong></div>
          <p>{latestEvent?.title ?? 'Starting the task…'}</p>
          <div className="assistant-stream-meta">{currentInference?.stage ? <span>{currentInference.stage}</span> : null}{currentInference?.model ? <span>{currentInference.model}</span> : null}{currentInference?.runningMs ? <span>{duration(currentInference.runningMs)}</span> : null}</div>
        </div> : null}
        {job.status === 'waiting-decision' && job.decisionRequest ? <DecisionMessage request={job.decisionRequest} selections={props.decisionSelections} setSelections={props.setDecisionSelections} onContinue={props.sendDecision} /> : null}
        {job.status === 'waiting-guidance' && result?.escalation ? <GuidanceMessage result={result} guidance={props.guidance} setGuidance={props.setGuidance} onContinue={props.sendGuidance} /> : null}
        {job.status === 'error' ? <div className="assistant-result-message error"><strong>Something went wrong</strong><p>{job.error ?? 'The task stopped unexpectedly.'}</p></div> : null}
        {job.status === 'cancelled' ? <div className="assistant-result-message muted-result"><strong>Task stopped</strong><p>The run was cancelled and will not resume automatically.</p></div> : null}
        {job.status === 'success' && result ? <ResultMessage result={result} /> : null}
      </div>
    </div>
  </div>;
}

function DecisionMessage(props: { request: DecisionRequest; selections: Record<string, string>; setSelections: Dispatch<SetStateAction<Record<string, string>>>; onContinue: () => Promise<void> }) {
  return <div className="assistant-decision-message">
    <h2>{props.request.message}</h2>
    {props.request.questions.map((question) => <div className="inline-decision" key={question.id}><strong>{question.question}</strong><p>{question.rationale}</p><div className="inline-choice-list">{question.options.map((option) => <button key={option.id} className={props.selections[question.id] === option.id ? 'selected' : ''} onClick={() => props.setSelections((current) => ({ ...current, [question.id]: option.id }))}><span>{option.label}</span>{option.id === question.recommendedOptionId ? <small>Recommended</small> : null}</button>)}</div></div>)}
    <button className="lc-agent-secondary-action" onClick={() => void props.onContinue()}>Continue</button>
  </div>;
}

function GuidanceMessage(props: { result: EngineerResult; guidance: string; setGuidance: (value: string) => void; onContinue: () => Promise<void> }) {
  const escalation = props.result.escalation!;
  return <div className="assistant-decision-message"><h2>{escalation.reason}</h2>{escalation.questions.map((question) => <p key={question}>{question}</p>)}<textarea className="inline-guidance-input" rows={3} value={props.guidance} onChange={(event) => props.setGuidance(event.target.value)} placeholder="Add the missing decision or evidence…" /><button className="lc-agent-secondary-action" disabled={!props.guidance.trim()} onClick={() => void props.onContinue()}>Resume</button></div>;
}

function ResultMessage({ result }: { result: EngineerResult }) {
  return <div className="assistant-result-message">
    <p className="assistant-result-copy">{result.summary}</p>
    {result.changedFiles.length ? <div className="result-chip-row"><span>{result.changedFiles.length} file{result.changedFiles.length === 1 ? '' : 's'} changed</span><span>{result.validation.filter((item) => item.ok).length}/{result.validation.length} checks passed</span>{result.repairRounds ? <span>{result.repairRounds} repair round{result.repairRounds === 1 ? '' : 's'}</span> : null}</div> : null}
    {result.changedFiles.length ? <details className="assistant-details"><summary>Changed files</summary><ul>{result.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul></details> : null}
    {result.validation.length ? <details className="assistant-details"><summary>Validation</summary><div className="validation-list">{result.validation.map((check, index) => <div key={`${check.command}-${index}`}><span className={check.ok ? 'validation-ok' : 'validation-fail'}>{check.ok ? '✓' : '×'}</span><code>{check.command} {check.args.join(' ')}</code></div>)}</div></details> : null}
    {result.diff ? <details className="assistant-details"><summary>Diff</summary><pre className="thread-diff">{result.diff}</pre></details> : null}
  </div>;
}

function ProgressRail({ job, currentInference }: { job: Job; currentInference?: NonNullable<WorkerStatus['inference']>['current'] }) {
  const events = [...job.events].reverse();
  const result = job.result;
  const thinking = job.input.reasoningEffort === 'none' ? 'Off' : 'On';
  const effort = job.input.reasoningEffort === 'none' ? '—' : job.input.reasoningEffort === 'auto' || !job.input.reasoningEffort ? result?.preflight?.cognitive?.effort ?? 'Auto' : job.input.reasoningEffort;
  return <aside className="lc-agent-progress-rail" aria-label="Task progress">
    <details className="progress-panel" open><summary>Progress <ChevronDown size={14} /></summary><div className="progress-list">{events.length === 0 ? <p>No progress yet.</p> : events.slice(0, 12).map((event, index) => <div className="progress-row" key={event.id}><span className={`progress-index ${index === 0 && isWorking(job.status) ? 'active' : ''}`}>{index === 0 && isWorking(job.status) ? <LoaderCircle size={11} /> : events.length - index}</span><div><strong>{event.title}</strong><small>{time(event.timestamp)}</small></div></div>)}</div></details>
    <details className="progress-panel"><summary>Context <ChevronDown size={14} /></summary><div className="context-list"><div><span>Workspace</span><code>{job.input.workspace}</code></div><div><span>Model</span><strong>{currentInference?.model ?? result?.modelCalls?.at(-1)?.model ?? 'Auto'}</strong></div><div><span>Effort</span><strong>{effort}</strong></div><div><span>Thinking</span><strong>{thinking}</strong></div><div><span>Round</span><strong>{job.rounds}</strong></div></div></details>
  </aside>;
}
