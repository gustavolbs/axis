import { randomUUID } from 'node:crypto';

import type { EngineeringProgress } from './engineering-progress.js';

export type InferenceStage =
  | 'investigation'
  | 'planning'
  | 'implementation'
  | 'review'
  | 'repo-learning'
  | 'other';

export interface InferenceSnapshot {
  id: string;
  stage: InferenceStage;
  model: string;
  startedAt: string;
  runningMs: number;
}

export interface CompletedInferenceSnapshot {
  id: string;
  stage: InferenceStage;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'success' | 'error';
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

interface ActiveInference {
  id: string;
  stage: InferenceStage;
  model: string;
  startedAtMs: number;
}

export function classifyInferenceStage(systemPrompt: string): InferenceStage {
  const prompt = systemPrompt.toLowerCase();
  if (prompt.includes('investigation stage of a local software-engineering agent')) {
    return 'investigation';
  }
  if (prompt.includes('reasoning/planning stage of a local software-engineering agent')) {
    return 'planning';
  }
  if (prompt.includes('adversarial software-engineering reviewer')) {
    return 'review';
  }
  if (prompt.includes('durable repository intelligence')) {
    return 'repo-learning';
  }
  if (prompt.includes('local coding execution model') || prompt.includes('local coding executor')) {
    return 'implementation';
  }
  return 'other';
}

function section(prompt: string, name: string, max = 1200): string | undefined {
  const marker = `# ${name}`;
  const start = prompt.indexOf(marker);
  if (start < 0) return undefined;
  const bodyStart = start + marker.length;
  const next = prompt.indexOf('\n# ', bodyStart);
  const value = prompt.slice(bodyStart, next < 0 ? undefined : next).trim();
  return value ? value.slice(0, max) : undefined;
}

function bulletPaths(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const paths = value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  return paths.length > 0 ? paths : undefined;
}

export function progressAtInferenceStart(stage: InferenceStage, userPrompt: string): Partial<EngineeringProgress> {
  const goal = section(userPrompt, 'GOAL') ?? section(userPrompt, 'ORIGINAL GOAL') ?? section(userPrompt, 'TASK');
  const editableFiles = bulletPaths(section(userPrompt, 'EDITABLE FILES', 3000));

  switch (stage) {
    case 'investigation':
      return {
        phase: 'investigation',
        action: 'Qwen is investigating repository evidence',
        detail: goal,
        reasoningSummary: 'Inspecting repository structure and evidence to decide what needs deeper investigation.',
        completedSteps: ['workspace']
      };
    case 'planning':
      return {
        phase: 'planning',
        action: 'Qwen is building the implementation plan',
        detail: goal,
        reasoningSummary: 'Reasoning over verified repository evidence and converting it into bounded implementation tasks.',
        completedSteps: ['workspace', 'investigation']
      };
    case 'implementation':
      return {
        phase: 'implementation',
        action: 'Qwen is generating a bounded code change',
        detail: section(userPrompt, 'TASK') ?? goal,
        files: editableFiles,
        reasoningSummary: 'Executing the planner-approved task against the exact editable files and supplied repository context.',
        completedSteps: ['workspace', 'investigation', 'planning']
      };
    case 'review':
      return {
        phase: 'review',
        action: 'Qwen is adversarially reviewing the change',
        detail: goal,
        reasoningSummary: 'Trying to falsify correctness against the goal, plan, diff and deterministic validation evidence.',
        completedSteps: ['workspace', 'investigation', 'planning', 'implementation', 'validation']
      };
    case 'repo-learning':
      return {
        phase: 'repo-learning',
        action: 'Qwen is extracting durable repository intelligence',
        detail: goal,
        reasoningSummary: 'Extracting reusable source-backed conventions and architecture facts from the successful run.',
        completedSteps: ['workspace', 'investigation', 'planning', 'implementation', 'validation', 'review']
      };
    default:
      return {
        action: 'Qwen is running a model inference',
        detail: goal,
        reasoningSummary: 'A local model call is in progress.'
      };
  }
}

export function progressFromInferenceResult(stage: InferenceStage, content: string): Partial<EngineeringProgress> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { reasoningSummary: 'The model call completed; its result is being processed by the host.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { reasoningSummary: 'The model call completed; its result is being processed by the host.' };
  }

  const value = parsed as Record<string, unknown>;
  const summary = typeof value.summary === 'string' ? value.summary.slice(0, 1800) : undefined;
  const files = Array.isArray(value.files)
    ? value.files
        .flatMap((item) => item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string' ? [(item as { path: string }).path] : [])
        .slice(0, 12)
    : undefined;
  const tasks = Array.isArray(value.tasks)
    ? value.tasks
        .flatMap((item) => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? [(item as { id: string }).id] : [])
        .slice(0, 12)
    : [];
  const issues = Array.isArray(value.issues) ? value.issues.length : undefined;

  switch (stage) {
    case 'investigation':
      return {
        phase: 'investigation',
        action: 'Investigation model call completed',
        reasoningSummary: summary,
        completedSteps: ['workspace', 'investigation']
      };
    case 'planning':
      return {
        phase: 'planning',
        action: 'Plan produced',
        detail: tasks.length ? `${tasks.length} tasks: ${tasks.join(', ')}` : undefined,
        reasoningSummary: summary,
        completedSteps: ['workspace', 'investigation', 'planning']
      };
    case 'implementation':
      return {
        phase: 'implementation',
        action: 'Code proposal produced; host is applying and validating it',
        detail: summary,
        reasoningSummary: summary,
        files,
        completedSteps: ['workspace', 'investigation', 'planning']
      };
    case 'review':
      return {
        phase: 'review',
        action: 'Adversarial review completed',
        detail: issues === undefined ? undefined : `${issues} review issue${issues === 1 ? '' : 's'} reported.`,
        reasoningSummary: summary,
        completedSteps: ['workspace', 'investigation', 'planning', 'implementation', 'validation', 'review']
      };
    case 'repo-learning':
      return {
        phase: 'repo-learning',
        action: 'Repository learning completed',
        reasoningSummary: summary ?? 'Durable repository intelligence was extracted from the successful run.',
        completedSteps: ['workspace', 'investigation', 'planning', 'implementation', 'validation', 'review', 'repo-learning']
      };
    default:
      return { reasoningSummary: summary ?? 'The model call completed successfully.' };
  }
}

export class WorkerInferenceTracker {
  private current?: ActiveInference;
  private readonly recent: CompletedInferenceSnapshot[] = [];

  begin(stage: InferenceStage, model: string): string {
    const id = randomUUID();
    this.current = { id, stage, model, startedAtMs: Date.now() };
    return id;
  }

  complete(
    id: string,
    status: 'success' | 'error',
    metadata: {
      promptTokens?: number;
      completionTokens?: number;
      error?: string;
    } = {}
  ): void {
    if (!this.current || this.current.id !== id) return;
    const current = this.current;
    const finishedAtMs = Date.now();
    this.current = undefined;
    this.recent.unshift({
      id: current.id,
      stage: current.stage,
      model: current.model,
      startedAt: new Date(current.startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - current.startedAtMs),
      status,
      promptTokens: metadata.promptTokens,
      completionTokens: metadata.completionTokens,
      error: metadata.error
    });
    this.recent.splice(24);
  }

  snapshot(): { current: InferenceSnapshot | null; recent: CompletedInferenceSnapshot[] } {
    const current = this.current
      ? {
          id: this.current.id,
          stage: this.current.stage,
          model: this.current.model,
          startedAt: new Date(this.current.startedAtMs).toISOString(),
          runningMs: Math.max(0, Date.now() - this.current.startedAtMs)
        }
      : null;
    return { current, recent: [...this.recent] };
  }
}
