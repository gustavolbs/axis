import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react';
import {
  ArrowUp,
  Bug,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleStop,
  Code,
  CornerDownLeft,
  FileText,
  FlaskConical,
  FolderGit2,
  Lightbulb,
  LoaderCircle,
  Pencil,
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
type ProviderMode = 'ollama' | 'anthropic' | 'openai' | 'local-first';

const NEW_TASK_ID = '__new__';

/**
 * Cowork is bound to a folder: it needs a project or a workspace path before it
 * can run anything. Chat is a loose conversation — a project is optional.
 */
type ComposerMode = 'chat' | 'cowork';

/**
 * Typing this in the composer renders the decision picker with canned data, so
 * the interaction can be checked without waiting for a run to actually need a
 * decision. It never reaches the backend.
 */
const MOCK_DECISION_COMMAND = /^\/mock[-\s]?decision$/i;

const MOCK_DECISION: DecisionRequest = {
  message: 'Mock decision',
  questions: [
    {
      id: 'mock-1',
      question: 'Choose an option:',
      rationale: 'Canned data for checking the picker.',
      options: [
        { id: 'a', label: 'Option A', tradeoff: '' },
        { id: 'b', label: 'Option B', tradeoff: '' },
        { id: 'c', label: 'Other (I will type it)', tradeoff: '' }
      ]
    }
  ]
};

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
interface EscalationOption {
  providerId: string;
  modelId: string;
  supportsReasoning: boolean;
}
interface EscalationPlan {
  stage: string;
  recommended?: EscalationOption & { reasoningEffort: JobReasoningEffort };
  options: EscalationOption[];
  reasons: string[];
}
interface JobEvent {
  id: string;
  jobId: string;
  type: string;
  timestamp: string;
  title: string;
  data?: Record<string, unknown>;
}
interface JobTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
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
    interactionMode?: ComposerMode;
    modelSelection?: ModelSelection;
    reasoningEffort?: JobReasoningEffort;
  };
  turns: JobTurn[];
  decisionRequest?: DecisionRequest;
  escalationPlan?: EscalationPlan;
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

const providerModes: Array<{ id: ProviderMode; label: string; description: string; providerId: string }> = [
  { id: 'ollama', label: 'Ollama', description: 'Use Ollama only for every stage', providerId: 'ollama' },
  { id: 'anthropic', label: 'Claude', description: 'Use the selected Anthropic model directly', providerId: 'anthropic' },
  { id: 'openai', label: 'GPT', description: 'Use the selected OpenAI model directly', providerId: 'openai' },
  { id: 'local-first', label: 'Local-first', description: 'Start on Ollama; ask before bounded cloud escalation', providerId: 'ollama' }
];

function time(value?: string) {
  return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}
function duration(ms?: number) {
  if (!Number.isFinite(ms)) return '';
  if ((ms ?? 0) < 60_000) return `${Math.max(1, Math.round((ms ?? 0) / 1000))}s`;
  return `${Math.floor((ms ?? 0) / 60_000)}m`;
}
function providerLabel(providerId: string): string {
  if (providerId === 'anthropic') return 'Claude';
  if (providerId === 'openai') return 'GPT';
  if (providerId === 'ollama') return 'Ollama';
  return providerId;
}
function modelValue(selection: ModelSelection): string {
  if (selection.mode === 'auto') return 'auto';
  if (selection.mode === 'local-first') return `local-first\0${selection.modelId}`;
  return `${selection.providerId}\0${selection.modelId}`;
}
function parseModelValue(value: string): ModelSelection {
  if (value === 'auto') return { mode: 'auto' };
  const split = value.indexOf('\0');
  if (split <= 0) return { mode: 'auto' };
  const providerId = value.slice(0, split);
  const modelId = value.slice(split + 1);
  return providerId === 'local-first'
    ? { mode: 'local-first', modelId }
    : { mode: 'explicit', providerId, modelId };
}
function providerMode(value: string): ProviderMode {
  if (value.startsWith('local-first\0')) return 'local-first';
  if (value.startsWith('anthropic\0')) return 'anthropic';
  if (value.startsWith('openai\0')) return 'openai';
  return 'ollama';
}
function modeValue(mode: ProviderMode, modelId: string): string {
  return `${mode === 'local-first' ? 'local-first' : mode}\0${modelId}`;
}
function firstAvailableModel(catalog: ProjectCatalog, providerId: string): CatalogModel | undefined {
  const provider = catalog.providers.find((item) => item.id === providerId && item.ready);
  return provider?.models.find((model) => model.available);
}
function defaultComposerSelection(catalog: ProjectCatalog): string {
  const configured = modelValue(catalog.defaultModel);
  if (configured !== 'auto') return configured;
  const local = firstAvailableModel(catalog, 'ollama');
  if (local) return modeValue('local-first', local.id);
  const claude = firstAvailableModel(catalog, 'anthropic');
  if (claude) return modeValue('anthropic', claude.id);
  const gpt = firstAvailableModel(catalog, 'openai');
  if (gpt) return modeValue('openai', gpt.id);
  return 'auto';
}
function isWorking(status?: string) {
  return status === 'queued' || status === 'running';
}
function canFollowUp(status?: string) {
  return status === 'success' || status === 'error' || status === 'cancelled';
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
  const [mockDecision, setMockDecision] = useState<DecisionRequest>();
  const [mockAnswers, setMockAnswers] = useState<Array<{ questionId: string; value: string }>>([]);
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
  const pendingDecision = mockDecision
    ?? (active?.status === 'waiting-decision' ? active.decisionRequest : undefined);
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
        setModelSelection(defaultComposerSelection(next));
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
          providerId: provider.id,
          modelId: model.id,
          label: model.displayName,
          description: provider.kind === 'local' ? 'Local model' : `Cloud · ${providerLabel(provider.id)}`,
          available: provider.ready && model.available,
          reason: provider.reason
        });
      }
    }
    return options;
  }, [catalog]);

  const selectedMode = providerMode(modelSelection);
  const selectedModeConfig = providerModes.find((item) => item.id === selectedMode)!;
  const selectedModelId = modelSelection.includes('\0') ? modelSelection.slice(modelSelection.indexOf('\0') + 1) : '';
  const selectedModel = modelOptions.find(
    (model) => model.providerId === selectedModeConfig.providerId && model.modelId === selectedModelId
  );
  const modelLabel = selectedModeConfig.label;
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
    if (next === 'cowork' && !selectedProject && !workspace.trim()) {
      setModelMenu('closed');
      if (projects.length > 0) setProjectMenu(true);
      else setExtrasOpen(true);
    }
  }

  async function createJob() {
    if (!goal.trim()) return;

    if (MOCK_DECISION_COMMAND.test(goal.trim())) {
      setGoal('');
      setMockAnswers([]);
      setMockDecision(MOCK_DECISION);
      return;
    }

    // With no project, fall back to the default workspace from Settings —
    // which is what that setting is for.
    const defaultWorkspace = localStorage.getItem('local-coder.workspace')?.trim() ?? '';
    const effectiveWorkspace = selectedProject?.workspace ?? (workspace.trim() || defaultWorkspace);
    // Chat is one inference that reads no files, so it sends without a folder.
    // Cowork acts on a folder and cannot.
    if (!effectiveWorkspace && mode === 'cowork') {
      // Reopening the project menu with no message read as the picker
      // "jumping" for no reason. Say what is missing and open the field that
      // fixes it.
      setModelMenu('closed');
      setProjectMenu(false);
      setExtrasOpen(true);
      setError('Cowork needs a folder to work in. Set one here, pick a project, or set a default workspace in Settings → General.');
      return;
    }
    if (selectedProject && modelSelection === 'auto') {
      setError('No configured provider model is available for this Project. Check Model routing settings.');
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
          interactionMode: mode,
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

  async function followUpChat() {
    if (!active || active.input.interactionMode !== 'chat' || !canFollowUp(active.status) || !goal.trim()) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const { job } = await api<{ job: Job }>(`/api/jobs/${active.id}/follow-up`, {
        method: 'POST',
        body: JSON.stringify({ message: goal.trim() })
      });
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      // Keep the active conversation open: a follow-up is another turn, not a new job.
      setGoal('');
      setExtrasOpen(false);
      setModelMenu('closed');
      setProjectMenu(false);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setSubmitting(false);
    }
  }

  async function sendCurrentMessage() {
    if (!goal.trim()) return;
    if (active?.input.interactionMode === 'chat') {
      if (canFollowUp(active.status)) await followUpChat();
      return;
    }
    await createJob();
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

  async function sendEscalation(
    providerId: string,
    modelId: string,
    reasoningEffort?: JobReasoningEffort
  ) {
    if (!active) return;
    try {
      const { job } = await api<{ job: Job }>(`/api/jobs/${active.id}/escalate`, {
        method: 'POST',
        body: JSON.stringify({ providerId, modelId, reasoningEffort })
      });
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
      throw next;
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void sendCurrentMessage();
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
        guidance={guidance}
        setGuidance={setGuidance}
        sendGuidance={sendGuidance}
        sendEscalation={sendEscalation}
      />}

      {/* One render site for both the real request and the mock, so what you
          check with /mock-decision is the same component that ships. */}
      {pendingDecision ? <DecisionPicker
        request={pendingDecision}
        onAnswer={(questionId, value) => {
          if (mockDecision) setMockAnswers((current) => [...current, { questionId, value }]);
          else setDecisionSelections((current) => ({ ...current, [questionId]: value }));
        }}
        onDismiss={() => {
          if (mockDecision) setMockDecision(undefined);
          else void sendDecision();
        }}
      /> : null}

      {mockAnswers.length && !mockDecision ? <div className="decision-picker-echo" role="status">
        <strong>Mock answers</strong>
        <ul>{mockAnswers.map((answer, position) => <li key={position}><code>{answer.questionId}</code> → {answer.value}</li>)}</ul>
        <button className="btn-secondary" onClick={() => setMockAnswers([])}>Clear</button>
      </div> : null}

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
        selectedModelLabel={selectedModel?.label}
        effort={effort}
        setEffort={setEffort}
        effortLabel={displayedEffortLabel}
        thinkingEnabled={thinkingEnabled}
        setThinkingEnabled={setThinkingEnabled}
        submitting={submitting}
        canSubmit={Boolean(goal.trim())}
        activeWorking={Boolean(active && isWorking(active.status))}
        sendMessage={sendCurrentMessage}
        cancelActive={cancelActive}
        onKeyDown={onComposerKeyDown}
        mode={mode}
        chooseMode={chooseMode}
        placeholder={pendingDecision ? 'Or answer directly…' : undefined}
      />

      {/* The legend belongs under the composer: "or type below" means the
          composer, so it cannot live inside the card above it. */}
      {pendingDecision ? <DecisionHint request={pendingDecision} /> : null}

      {/* Chat offers starting points; Cowork says which folder it will act on. */}
      {!active && !pendingDecision && mode === 'chat' ? <Suggestions onPick={setGoal} /> : null}
      {!active && mode === 'cowork' ? <p className="lc-agent-cowork-hint">
        {selectedProject ? `Cowork runs in ${selectedProject.name}.` : workspace.trim() ? `Cowork runs in ${workspace.trim()}.` : 'Pick a project or folder for Cowork to act on.'}
      </p> : null}
    </main>
    {active && active.input.interactionMode !== 'chat' ? <ProgressRail job={active} currentInference={currentInference} /> : null}
  </div>;
}

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
  placeholder?: string;
  extrasOpen: boolean;
  setExtrasOpen: (value: boolean) => void;
  modelMenu: ModelMenuView;
  setModelMenu: (value: ModelMenuView) => void;
  modelOptions: ModelOption[];
  modelSelection: string;
  setModelSelection: (value: string) => void;
  modelLabel: string;
  selectedModelLabel?: string;
  effort: ReasoningEffortSelection;
  setEffort: (value: ReasoningEffortSelection) => void;
  effortLabel: string;
  thinkingEnabled: boolean;
  setThinkingEnabled: (value: boolean) => void;
  submitting: boolean;
  canSubmit: boolean;
  activeWorking: boolean;
  sendMessage: () => Promise<void>;
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
        placeholder={props.placeholder ?? 'How can I help you today?'}
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
              <span>{props.modelLabel}</span>{props.selectedModelLabel ? <><span className="model-trigger-dot">·</span><span>{props.selectedModelLabel}</span></> : null}<span className="model-trigger-dot">·</span><span>{props.effortLabel}</span>
              <ChevronDown size={13} strokeWidth={1.6} />
            </button>
            {props.modelMenu !== 'closed' ? <ModelMenu {...props} /> : null}
          </div>

          {props.activeWorking ? <button className="lc-agent-stop-button" onClick={() => void props.cancelActive()} aria-label="Stop task"><CircleStop size={18} strokeWidth={1.65} /></button>
            : <button className="lc-agent-send-button" disabled={props.submitting || !props.canSubmit} onClick={() => void props.sendMessage()} aria-label="Send task"><ArrowUp size={18} strokeWidth={2} /></button>}
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

  const currentMode = providerMode(props.modelSelection);
  const currentModeConfig = providerModes.find((mode) => mode.id === currentMode)!;
  const currentModels = props.modelOptions.filter((model) => model.providerId === currentModeConfig.providerId);
  const selectedModelId = props.modelSelection.includes('\0')
    ? props.modelSelection.slice(props.modelSelection.indexOf('\0') + 1)
    : '';

  function modeReady(mode: ProviderMode): boolean {
    const config = providerModes.find((item) => item.id === mode)!;
    return props.modelOptions.some((model) => model.providerId === config.providerId && model.available);
  }

  function chooseProviderMode(mode: ProviderMode) {
    const config = providerModes.find((item) => item.id === mode)!;
    const model = props.modelOptions.find((option) => option.providerId === config.providerId && option.available);
    if (!model) return;
    props.setModelSelection(modeValue(mode, model.modelId));
  }

  return <div className="lc-agent-popover model-popover" role="menu">
    <div className="model-provider-label">Mode</div>
    {providerModes.map((mode) => {
      const ready = modeReady(mode.id);
      return <button key={mode.id} className={currentMode === mode.id ? 'selected' : ''} disabled={!ready} onClick={() => chooseProviderMode(mode.id)}>
        <span><strong>{mode.label}</strong><small>{mode.description}{ready ? '' : ' · unavailable'}</small></span>
        {currentMode === mode.id ? <Check size={16} /> : null}
      </button>;
    })}
    <div className="popover-separator" />
    <div className="model-provider-label">{currentModeConfig.label} model</div>
    {currentModels.map((model) => <button key={`${currentMode}-${model.modelId}`} className={selectedModelId === model.modelId ? 'selected' : ''} disabled={!model.available} title={!model.available ? model.reason ?? 'Provider unavailable' : undefined} onClick={() => { props.setModelSelection(modeValue(currentMode, model.modelId)); props.setModelMenu('closed'); }}>
      <span><strong>{model.label}</strong><small>{model.description}{model.available ? '' : ` · ${model.reason ?? 'unavailable'}`}</small></span>
      {selectedModelId === model.modelId ? <Check size={16} /> : null}
    </button>)}
    {props.modelOptions.length === 0 ? <div className="model-menu-note">Choose or create a project to discover Ollama, Claude and GPT models.</div> : null}
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
  guidance: string;
  setGuidance: (value: string) => void;
  sendGuidance: () => Promise<void>;
  sendEscalation: (providerId: string, modelId: string, reasoningEffort?: JobReasoningEffort) => Promise<void>;
}) {
  const { job, currentInference } = props;
  const working = isWorking(job.status);
  const latestEvent = job.events.at(-1);
  const result = job.result;
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [job.turns.length]);

  const terminalAssistant =
    working ||
    job.status === 'waiting-guidance' ||
    job.status === 'error' ||
    job.status === 'cancelled' ||
    (job.status === 'success' && job.input.interactionMode !== 'chat');

  return <div className="lc-agent-thread" aria-live="polite">
    {job.turns.map((turn, index) => turn.role === 'user'
      ? <div className="thread-user-turn" key={turn.id}>
          <div className="user-message">{turn.content}</div>
          {index === 0 && job.input.context ? <div className="user-context-note">Context attached</div> : null}
        </div>
      : <div className="thread-assistant-turn" key={turn.id}>
          <div className="assistant-mark"><Sparkles size={18} strokeWidth={1.55} /></div>
          <div className="assistant-body">
            <div className="assistant-result-message"><p className="assistant-result-copy">{turn.content}</p></div>
          </div>
        </div>)}

    {terminalAssistant ? <div className="thread-assistant-turn">
      <div className={`assistant-mark ${working ? 'working' : ''}`}><Sparkles size={18} strokeWidth={1.55} /></div>
      <div className="assistant-body">
        {working ? <div className="assistant-stream-state">
          <div className="assistant-stream-title"><LoaderCircle className="assistant-spinner" size={16} /><strong>{currentInference?.streamState === 'generating' ? 'Writing' : currentInference?.streamState === 'reasoning' ? 'Thinking' : job.input.interactionMode === 'chat' ? 'Replying' : 'Working'}</strong></div>
          <p>{latestEvent?.title ?? (job.input.interactionMode === 'chat' ? 'Starting the response…' : 'Starting the task…')}</p>
          <div className="assistant-stream-meta">{currentInference?.stage ? <span>{currentInference.stage}</span> : null}{currentInference?.model ? <span>{currentInference.model}</span> : null}{currentInference?.runningMs ? <span>{duration(currentInference.runningMs)}</span> : null}</div>
        </div> : null}
        {job.status === 'waiting-guidance' && result?.escalation ? <GuidanceMessage job={job} guidance={props.guidance} setGuidance={props.setGuidance} onContinue={props.sendGuidance} onEscalate={props.sendEscalation} /> : null}
        {job.status === 'error' ? <div className="assistant-result-message error"><strong>Something went wrong</strong><p>{job.error ?? 'The task stopped unexpectedly.'}</p></div> : null}
        {job.status === 'cancelled' ? <div className="assistant-result-message muted-result"><strong>Task stopped</strong><p>The run was cancelled and will not resume automatically.</p></div> : null}
        {job.status === 'success' && result && job.input.interactionMode !== 'chat' ? <ResultMessage result={result} /> : null}
      </div>
    </div> : null}
    <div ref={endRef} aria-hidden="true" />
  </div>;
}

/**
 * One question at a time, keyboard-first: ↑/↓ move, 1–9 jump straight to an
 * option, Enter picks, Esc dismisses. The last row is a free-text answer, for
 * when none of the options is what the person meant.
 */
function DecisionPicker(props: {
  request: DecisionRequest;
  onAnswer: (questionId: string, value: string) => void;
  onDismiss: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [active, setActive] = useState(0);
  const [custom, setCustom] = useState('');
  /** While the free-text row has focus it is the answer, so no option row may
   *  also look selected — two highlighted rows at once read as a glitch. */
  const [customFocused, setCustomFocused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const question = props.request.questions[index];
  const isLast = index >= props.request.questions.length - 1;

  // A new question resets the cursor, otherwise it points at the wrong row.
  useEffect(() => {
    setActive(question?.recommendedOptionId
      ? Math.max(0, question.options.findIndex((option) => option.id === question.recommendedOptionId))
      : 0);
    setCustom('');
    listRef.current?.focus();
  }, [index, question]);

  if (!question) return null;

  function answer(value: string) {
    props.onAnswer(question.id, value);
    if (isLast) props.onDismiss();
    else setIndex((current) => current + 1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const count = question.options.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      answer(question.options[active]!.id);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      props.onDismiss();
      return;
    }
    // Number keys jump to an option, the way the reference picker does.
    const digit = Number.parseInt(event.key, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= count) {
      event.preventDefault();
      setActive(digit - 1);
      answer(question.options[digit - 1]!.id);
    }
  }

  return <div className="decision-picker" role="group" aria-label={question.question}>
    <div className="decision-picker-head">
      <strong>{question.question}</strong>
      <button onClick={props.onDismiss} aria-label="Dismiss"><X size={15} /></button>
    </div>

    <div className="decision-picker-options" ref={listRef} tabIndex={0} onKeyDown={onKeyDown} role="listbox" aria-activedescendant={`${question.id}-${active}`}>
      {question.options.map((option, position) => <button
        key={option.id}
        id={`${question.id}-${position}`}
        role="option"
        aria-selected={!customFocused && position === active}
        className={!customFocused && position === active ? 'active' : ''}
        onMouseEnter={() => { setCustomFocused(false); setActive(position); }}
        onClick={() => answer(option.id)}
      >
        <i aria-hidden="true">{position + 1}</i>
        <span>
          <span className="decision-option-label">{option.label}</span>
          {option.tradeoff ? <small>{option.tradeoff}</small> : null}
        </span>
        {!customFocused && position === active ? <kbd aria-hidden="true"><CornerDownLeft size={13} /></kbd> : null}
      </button>)}

      <div className="decision-picker-custom">
        <i aria-hidden="true"><Pencil size={13} /></i>
        <input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          onFocus={() => setCustomFocused(true)}
          onBlur={() => setCustomFocused(false)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && custom.trim()) answer(custom.trim());
            if (event.key === 'Escape') props.onDismiss();
          }}
          placeholder="Another option"
          aria-label="Answer in your own words"
        />
        <button onClick={() => custom.trim() ? answer(custom.trim()) : props.onDismiss()}>
          {custom.trim() ? 'Send' : 'Skip'}
        </button>
      </div>
    </div>
  </div>;
}

/**
 * The shortcut legend sits below the composer, not inside the card — the last
 * line it refers to ("or type below") is the composer itself.
 */
function DecisionHint({ request }: { request: DecisionRequest }) {
  return <p className="decision-picker-hint" aria-hidden="true">
    <kbd>↑</kbd><kbd>↓</kbd><span>to navigate</span>
    <kbd>↵</kbd><span>to select</span>
    <span>· or type below</span>
    {request.questions.length > 1 ? <em>{request.questions.length} questions</em> : null}
  </p>;
}

function GuidanceMessage(props: {
  job: Job;
  guidance: string;
  setGuidance: (value: string) => void;
  onContinue: () => Promise<void>;
  onEscalate: (providerId: string, modelId: string, reasoningEffort?: JobReasoningEffort) => Promise<void>;
}) {
  const escalation = props.job.result!.escalation!;
  const plan = props.job.escalationPlan;
  const recommended = plan?.recommended;
  const initialTarget = recommended
    ? `${recommended.providerId}\0${recommended.modelId}`
    : plan?.options[0]
      ? `${plan.options[0].providerId}\0${plan.options[0].modelId}`
      : '';
  const [target, setTarget] = useState(initialTarget);
  const [escalationEffort, setEscalationEffort] = useState<JobReasoningEffort>(recommended?.reasoningEffort ?? 'high');
  const [escalating, setEscalating] = useState(false);

  useEffect(() => {
    if (!recommended) return;
    setTarget(`${recommended.providerId}\0${recommended.modelId}`);
    setEscalationEffort(recommended.reasoningEffort);
  }, [recommended?.providerId, recommended?.modelId, recommended?.reasoningEffort]);

  const selectedOption = plan?.options.find(
    (option) => `${option.providerId}\0${option.modelId}` === target
  );

  async function escalate() {
    if (!selectedOption) return;
    setEscalating(true);
    try {
      await props.onEscalate(
        selectedOption.providerId,
        selectedOption.modelId,
        selectedOption.supportsReasoning ? escalationEffort : 'none'
      );
    } finally {
      setEscalating(false);
    }
  }

  return <div className="assistant-decision-message">
    <h2>{escalation.reason}</h2>
    {escalation.questions.map((question) => <p key={question}>{question}</p>)}

    {plan?.options.length ? <div className="inline-decision">
      <strong>Ollama can ask a cloud model for bounded guidance.</strong>
      {recommended ? <p>Recommended: {providerLabel(recommended.providerId)} · {recommended.modelId} · {recommended.reasoningEffort} effort. Ollama remains the task owner and resumes after the answer.</p> : null}
      <label className="composer-popover-field"><span><strong>Escalation model</strong></span>
        <select value={target} onChange={(event) => {
          const next = event.target.value;
          setTarget(next);
          const option = plan.options.find((item) => `${item.providerId}\0${item.modelId}` === next);
          if (option && !option.supportsReasoning) setEscalationEffort('none');
          else if (escalationEffort === 'none') setEscalationEffort('high');
        }}>
          {plan.options.map((option) => <option key={`${option.providerId}-${option.modelId}`} value={`${option.providerId}\0${option.modelId}`}>{providerLabel(option.providerId)} · {option.modelId}{recommended?.providerId === option.providerId && recommended.modelId === option.modelId ? ' — Recommended' : ''}</option>)}
        </select>
      </label>
      {selectedOption?.supportsReasoning ? <label className="composer-popover-field"><span><strong>Escalation effort</strong></span>
        <select value={escalationEffort === 'auto' ? 'high' : escalationEffort} onChange={(event) => setEscalationEffort(event.target.value as JobReasoningEffort)}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">Extra high</option>
          <option value="max">Max</option>
        </select>
      </label> : null}
      <button className="lc-agent-secondary-action" disabled={escalating || !selectedOption} onClick={() => void escalate()}>{escalating ? 'Consulting…' : recommended && target === `${recommended.providerId}\0${recommended.modelId}` ? `Escalate to recommended ${providerLabel(recommended.providerId)}` : 'Escalate to selected model'}</button>
    </div> : plan ? <p>{plan.reasons[0] ?? 'No cloud escalation target is available.'}</p> : null}

    <div className="inline-decision">
      <strong>Or continue manually</strong>
      <textarea className="inline-guidance-input" rows={3} value={props.guidance} onChange={(event) => props.setGuidance(event.target.value)} placeholder="Add the missing decision or evidence…" />
      <button className="lc-agent-secondary-action" disabled={!props.guidance.trim()} onClick={() => void props.onContinue()}>Resume with manual guidance</button>
    </div>
  </div>;
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
  const selection = job.input.modelSelection;
  const mode = selection?.mode === 'local-first'
    ? 'Local-first'
    : selection?.mode === 'explicit'
      ? providerLabel(selection.providerId)
      : 'Auto';
  return <aside className="lc-agent-progress-rail" aria-label="Task progress">
    <details className="progress-panel" open><summary>Progress <ChevronDown size={14} /></summary><div className="progress-list">{events.length === 0 ? <p>No progress yet.</p> : events.slice(0, 12).map((event, index) => <div className="progress-row" key={event.id}><span className={`progress-index ${index === 0 && isWorking(job.status) ? 'active' : ''}`}>{index === 0 && isWorking(job.status) ? <LoaderCircle size={11} /> : events.length - index}</span><div><strong>{event.title}</strong><small>{time(event.timestamp)}</small></div></div>)}</div></details>
    <details className="progress-panel"><summary>Context <ChevronDown size={14} /></summary><div className="context-list"><div><span>Workspace</span><code>{job.input.workspace}</code></div><div><span>Mode</span><strong>{mode}</strong></div><div><span>Model</span><strong>{currentInference?.model ?? result?.modelCalls?.at(-1)?.model ?? (selection && selection.mode !== 'auto' ? selection.modelId : 'Auto')}</strong></div><div><span>Effort</span><strong>{effort}</strong></div><div><span>Thinking</span><strong>{thinking}</strong></div><div><span>Round</span><strong>{job.rounds}</strong></div></div></details>
  </aside>;
}
