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
  ChevronRight,
  CircleStop,
  Code,
  Copy,
  CornerDownLeft,
  FileText,
  FlaskConical,
  FolderGit2,
  Lightbulb,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
  X,
  Zap
} from 'lucide-react';

import type { AdminProject, ModelSelection, ProjectConnectionPolicy } from './app-types.js';
import { FolderField } from './FolderField.js';
import { MarkdownMessage, stripMarkdownForSpeech } from './MarkdownMessage.js';
import { displayProfileName } from './native.js';
import { ShellDialog } from './ShellDialog.js';

type ReasoningEffortSelection = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type JobReasoningEffort = ReasoningEffortSelection | 'none';
type ModelMenuView = 'closed' | 'providers' | 'models' | 'legacy-models' | 'effort';

const NEW_TASK_ID = '__new__';
type ComposerMode = 'chat' | 'cowork';
const APPROX_CHARS_PER_TOKEN = 3.5;

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
interface JobActivity {
  action: string;
  detail?: string;
  reasoningSummary?: string;
  activityKind?:
    | 'connecting'
    | 'thinking'
    | 'reading'
    | 'searching-repository'
    | 'searching-web'
    | 'tool'
    | 'writing'
    | 'validating'
    | 'working';
  streamState?: 'waiting-response' | 'reasoning' | 'generating';
  providerId?: string;
  model?: string;
  eventCount?: number;
  outputChars?: number;
  elapsedMs?: number;
  updatedAt: string;
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
  activity?: JobActivity;
  activityHistory?: JobActivity[];
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
  createdAt?: string;
  available: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  providerDefault: boolean;
  projectDefault: boolean;
}
interface CatalogProvider {
  id: string;
  label?: string;
  providerFamily?: 'ollama' | 'anthropic' | 'openai';
  auth?: 'local' | 'api-key' | 'claude-account' | 'chatgpt-account';
  billing?: 'local' | 'api' | 'subscription';
  organizationLabel?: string;
  kind: 'local' | 'cloud';
  ready: boolean;
  reason?: string;
  models: CatalogModel[];
}
interface ProjectCatalog {
  scope?: 'personal' | 'project';
  projectId: string;
  defaultModel: ModelSelection;
  chatDefaultModel?: ModelSelection;
  coworkDefaultModel?: ModelSelection;
  connectionPolicy?: ProjectConnectionPolicy;
  providers: CatalogProvider[];
}
interface ModelOption {
  providerId: string;
  modelId: string;
  label: string;
  createdAt?: string;
  description: string;
  available: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  providerDefault: boolean;
  reason?: string;
}
interface ProviderModeConfig {
  id: string;
  label: string;
  description: string;
  providerId: string;
  providerFamily?: 'ollama' | 'anthropic' | 'openai';
  authKind?: CatalogProvider['auth'];
  authLabel?: string;
  ready: boolean;
  reason?: string;
}
interface ConversationContextInfo {
  estimatedTokens: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelLabel: string;
  providerLabel: string;
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
function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.max(0, Math.round(value)));
}
function estimateTokens(parts: Array<string | undefined>): number {
  const chars = parts.reduce((sum, part) => sum + (part?.length ?? 0), 0);
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}
function providerLabel(providerId: string): string {
  if (providerId === 'anthropic') return 'Claude';
  if (providerId === 'openai') return 'GPT';
  if (providerId === 'ollama') return 'Ollama';
  return providerId
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
function connectionDisplayName(provider: CatalogProvider): string {
  const fallback = providerLabel(provider.providerFamily ?? provider.id);
  const raw = provider.label?.trim();
  if (!raw) return fallback;
  const clean = raw
    .replace(/^API Key\s*·\s*/i, '')
    .replace(/^Account\s*·\s*(?:Claude|ChatGPT)\s*·\s*/i, '')
    .replace(/^(?:OpenAI|Claude)\s*·\s*(?=.+)/i, '')
    .trim();
  return clean || fallback;
}
function providerDescription(provider: CatalogProvider): string {
  if (provider.auth === 'local' || provider.kind === 'local') return 'Local model · stays on this computer';
  if (provider.auth === 'api-key') return 'API key · provider model list updates live';
  if (provider.auth === 'claude-account') return `Claude subscription${provider.organizationLabel ? ` · ${provider.organizationLabel}` : ''} · uses your CLI account`;
  if (provider.auth === 'chatgpt-account') return `ChatGPT subscription${provider.organizationLabel ? ` · ${provider.organizationLabel}` : ''} · uses your CLI account`;
  if (provider.id === 'anthropic') return 'API key · use the selected Claude model directly';
  if (provider.id === 'openai') return 'API key · use the selected OpenAI model directly';
  return `Use the selected ${provider.label ?? providerLabel(provider.id)} model directly`;
}
function providerAuthLabel(provider: CatalogProvider): string {
  if (provider.auth === 'api-key') return 'API KEY';
  if (provider.auth === 'claude-account' || provider.auth === 'chatgpt-account') return 'ACCOUNT';
  if (provider.auth === 'local' || provider.kind === 'local') return 'LOCAL';
  return 'PROVIDER';
}
function modelDescription(provider: CatalogProvider, model: CatalogModel): string {
  const identity = `${model.id} ${model.displayName}`.toLowerCase();
  if (model.id === 'default') return "Uses this account's default model";
  if (/(?:haiku|nano|mini|flash|fast)/.test(identity)) return 'Faster for quick responses';
  if (/(?:fable|opus|reasoning|\bo1\b|\bo3\b|\bo4\b)/.test(identity)) return 'For complex tasks';
  if (provider.auth === 'local' || provider.kind === 'local') return 'Private local model for everyday tasks';
  return 'Efficient for everyday tasks';
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
function providerMode(value: string): string {
  if (value.startsWith('local-first\0')) return 'local-first';
  const split = value.indexOf('\0');
  return split > 0 ? value.slice(0, split) : 'ollama';
}
function modeValue(mode: string, modelId: string): string {
  return `${mode === 'local-first' ? 'local-first' : mode}\0${modelId}`;
}
function allowedConnectionIds(catalog: ProjectCatalog, mode: ComposerMode): ReadonlySet<string> | undefined {
  const policy = catalog.connectionPolicy;
  if (!policy) return undefined;
  return new Set(mode === 'chat'
    ? policy.chat.allowedConnectionIds
    : policy.inference.allowedConnectionIds);
}
function catalogProviderAllowed(catalog: ProjectCatalog, providerId: string, mode: ComposerMode): boolean {
  const allowed = allowedConnectionIds(catalog, mode);
  return !allowed || allowed.has(providerId);
}
function firstAvailableModel(
  catalog: ProjectCatalog,
  providerId: string,
  mode: ComposerMode
): CatalogModel | undefined {
  if (!catalogProviderAllowed(catalog, providerId, mode)) return undefined;
  const provider = catalog.providers.find((item) => item.id === providerId && item.ready);
  return provider?.models.find((model) => model.available);
}
function catalogHasSelection(catalog: ProjectCatalog, value: string, mode: ComposerMode): boolean {
  const selection = parseModelValue(value);
  if (selection.mode === 'auto') return false;
  const providerId = selection.mode === 'local-first' ? 'ollama' : selection.providerId;
  if (!catalogProviderAllowed(catalog, providerId, mode)) return false;
  const provider = catalog.providers.find((item) => item.id === providerId && item.ready);
  return Boolean(provider?.models.some((model) => model.id === selection.modelId && model.available));
}
function defaultComposerSelection(catalog: ProjectCatalog, mode: ComposerMode): string {
  const scopedDefault = mode === 'chat' ? catalog.chatDefaultModel : catalog.coworkDefaultModel;
  const configured = modelValue(scopedDefault ?? catalog.defaultModel);
  if (configured !== 'auto' && catalogHasSelection(catalog, configured, mode)) return configured;
  const local = firstAvailableModel(catalog, 'ollama', mode);
  if (local) {
    return modeValue(catalog.scope === 'personal' || mode === 'chat' ? 'ollama' : 'local-first', local.id);
  }
  for (const provider of catalog.providers) {
    if (!catalogProviderAllowed(catalog, provider.id, mode)) continue;
    const model = firstAvailableModel(catalog, provider.id, mode);
    if (model) return modeValue(provider.id, model.id);
  }
  return 'auto';
}

const CLAUDE_FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku'] as const;

function claudeFamily(modelId: string): typeof CLAUDE_FAMILY_ORDER[number] | undefined {
  const id = modelId.toLowerCase();
  return CLAUDE_FAMILY_ORDER.find((family) => id.includes(`-${family}-`));
}

function claudeDisplayLabel(model: ModelOption): string {
  const family = claudeFamily(model.modelId);
  if (!family) return model.label;
  const version = model.modelId
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(new RegExp(`^${family}-`), '')
    .replace(/-\d{8}$/, '')
    .replace(/-/g, '.');
  return `${family.charAt(0).toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ''}`;
}

function claudeMenuModels(models: ModelOption[]): { recent: ModelOption[]; legacy: ModelOption[] } {
  if (models.length > 0 && !models.some((model) => claudeFamily(model.modelId))) {
    return { recent: models, legacy: [] };
  }
  const recent: ModelOption[] = [];
  const legacy: ModelOption[] = [];
  for (const family of CLAUDE_FAMILY_ORDER) {
    const familyModels = models
      .filter((model) => claudeFamily(model.modelId) === family)
      .sort((left, right) => {
        const created = Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? '');
        if (Number.isFinite(created) && created !== 0) return created;
        return right.modelId.localeCompare(left.modelId, undefined, { numeric: true });
      });
    if (familyModels[0]) recent.push(familyModels[0]);
    legacy.push(...familyModels.slice(1));
  }
  legacy.push(...models.filter((model) => !claudeFamily(model.modelId)));
  return { recent, legacy };
}

function providerMenuModels(
  provider: ProviderModeConfig,
  models: ModelOption[]
): { recent: ModelOption[]; legacy: ModelOption[] } {
  if (provider.providerFamily === 'anthropic') return claudeMenuModels(models);
  if (provider.providerFamily === 'openai' && models.length > 6) {
    return { recent: models.slice(0, 6), legacy: models.slice(6) };
  }
  return { recent: models, legacy: [] };
}

function moreModelsCopy(provider: ProviderModeConfig): { title: string; description: string; empty: string } {
  if (provider.providerFamily === 'anthropic') {
    return {
      title: 'More Claude models',
      description: 'Older Claude versions and dated snapshots',
      empty: 'No older Claude models are available.'
    };
  }
  if (provider.providerFamily === 'openai') {
    return {
      title: 'More OpenAI models',
      description: 'Older versions and specialized OpenAI models',
      empty: 'No additional OpenAI models are available.'
    };
  }
  return {
    title: `More ${provider.label} models`,
    description: 'Additional models from this provider',
    empty: 'No additional models are available.'
  };
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
  const [catalogRefreshNonce, setCatalogRefreshNonce] = useState(0);
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
  const [editingTurnId, setEditingTurnId] = useState<string>();
  const [modelSwitch, setModelSwitch] = useState<{ value: string; label: string }>();

  const active = activeId === NEW_TASK_ID ? undefined : jobs.find((job) => job.id === activeId);
  const pendingDecision = mockDecision
    ?? (active?.status === 'waiting-decision' ? active.decisionRequest : undefined);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const currentInference = worker?.inference?.current ?? undefined;
  const composerCatalogMode: ComposerMode = active?.input.interactionMode === 'chat' ? 'chat' : mode;

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
    setEditingTurnId(undefined);
    if (active?.input.interactionMode === 'chat' && active.input.modelSelection) {
      setModelSelection(modelValue(active.input.modelSelection));
      if (active.input.reasoningEffort && active.input.reasoningEffort !== 'none') {
        setEffort(active.input.reasoningEffort as ReasoningEffortSelection);
      }
      setThinkingEnabled(active.input.reasoningEffort !== 'none');
    }
  }, [activeId, active?.input.modelSelection, active?.input.reasoningEffort]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(undefined), 8_000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    let cancelled = false;
    const endpoint = selectedProjectId
      ? `/api/projects/${encodeURIComponent(selectedProjectId)}/catalog`
      : '/api/chat/catalog';
    void api<{ catalog: ProjectCatalog }>(endpoint)
      .then(({ catalog: next }) => {
        if (cancelled) return;
        setCatalog(next);
        const activeSelection = active?.input.interactionMode === 'chat'
          ? active.input.modelSelection
          : undefined;
        setModelSelection((current) => activeSelection
          ? modelValue(activeSelection)
          : catalogHasSelection(next, current, composerCatalogMode)
            ? current
            : defaultComposerSelection(next, composerCatalogMode));
      })
      .catch((next) => {
        if (cancelled) return;
        setCatalog(undefined);
        setModelSelection('auto');
        setError(next instanceof Error ? next.message : String(next));
      });
    return () => { cancelled = true; };
  }, [selectedProjectId, activeId, catalogRefreshNonce, composerCatalogMode]);

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
      if (catalog && !catalogProviderAllowed(catalog, provider.id, composerCatalogMode)) continue;
      for (const model of provider.models) {
        options.push({
          providerId: provider.id,
          modelId: model.id,
          label: model.displayName,
          createdAt: model.createdAt,
          description: modelDescription(provider, model),
          available: provider.ready && model.available,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          providerDefault: model.providerDefault,
          reason: provider.reason
        });
      }
    }
    return options;
  }, [catalog, composerCatalogMode]);

  const providerModes = useMemo<ProviderModeConfig[]>(() => {
    const modes = (catalog?.providers ?? [])
      .filter((provider) => !catalog || catalogProviderAllowed(catalog, provider.id, composerCatalogMode))
      .map((provider) => ({
      id: provider.id,
      label: connectionDisplayName(provider),
      description: providerDescription(provider),
      providerId: provider.id,
      providerFamily: provider.providerFamily ?? provider.id as 'ollama' | 'anthropic' | 'openai',
      authKind: provider.auth,
      authLabel: providerAuthLabel(provider),
      ready: provider.ready && provider.models.some((model) => model.available),
      reason: provider.reason
    }));
    const localIndex = modes.findIndex((mode) => mode.providerId === 'ollama');
    if (localIndex >= 0) {
      modes.splice(localIndex + 1, 0, {
        id: 'local-first',
        label: 'Local-first',
        description: 'Start on Ollama; ask before bounded cloud escalation',
        providerId: 'ollama',
        providerFamily: 'ollama',
        authKind: 'local',
        authLabel: 'LOCAL',
        ready: modes[localIndex]!.ready,
        reason: modes[localIndex]!.reason
      });
    }
    return modes;
  }, [catalog, composerCatalogMode]);

  const selectedMode = providerMode(modelSelection);
  const selectedModeConfig = providerModes.find((item) => item.id === selectedMode)
    ?? providerModes.find((item) => item.ready)
    ?? {
      id: selectedMode,
      label: providerLabel(selectedMode),
      description: '',
      providerId: selectedMode === 'local-first' ? 'ollama' : selectedMode,
      ready: false
    };
  const selectedModelId = modelSelection.includes('\0') ? modelSelection.slice(modelSelection.indexOf('\0') + 1) : '';
  const selectedModel = modelOptions.find(
    (model) => model.providerId === selectedModeConfig.providerId && model.modelId === selectedModelId
  );
  const modelLabel = selectedModeConfig.label;
  const effortLabel = effortOptions.find((option) => option.id === effort)?.label ?? 'Default';
  const displayedEffortLabel = thinkingEnabled ? effortLabel : 'Thinking off';

  const conversationContext = useMemo<ConversationContextInfo | undefined>(() => {
    const conversationMode = active?.input.interactionMode ?? mode;
    if (conversationMode !== 'chat') return undefined;

    const selection = active?.input.modelSelection ?? parseModelValue(modelSelection);
    const providerId = selection?.mode === 'explicit'
      ? selection.providerId
      : selection?.mode === 'local-first'
        ? 'ollama'
        : selectedModeConfig.providerId;
    const modelId = selection && selection.mode !== 'auto' ? selection.modelId : selectedModelId;
    const model = modelOptions.find((candidate) =>
      candidate.providerId === providerId && candidate.modelId === modelId
    );
    const visibleParts: Array<string | undefined> = [];

    if (active?.input.interactionMode === 'chat') {
      for (const turn of active.turns) {
        visibleParts.push(editingTurnId === turn.id ? goal : turn.content);
      }
      if (!editingTurnId && goal.trim()) visibleParts.push(goal);
      visibleParts.push(active.input.context);
    } else {
      visibleParts.push(goal, context);
    }

    const estimatedTokens = estimateTokens(visibleParts);
    const localFallback = providerId === 'ollama';
    return {
      estimatedTokens,
      contextWindow: model?.contextWindow ?? (localFallback ? 16_384 : undefined),
      maxOutputTokens: model?.maxOutputTokens ?? (localFallback ? 2_048 : undefined),
      modelLabel: model?.label ?? currentInference?.model ?? (modelId || providerLabel(providerId)),
      providerLabel: providerLabel(providerId)
    };
  }, [
    active?.id,
    active?.input.interactionMode,
    active?.input.modelSelection,
    active?.input.context,
    active?.turns,
    context,
    currentInference?.model,
    editingTurnId,
    goal,
    mode,
    modelOptions,
    modelSelection,
    selectedModeConfig.providerId,
    selectedModelId
  ]);

  function chooseProject(projectId: string) {
    setSelectedProjectId(projectId);
    setProjectMenu(false);
    if (projectId) localStorage.setItem('local-coder.project', projectId);
    else localStorage.removeItem('local-coder.project');
  }

  function chooseMode(next: ComposerMode) {
    localStorage.setItem('local-coder.composer-mode', next);
    setMode(next);
    if (catalog && !catalogHasSelection(catalog, modelSelection, next)) {
      setModelSelection(defaultComposerSelection(catalog, next));
    }
    if (next === 'cowork' && !selectedProject && !workspace.trim()) {
      setModelMenu('closed');
      if (projects.length > 0) setProjectMenu(true);
      else setExtrasOpen(true);
    }
  }

  function chooseModelSelection(value: string) {
    if (value === modelSelection) return;
    const activeValue = active?.input.modelSelection ? modelValue(active.input.modelSelection) : undefined;
    const nextSelection = parseModelValue(value);
    const providerId = nextSelection.mode === 'explicit'
      ? nextSelection.providerId
      : nextSelection.mode === 'local-first' ? 'ollama' : '';
    const nextModel = nextSelection.mode === 'auto'
      ? undefined
      : modelOptions.find((model) => model.providerId === providerId && model.modelId === nextSelection.modelId);
    const label = nextModel
      ? `${providerLabel(providerId)} · ${providerId === 'anthropic' ? claudeDisplayLabel(nextModel) : nextModel.label}`
      : providerLabel(providerId);
    if (active?.input.interactionMode === 'chat' && activeValue && value !== activeValue) {
      setModelMenu('closed');
      setModelSwitch({ value, label });
      return;
    }
    setModelSelection(value);
  }

  async function createJob() {
    if (!goal.trim()) return;

    if (MOCK_DECISION_COMMAND.test(goal.trim())) {
      setGoal('');
      setMockAnswers([]);
      setMockDecision(MOCK_DECISION);
      return;
    }

    const defaultWorkspace = localStorage.getItem('local-coder.workspace')?.trim() ?? '';
    const effectiveWorkspace = selectedProject?.workspace ?? (workspace.trim() || defaultWorkspace);
    if (!effectiveWorkspace && mode === 'cowork') {
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
      const modelOverrideAllowed = Boolean(selectedProject) || mode === 'chat';
      const { job } = await api<{ job: Job }>('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          projectId: selectedProject?.id || undefined,
          workspace: effectiveWorkspace,
          goal: goal.trim(),
          context: context.trim() || undefined,
          maxRepairRounds: 1,
          interactionMode: mode,
          modelSelection: modelOverrideAllowed ? parseModelValue(modelSelection) : undefined,
          reasoningEffort: modelOverrideAllowed ? (thinkingEnabled ? effort : 'none') : undefined
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
        body: JSON.stringify({
          message: goal.trim(),
          modelSelection: parseModelValue(modelSelection),
          reasoningEffort: thinkingEnabled ? effort : 'none'
        })
      });
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
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

  async function retryChatTurn(turnId: string, message?: string) {
    if (!active || active.input.interactionMode !== 'chat' || !canFollowUp(active.status)) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const { job } = await api<{ job: Job }>(`/api/jobs/${active.id}/turns/${turnId}/retry`, {
        method: 'POST',
        body: JSON.stringify({
          ...(message === undefined ? {} : { message }),
          modelSelection: parseModelValue(modelSelection),
          reasoningEffort: thinkingEnabled ? effort : 'none'
        })
      });
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setEditingTurnId(undefined);
      setGoal('');
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setSubmitting(false);
    }
  }

  function beginEditTurn(turn: JobTurn) {
    if (!active || active.input.interactionMode !== 'chat' || !canFollowUp(active.status)) return;
    setEditingTurnId(turn.id);
    setGoal(turn.content);
    setMode('chat');
    localStorage.setItem('local-coder.composer-mode', 'chat');
  }

  function cancelEditTurn() {
    setEditingTurnId(undefined);
    setGoal('');
  }

  async function sendCurrentMessage() {
    if (!goal.trim()) return;
    if (editingTurnId && active?.input.interactionMode === 'chat') {
      await retryChatTurn(editingTurnId, goal.trim());
      return;
    }
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
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void sendCurrentMessage();
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
        onEditTurn={beginEditTurn}
        onResendTurn={(turnId) => retryChatTurn(turnId)}
      />}

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
        refreshCatalog={() => setCatalogRefreshNonce((value) => value + 1)}
        modelOptions={modelOptions}
        providerModes={providerModes}
        modelSelection={modelSelection}
        setModelSelection={chooseModelSelection}
        modelLabel={modelLabel}
        selectedModelLabel={selectedModel?.label}
        contextInfo={conversationContext}
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
        allowLocalFirst={Boolean(selectedProject)}
        editingMessage={Boolean(editingTurnId)}
        cancelEditing={cancelEditTurn}
        placeholder={pendingDecision ? 'Or answer directly…' : undefined}
      />

      <ShellDialog
        request={modelSwitch ? {
          kind: 'confirm',
          title: 'Switch model?',
          message: `Your next response will use ${modelSwitch.label}. It may take longer and use more tokens because the new model must read this conversation’s history.`,
          confirmLabel: `Switch to ${modelSwitch.label}`,
          onConfirm: () => setModelSelection(modelSwitch.value)
        } : undefined}
        onClose={() => setModelSwitch(undefined)}
      />

      {pendingDecision ? <DecisionHint request={pendingDecision} /> : null}

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

function ConversationContextBadge({ info }: { info: ConversationContextInfo }) {
  const remaining = info.contextWindow === undefined
    ? undefined
    : Math.max(0, info.contextWindow - info.estimatedTokens);
  const ratio = info.contextWindow && info.contextWindow > 0
    ? info.estimatedTokens / info.contextWindow
    : 0;
  const level = ratio >= 0.95 ? 'critical' : ratio >= 0.8 ? 'warning' : 'normal';
  const label = info.contextWindow
    ? `≈${compactTokens(info.estimatedTokens)} / ${compactTokens(info.contextWindow)}`
    : `≈${compactTokens(info.estimatedTokens)} tokens`;
  const percent = info.contextWindow ? Math.min(100, Math.round(ratio * 100)) : undefined;
  const accessible = `${info.providerLabel} ${info.modelLabel}. ${info.estimatedTokens.toLocaleString()} tokens used${info.contextWindow ? ` of ${info.contextWindow.toLocaleString()}` : ''}.`;

  return <span
    className="conversation-context-badge"
    data-level={level}
    aria-label={accessible}
    tabIndex={0}
  >
    {label}
    <span className="conversation-context-tooltip" role="tooltip">
      <small>Context window</small>
      <strong>{percent === undefined ? 'Usage estimate' : `${percent}% full`}</strong>
      <span>{compactTokens(info.estimatedTokens)}{info.contextWindow ? ` / ${compactTokens(info.contextWindow)}` : ''} tokens used</span>
      {remaining !== undefined ? <em>{compactTokens(remaining)} tokens available</em> : null}
    </span>
  </span>;
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
  allowLocalFirst: boolean;
  placeholder?: string;
  extrasOpen: boolean;
  setExtrasOpen: (value: boolean) => void;
  modelMenu: ModelMenuView;
  setModelMenu: (value: ModelMenuView) => void;
  refreshCatalog: () => void;
  modelOptions: ModelOption[];
  providerModes: ProviderModeConfig[];
  modelSelection: string;
  setModelSelection: (value: string) => void;
  modelLabel: string;
  selectedModelLabel?: string;
  contextInfo?: ConversationContextInfo;
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
  editingMessage: boolean;
  cancelEditing: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, Math.min(320, window.innerHeight * 0.4))}px`;
  }, [props.goal]);

  useEffect(() => {
    if (!props.editingMessage) return;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(props.goal.length, props.goal.length);
  }, [props.editingMessage]);

  return <div className="lc-agent-composer-wrap">
    <div className="lc-agent-composer">
      {props.editingMessage ? <div className="composer-editing-banner">
        <span><Pencil size={13} />Editing message</span>
        <button onClick={props.cancelEditing}>Cancel</button>
      </div> : null}
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
                <span><strong>No project</strong><small>Use personal Chat credentials without repository access</small></span>
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
          {props.contextInfo ? <ConversationContextBadge info={props.contextInfo} /> : null}
          <div className="composer-menu-anchor model-menu-anchor">
            <button className="model-effort-trigger" aria-haspopup="menu" aria-expanded={props.modelMenu !== 'closed'} onClick={() => { props.setExtrasOpen(false); props.setProjectMenu(false); if (props.modelMenu === 'closed') props.refreshCatalog(); props.setModelMenu(props.modelMenu === 'closed' ? 'providers' : 'closed'); }}>
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
  providerModes: ProviderModeConfig[];
  modelSelection: string;
  setModelSelection: (value: string) => void;
  allowLocalFirst: boolean;
  effort: ReasoningEffortSelection;
  setEffort: (value: ReasoningEffortSelection) => void;
  effortLabel: string;
  thinkingEnabled: boolean;
  setThinkingEnabled: (value: boolean) => void;
}) {
  const [browsingMode, setBrowsingMode] = useState<string>();

  if (props.modelMenu === 'effort') {
    return <div className="lc-agent-popover model-popover effort-popover" role="menu">
      <button className="popover-back" onClick={() => props.setModelMenu('providers')}><ChevronLeft size={16} /><strong>Effort</strong></button>
      <div className="popover-separator" />
      {effortOptions.map((option) => <button key={option.id} className={props.effort === option.id ? 'selected' : ''} onClick={() => { props.setEffort(option.id); props.setModelMenu('providers'); }}>
        <span><strong>{option.label}{option.id === 'auto' ? <em>Default</em> : null}</strong><small>{option.description}</small></span>
        {props.effort === option.id ? <Check size={16} /> : null}
      </button>)}
    </div>;
  }

  const selectedMode = providerMode(props.modelSelection);
  const currentMode = browsingMode ?? selectedMode;
  const currentModeConfig = props.providerModes.find((mode) => mode.id === currentMode)
    ?? props.providerModes.find((mode) => mode.ready)
    ?? {
      id: currentMode,
      label: providerLabel(currentMode),
      description: '',
      providerId: currentMode === 'local-first' ? 'ollama' : currentMode,
      ready: false
  };
  const currentModels = props.modelOptions.filter((model) => model.providerId === currentModeConfig.providerId);
  const modelGroups = providerMenuModels(currentModeConfig, currentModels);
  const moreCopy = moreModelsCopy(currentModeConfig);
  const selectedModelId = props.modelSelection.includes('\0')
    ? props.modelSelection.slice(props.modelSelection.indexOf('\0') + 1)
    : '';

  function modeReady(mode: ProviderModeConfig): boolean {
    if (mode.id === 'local-first' && !props.allowLocalFirst) return false;
    return mode.ready && props.modelOptions.some((model) => model.providerId === mode.providerId && model.available);
  }

  function chooseProviderMode(mode: ProviderModeConfig) {
    if (mode.id === 'local-first' && !props.allowLocalFirst) return;
    setBrowsingMode(mode.id);
    props.setModelMenu('models');
  }

  if (props.modelMenu === 'models' || props.modelMenu === 'legacy-models') {
    const legacy = props.modelMenu === 'legacy-models';
    const visibleModels = legacy ? modelGroups.legacy : modelGroups.recent;
    return <div className="lc-agent-popover model-popover model-list-popover" role="menu">
      <button className="popover-back" onClick={() => props.setModelMenu(legacy ? 'models' : 'providers')}><ChevronLeft size={16} /><strong>{legacy ? moreCopy.title : 'Models'}</strong></button>
      <div className="popover-separator" />
      {visibleModels.map((model) => <button key={`${currentMode}-${model.modelId}`} className={selectedModelId === model.modelId ? 'selected' : ''} disabled={!model.available} title={!model.available ? model.reason ?? 'Provider unavailable' : undefined} onClick={() => { props.setModelSelection(modeValue(currentMode, model.modelId)); props.setModelMenu('closed'); }}>
        <span><strong>{currentModeConfig.providerFamily === 'anthropic' ? claudeDisplayLabel(model) : model.label}</strong><small>{model.description}{model.available ? '' : ` · ${model.reason ?? 'unavailable'}`}</small></span>
        {selectedModelId === model.modelId ? <Check size={16} /> : null}
      </button>)}
      {!legacy && modelGroups.legacy.length > 0 ? <><div className="popover-separator" /><button className="popover-row-link" onClick={() => props.setModelMenu('legacy-models')}><span><strong>More models</strong><small>{moreCopy.description}</small></span><ChevronRight size={16} /></button></> : null}
      {visibleModels.length === 0 ? <div className="model-menu-note">{legacy ? moreCopy.empty : currentModeConfig.reason ?? 'No Chat models are available for this connection. Check its authentication and availability.'}</div> : null}
    </div>;
  }

  return <div className="lc-agent-popover model-popover" role="menu">
    <div className="model-provider-label">Connections</div>
    {props.providerModes.map((mode) => {
      const ready = modeReady(mode);
      const unavailable = mode.id === 'local-first' && !props.allowLocalFirst
        ? 'Requires a project'
        : ready ? '' : mode.reason ?? 'Unavailable';
      return <button key={mode.id} className={selectedMode === mode.id ? 'selected' : ''} disabled={!ready} title={!ready ? mode.reason : undefined} onClick={() => chooseProviderMode(mode)}>
        <span><strong>{mode.label}{mode.authLabel ? <span className={`model-auth-badge status-pill ${mode.authKind === 'api-key' ? 'live' : mode.authKind === 'local' ? 'good' : mode.authKind === 'claude-account' || mode.authKind === 'chatgpt-account' ? 'warn' : ''}`}>{mode.authLabel}</span> : null}</strong><small>{mode.description}{unavailable ? ` · ${unavailable}` : ''}</small></span>
        {ready ? <ChevronRight size={16} /> : null}
      </button>;
    })}
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

function MessageActions(props: {
  turn: JobTurn;
  canModify?: boolean;
  onEdit?: () => void;
  onResend?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [reading, setReading] = useState(false);
  const canRead = props.turn.role === 'assistant' &&
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined';

  useEffect(() => () => {
    if (reading) window.speechSynthesis?.cancel();
  }, [reading]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.turn.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  }

  function toggleRead() {
    if (!canRead) return;
    if (reading) {
      window.speechSynthesis.cancel();
      setReading(false);
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(stripMarkdownForSpeech(props.turn.content));
    utterance.onend = () => setReading(false);
    utterance.onerror = () => setReading(false);
    setReading(true);
    window.speechSynthesis.speak(utterance);
  }

  return <div className="message-actions" aria-label={`${props.turn.role} message actions`}>
    {props.turn.role === 'user' && props.canModify && props.onEdit ? <button onClick={props.onEdit} title="Edit message" aria-label="Edit message"><Pencil size={14} /></button> : null}
    {props.turn.role === 'user' && props.canModify && props.onResend ? <button onClick={props.onResend} title="Send again" aria-label="Send again"><RotateCcw size={14} /></button> : null}
    <button onClick={() => void copy()} title={copied ? 'Copied' : 'Copy'} aria-label={copied ? 'Copied' : 'Copy message'}><Copy size={14} /></button>
    {canRead ? <button onClick={toggleRead} title={reading ? 'Stop reading' : 'Read aloud'} aria-label={reading ? 'Stop reading' : 'Read aloud'}>{reading ? <Square size={13} /> : <Volume2 size={14} />}</button> : null}
  </div>;
}

function chatProgress(
  state?: string,
  model?: string,
  activity?: Job['activity'],
  latestEvent?: JobEvent
): { title: string; detail: string; kind: 'connecting' | 'thinking' | 'writing' | 'working' } {
  const name = model ?? 'Local Coder';
  const activityText = `${activity?.action ?? ''} ${latestEvent?.title ?? ''}`.toLowerCase();
  const streamState = activity?.streamState ?? state;
  if (streamState === 'waiting' || activityText.includes('connecting') || activityText.includes('waiting')) {
    return {
      title: 'Connecting',
      kind: 'connecting',
      detail: activity?.reasoningSummary ?? activity?.detail ?? `${name} is opening a response stream.`
    };
  }
  if (streamState === 'reasoning' || activityText.includes('reasoning') || activityText.includes('thinking')) {
    return {
      title: 'Thinking',
      kind: 'thinking',
      detail: activity?.reasoningSummary ?? activity?.detail ?? `${name} is analyzing the request and deciding how to answer.`
    };
  }
  if (streamState === 'generating' || activityText.includes('drafting') || activityText.includes('writing')) {
    return {
      title: 'Writing',
      kind: 'writing',
      detail: activity?.reasoningSummary ?? activity?.detail ?? `${name} is turning the result into a response.`
    };
  }
  return {
    title: activity?.action ?? 'Analyzing',
    kind: 'working',
    detail: activity?.reasoningSummary ?? activity?.detail ?? `${name} is reading the conversation and preparing its approach.`
  };
}

type ActivityKind = 'connecting' | 'thinking' | 'reading' | 'searching' | 'writing' | 'validating' | 'working';

interface ActivityDisplay {
  key: string;
  label: string;
  target?: string;
  explanation?: string;
  timestamp: string;
  kind: ActivityKind;
}

function displayActivity(activity: JobActivity, fallbackKind: ReturnType<typeof chatProgress>['kind'] = 'working'): ActivityDisplay {
  const action = activity.action.trim();
  const text = `${action} ${activity.detail ?? ''}`.toLowerCase();
  let kind: ActivityKind = fallbackKind;
  let label = action || 'Working';
  let target = activity.detail;

  if (activity.activityKind === 'searching-web') {
    kind = 'searching';
    label = 'Searching the web';
  } else if (activity.activityKind === 'searching-repository') {
    kind = 'searching';
    label = 'Searching the repository';
  } else if (activity.activityKind === 'reading') {
    kind = 'reading';
    label = 'Reading';
  } else if (activity.activityKind === 'thinking') {
    kind = 'thinking';
    label = 'Thinking';
  } else if (activity.activityKind === 'writing') {
    kind = 'writing';
    label = 'Writing the response';
  } else if (activity.activityKind === 'validating') {
    kind = 'validating';
    label = 'Running checks';
  } else if (activity.activityKind === 'connecting') {
    kind = 'connecting';
    label = 'Connecting';
  } else if (activity.activityKind === 'tool') {
    kind = 'working';
    label = action || 'Using a tool';
  } else if (!activity.activityKind && /research broker|external knowledge|internet|\bweb\b/.test(text)) {
    kind = 'searching';
    label = 'Searching the web';
  } else if (!activity.activityKind && /searching the repository|search workspace|repository search/.test(text)) {
    kind = 'searching';
    label = 'Searching the repository';
  } else if (!activity.activityKind && /reading repository file|reading file|read workspace file/.test(text)) {
    kind = 'reading';
    label = 'Reading';
  } else if (!activity.activityKind && /scan(?:ning)? the workspace|repository map|ranked repository context/.test(text)) {
    kind = 'reading';
    label = 'Scanning the workspace';
  } else if (!activity.activityKind && (activity.streamState === 'reasoning' || /reasoning|thinking|analy[sz]|investigat|planning|preflight/.test(text))) {
    kind = 'thinking';
    label = 'Thinking';
  } else if (!activity.activityKind && (activity.streamState === 'generating' || /draft|writing|generating|compos|report/.test(text))) {
    kind = 'writing';
    label = 'Writing the response';
  } else if (!activity.activityKind && /validat|running checks|test suite|typecheck|lint/.test(text)) {
    kind = 'validating';
    label = 'Running checks';
  } else if (!activity.activityKind && (activity.streamState === 'waiting-response' || /connect|waiting/.test(text))) {
    kind = 'connecting';
    label = 'Connecting';
  }

  if (kind === 'reading' && label === 'Reading' && !target) target = 'repository context';
  return {
    key: `${activity.updatedAt}-${action}-${target ?? ''}`,
    label,
    target,
    explanation: activity.reasoningSummary,
    timestamp: activity.updatedAt,
    kind
  };
}

function compactActivityHistory(items: ActivityDisplay[]): ActivityDisplay[] {
  return items.filter((item, index) => {
    const previous = items[index - 1];
    return !previous || previous.label !== item.label || previous.target !== item.target;
  }).slice(-12);
}

function visibleActivityTarget(value?: string): string | undefined {
  const target = value?.trim();
  if (!target || /(?:^|\s)provider=.+(?:stream events|output chars|elapsed=)/i.test(target)) return undefined;
  return target;
}

function ChatActivityCard(props: {
  job: Job;
  progress: ReturnType<typeof chatProgress>;
  currentInference?: NonNullable<WorkerStatus['inference']>['current'];
  latestEvent?: JobEvent;
  complete?: boolean;
}) {
  const { job, progress, currentInference, latestEvent, complete = false } = props;
  const activity = job.activity;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const startedAt = useRef(Date.now());

  useEffect(() => {
    startedAt.current = Date.now();
    setOpen(false);
  }, [job.id, job.status]);

  useEffect(() => {
    if (complete) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [complete]);

  const firstHistoricActivity = job.activityHistory?.at(0);
  const lastHistoricActivity = job.activityHistory?.at(-1);
  const historicElapsedMs = firstHistoricActivity && lastHistoricActivity
    ? Math.max(1_000, Date.parse(lastHistoricActivity.updatedAt) - Date.parse(firstHistoricActivity.updatedAt))
    : undefined;
  const elapsedMs = activity?.elapsedMs
    ?? lastHistoricActivity?.elapsedMs
    ?? currentInference?.runningMs
    ?? (complete ? historicElapsedMs : undefined)
    ?? Math.max(0, now - startedAt.current);
  const activities = compactActivityHistory([
    ...(job.activityHistory ?? []).map((item) => displayActivity(item, progress.kind)),
    ...(activity && job.activityHistory?.at(-1)?.updatedAt !== activity.updatedAt
      ? [displayActivity(activity, progress.kind)]
      : [])
  ]);
  const fallback: ActivityDisplay = {
    key: latestEvent?.id ?? `fallback-${progress.kind}`,
    label: progress.title,
    target: progress.detail,
    timestamp: latestEvent?.timestamp ?? new Date(now).toISOString(),
    kind: progress.kind
  };
  const steps = activities.length ? activities : [fallback];
  const current = steps.at(-1)!;
  const currentTarget = visibleActivityTarget(current.target);

  return <section className="assistant-activity-card assistant-live-activity" data-state={current.kind} aria-label={complete ? 'Response activity summary' : 'Live response activity'} aria-live="off">
    <button className="assistant-activity-toggle assistant-live-activity-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span className="assistant-live-copy" role={complete ? undefined : 'status'} aria-live={complete ? undefined : 'polite'}>
        <strong>{complete ? `Thought for ${duration(elapsedMs)}` : current.label}</strong>
        {!complete && currentTarget ? <span>{currentTarget}</span> : null}
      </span>
      <ChevronRight className="assistant-live-chevron" size={16} aria-hidden="true" />
    </button>

    {open ? <div className="assistant-activity-steps assistant-live-history" aria-label="Activity history">
      {steps.map((step, index) => <div className={`assistant-live-step ${index === steps.length - 1 && !complete ? 'active' : 'done'}`} key={step.key}>
        <span className="assistant-live-rail" aria-hidden="true"><i /></span>
        <div>
          <strong>{step.label}</strong>
          {visibleActivityTarget(step.target) ? <p>{visibleActivityTarget(step.target)}</p> : null}
        </div>
      </div>)}
      <span className="assistant-toggle-copy">{open ? 'Hide activity' : 'Show activity'}</span>
    </div> : null}
  </section>;
}

function TaskThread(props: {
  job: Job;
  currentInference?: NonNullable<WorkerStatus['inference']>['current'];
  guidance: string;
  setGuidance: (value: string) => void;
  sendGuidance: () => Promise<void>;
  sendEscalation: (providerId: string, modelId: string, reasoningEffort?: JobReasoningEffort) => Promise<void>;
  onEditTurn: (turn: JobTurn) => void;
  onResendTurn: (turnId: string) => Promise<void>;
}) {
  const { job, currentInference } = props;
  const working = isWorking(job.status);
  const latestEvent = job.events.at(-1);
  const result = job.result;
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [job.turns.length, job.status]);

  const terminalAssistant =
    working ||
    job.status === 'waiting-guidance' ||
    job.status === 'error' ||
    job.status === 'cancelled' ||
    (job.status === 'success' && job.input.interactionMode !== 'chat');
  const selectedChatModel = job.input.modelSelection && job.input.modelSelection.mode !== 'auto'
    ? job.input.modelSelection.modelId
    : undefined;
  const progress = chatProgress(
    currentInference?.streamState,
    job.activity?.model ?? selectedChatModel ?? currentInference?.model,
    job.activity,
    latestEvent
  );

  return <div className="lc-agent-thread" aria-live="polite">
    {job.turns.map((turn, index) => turn.role === 'user'
      ? <div className="thread-user-turn" key={turn.id}>
          <div className="message-turn-shell user-turn-shell">
            <div className="user-message">{turn.content}</div>
            <MessageActions
              turn={turn}
              canModify={!working && canFollowUp(job.status)}
              onEdit={() => props.onEditTurn(turn)}
              onResend={() => void props.onResendTurn(turn.id)}
            />
          </div>
          {index === 0 && job.input.context ? <div className="user-context-note">Context attached</div> : null}
        </div>
      : <div className="thread-assistant-turn" key={turn.id}>
          <div className="assistant-mark"><Sparkles size={18} strokeWidth={1.55} /></div>
          <div className="assistant-body message-turn-shell">
            {index === job.turns.length - 1 && job.status === 'success' && (job.activityHistory?.length ?? 0) > 0 ? <ChatActivityCard
              job={job}
              progress={progress}
              currentInference={currentInference}
              latestEvent={latestEvent}
              complete
            /> : null}
            <div className="assistant-result-message"><MarkdownMessage content={turn.content} /></div>
            <MessageActions turn={turn} />
          </div>
        </div>)}

    {terminalAssistant ? <div className="thread-assistant-turn">
      <div className={`assistant-mark ${working ? 'working' : ''}`}><Sparkles size={18} strokeWidth={1.55} /></div>
      <div className="assistant-body">
        {working ? <ChatActivityCard
          job={job}
          progress={progress}
          currentInference={currentInference}
          latestEvent={latestEvent}
        /> : null}
        {job.status === 'waiting-guidance' && result?.escalation ? <GuidanceMessage job={job} guidance={props.guidance} setGuidance={props.setGuidance} onContinue={props.sendGuidance} onEscalate={props.sendEscalation} /> : null}
        {job.status === 'error' ? <div className="assistant-result-message error"><strong>Something went wrong</strong><p>{job.error ?? 'The task stopped unexpectedly.'}</p></div> : null}
        {job.status === 'cancelled' ? <div className="assistant-result-message muted-result"><strong>Task stopped</strong><p>The run was cancelled and will not resume automatically.</p></div> : null}
        {job.status === 'success' && result && job.input.interactionMode !== 'chat' ? <>
          {(job.activityHistory?.length ?? 0) > 0 ? <ChatActivityCard job={job} progress={progress} currentInference={currentInference} latestEvent={latestEvent} complete /> : null}
          <ResultMessage result={result} />
        </> : null}
      </div>
    </div> : null}
    <div ref={endRef} aria-hidden="true" />
  </div>;
}

function DecisionPicker(props: {
  request: DecisionRequest;
  onAnswer: (questionId: string, value: string) => void;
  onDismiss: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [active, setActive] = useState(0);
  const [custom, setCustom] = useState('');
  const [customFocused, setCustomFocused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const question = props.request.questions[index];
  const isLast = index >= props.request.questions.length - 1;

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
