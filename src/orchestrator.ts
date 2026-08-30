import { createTwoFilesPatch } from 'diff';

import { classifyTask, type TaskClassification, type TaskClassificationInput } from './classifier.js';
import type { LocalCoderConfig } from './config.js';
import {
  executeAgenticCodeTask,
  type AgenticExecutionResult
} from './executor.js';
import type { OllamaClient } from './ollama.js';
import {
  readWorkspaceFile,
  resolveWorkspace,
  resolveWorkspacePath,
  restoreWorkspaceFile,
  type WorkspaceFileSnapshot
} from './workspace.js';
import {
  runValidations,
  type ValidationCommand,
  type ValidationResult
} from './validation.js';

export interface LocalPlanTaskRoutingHints {
  solutionKnown?: boolean;
  requiresDiscovery?: boolean;
  requiresArchitecture?: boolean;
  validationKnown?: boolean;
  riskTags?: string[];
  sensitiveDecisionResolved?: boolean;
}

export interface LocalPlanTask {
  id: string;
  task: string;
  dependsOn?: string[];
  editableFiles: string[];
  contextFiles?: string[];
  context?: string;
  constraints?: string[];
  language?: string;
  validation?: ValidationCommand[];
  maxAttempts?: number;
  routing?: LocalPlanTaskRoutingHints;
}

export interface LocalExecutionPlan {
  workspace: string;
  goal: string;
  context?: string;
  language?: string;
  sharedContextFiles?: string[];
  sharedConstraints?: string[];
  tasks: LocalPlanTask[];
  finalValidation?: ValidationCommand[];
  rollbackPlanOnFailure?: boolean;
}

export interface LocalPlanPreflightTask {
  id: string;
  classification: TaskClassification;
}

export interface LocalPlanTaskResult {
  id: string;
  classification: TaskClassification;
  execution: AgenticExecutionResult;
}

export interface LocalPlanTotals {
  tasks: number;
  completedTasks: number;
  successfulTasks: number;
  escalatedTasks: number;
  totalAttempts: number;
  promptTokens: number;
  completionTokens: number;
  generationDurationMs: number;
  validationDurationMs: number;
}

export interface LocalExecutionPlanResult {
  status: 'success' | 'escalated';
  phase: 'preflight' | 'execution' | 'final-validation' | 'complete';
  workspace: string;
  goal: string;
  taskOrder: string[];
  preflight: LocalPlanPreflightTask[];
  blockers: string[];
  taskResults: LocalPlanTaskResult[];
  finalValidation: ValidationResult[];
  failedTaskId?: string;
  changedFiles: string[];
  diff: string;
  rolledBack: boolean;
  totals: LocalPlanTotals;
}

type LocalChatClient = Pick<OllamaClient, 'chat'>;
type SnapshotMap = Map<string, WorkspaceFileSnapshot>;

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function combineText(...parts: Array<string | undefined>): string | undefined {
  const present = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return present.length > 0 ? present.join('\n\n') : undefined;
}

function topologicalTaskOrder(tasks: LocalPlanTask[]): LocalPlanTask[] {
  const byId = new Map<string, LocalPlanTask>();

  for (const task of tasks) {
    if (byId.has(task.id)) throw new Error(`Duplicate local plan task id: ${task.id}`);
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw new Error(`Task "${task.id}" depends on unknown task "${dependency}".`);
      }
      if (dependency === task.id) throw new Error(`Task "${task.id}" cannot depend on itself.`);
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const ordered: LocalPlanTask[] = [];

  const visit = (task: LocalPlanTask, stack: string[]) => {
    const current = state.get(task.id) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      throw new Error(`Local plan contains a dependency cycle: ${[...stack, task.id].join(' -> ')}`);
    }

    state.set(task.id, 1);
    for (const dependencyId of task.dependsOn ?? []) {
      visit(byId.get(dependencyId)!, [...stack, task.id]);
    }
    state.set(task.id, 2);
    ordered.push(task);
  };

  for (const task of tasks) visit(task, []);
  return ordered;
}

async function snapshotFiles(
  workspace: string,
  files: string[],
  config: LocalCoderConfig
): Promise<SnapshotMap> {
  const snapshots: SnapshotMap = new Map();
  for (const file of files) {
    snapshots.set(file, await readWorkspaceFile(workspace, file, config.maxFileBytes));
  }
  return snapshots;
}

async function restoreSnapshots(workspace: string, snapshots: SnapshotMap): Promise<void> {
  for (const snapshot of snapshots.values()) {
    await restoreWorkspaceFile(workspace, snapshot);
  }
}

function diffSnapshots(before: SnapshotMap, after: SnapshotMap): { changedFiles: string[]; diff: string } {
  const changedFiles: string[] = [];
  const patches: string[] = [];

  for (const [file, original] of before) {
    const current = after.get(file);
    if (!current || original.content === current.content) continue;

    changedFiles.push(file);
    patches.push(
      createTwoFilesPatch(
        `${file} (before plan)`,
        `${file} (after plan)`,
        original.content ?? '',
        current.content ?? '',
        '',
        '',
        { context: 3 }
      )
    );
  }

  return { changedFiles, diff: patches.join('\n') };
}

function durationNsToMs(value: number | undefined): number {
  return value ? value / 1_000_000 : 0;
}

function totals(
  taskCount: number,
  taskResults: LocalPlanTaskResult[],
  finalValidation: ValidationResult[]
): LocalPlanTotals {
  const executions = taskResults.map((result) => result.execution);
  const generations = executions.flatMap((execution) => execution.generations);

  return {
    tasks: taskCount,
    completedTasks: taskResults.length,
    successfulTasks: executions.filter((execution) => execution.status === 'success').length,
    escalatedTasks: executions.filter((execution) => execution.status === 'escalated').length,
    totalAttempts: executions.reduce((sum, execution) => sum + execution.attempts, 0),
    promptTokens: generations.reduce((sum, generation) => sum + (generation.promptTokens ?? 0), 0),
    completionTokens: generations.reduce(
      (sum, generation) => sum + (generation.completionTokens ?? 0),
      0
    ),
    generationDurationMs: generations.reduce(
      (sum, generation) => sum + durationNsToMs(generation.totalDurationNs),
      0
    ),
    validationDurationMs:
      executions
        .flatMap((execution) => execution.validation)
        .reduce((sum, validation) => sum + validation.durationMs, 0) +
      finalValidation.reduce((sum, validation) => sum + validation.durationMs, 0)
  };
}

function classificationInput(
  task: LocalPlanTask,
  plan: LocalExecutionPlan
): TaskClassificationInput {
  const hasValidation = (task.validation?.length ?? 0) > 0 || (plan.finalValidation?.length ?? 0) > 0;

  return {
    task: task.task,
    solutionKnown: task.routing?.solutionKnown ?? true,
    requiresDiscovery: task.routing?.requiresDiscovery ?? false,
    requiresArchitecture: task.routing?.requiresArchitecture ?? false,
    estimatedFiles: task.editableFiles.length,
    validationKnown: task.routing?.validationKnown ?? hasValidation,
    riskTags: task.routing?.riskTags,
    sensitiveDecisionResolved: task.routing?.sensitiveDecisionResolved
  };
}

async function preflightPlan(
  plan: LocalExecutionPlan,
  config: LocalCoderConfig
): Promise<{
  workspace: string;
  orderedTasks: LocalPlanTask[];
  editableFiles: string[];
  preflight: LocalPlanPreflightTask[];
  blockers: string[];
}> {
  if (plan.tasks.length === 0) throw new Error('Local execution plan must contain at least one task.');

  const workspace = await resolveWorkspace(plan.workspace);
  const orderedTasks = topologicalTaskOrder(plan.tasks);
  const editableFiles = dedupe(orderedTasks.flatMap((task) => task.editableFiles));

  if (editableFiles.length > 120) {
    throw new Error(`Local execution plan touches ${editableFiles.length} editable files; maximum is 120.`);
  }

  const allReferencedFiles = dedupe([
    ...editableFiles,
    ...(plan.sharedContextFiles ?? []),
    ...orderedTasks.flatMap((task) => task.contextFiles ?? [])
  ]);

  for (const file of allReferencedFiles) resolveWorkspacePath(workspace, file);

  const preflight = orderedTasks.map((task) => ({
    id: task.id,
    classification: classifyTask(classificationInput(task, plan))
  }));

  const blockers: string[] = [];
  for (const task of preflight) {
    if (task.classification.route === 'local' || task.classification.route === 'local-supervised') {
      continue;
    }

    if (task.classification.route === 'deterministic') {
      blockers.push(
        `Task "${task.id}" is deterministic-tool work. Move it to task/final validation instead of using a local LLM subtask.`
      );
      continue;
    }

    blockers.push(`Task "${task.id}" must stay in Claude: ${task.classification.reasons.join(' ')}`);
  }

  // Resolve/read every editable path before the first mutation so symlink escapes and
  // file-size violations fail during preflight rather than halfway through the plan.
  await snapshotFiles(workspace, editableFiles, config);

  return { workspace, orderedTasks, editableFiles, preflight, blockers };
}

export async function executeLocalCodePlan(
  ollama: LocalChatClient,
  config: LocalCoderConfig,
  plan: LocalExecutionPlan
): Promise<LocalExecutionPlanResult> {
  const preflightResult = await preflightPlan(plan, config);
  const { workspace, orderedTasks, editableFiles, preflight, blockers } = preflightResult;
  const taskOrder = orderedTasks.map((task) => task.id);
  const taskResults: LocalPlanTaskResult[] = [];
  let finalValidation: ValidationResult[] = [];

  if (blockers.length > 0) {
    return {
      status: 'escalated',
      phase: 'preflight',
      workspace,
      goal: plan.goal,
      taskOrder,
      preflight,
      blockers,
      taskResults,
      finalValidation,
      changedFiles: [],
      diff: '',
      rolledBack: false,
      totals: totals(plan.tasks.length, taskResults, finalValidation)
    };
  }

  const original = await snapshotFiles(workspace, editableFiles, config);
  const rollbackPlanOnFailure = plan.rollbackPlanOnFailure ?? true;

  const finishEscalated = async (
    phase: 'execution' | 'final-validation',
    failedTaskId?: string
  ): Promise<LocalExecutionPlanResult> => {
    const current = await snapshotFiles(workspace, editableFiles, config);
    const delta = diffSnapshots(original, current);

    if (rollbackPlanOnFailure) await restoreSnapshots(workspace, original);

    return {
      status: 'escalated',
      phase,
      workspace,
      goal: plan.goal,
      taskOrder,
      preflight,
      blockers: [],
      taskResults,
      finalValidation,
      failedTaskId,
      changedFiles: delta.changedFiles,
      diff: delta.diff,
      rolledBack: rollbackPlanOnFailure,
      totals: totals(plan.tasks.length, taskResults, finalValidation)
    };
  };

  try {
    for (const task of orderedTasks) {
      const classification = preflight.find((entry) => entry.id === task.id)!.classification;
      const execution = await executeAgenticCodeTask(ollama, config, {
        workspace,
        task: task.task,
        editableFiles: dedupe(task.editableFiles),
        contextFiles: dedupe([...(plan.sharedContextFiles ?? []), ...(task.contextFiles ?? [])]),
        context: combineText(`Overall feature goal: ${plan.goal}`, plan.context, task.context),
        constraints: dedupe([
          ...(plan.sharedConstraints ?? []),
          ...(task.constraints ?? []),
          ...(classification.route === 'local-supervised'
            ? [
                'The sensitive behavior and security/product decisions were already resolved by Claude. Implement only the explicit bounded behavior; do not redesign auth, credential, permission, secret, or security contracts.'
              ]
            : [])
        ]),
        language: task.language ?? plan.language,
        validation: task.validation,
        maxAttempts: task.maxAttempts,
        rollbackOnFailure: true
      });

      taskResults.push({ id: task.id, classification, execution });

      if (execution.status !== 'success') return await finishEscalated('execution', task.id);
    }

    finalValidation = await runValidations(
      workspace,
      plan.finalValidation ?? [],
      config.allowedValidationCommands,
      config.validationTimeoutMs
    );

    if (finalValidation.some((validation) => !validation.ok)) {
      return await finishEscalated('final-validation');
    }

    const current = await snapshotFiles(workspace, editableFiles, config);
    const delta = diffSnapshots(original, current);

    return {
      status: 'success',
      phase: 'complete',
      workspace,
      goal: plan.goal,
      taskOrder,
      preflight,
      blockers: [],
      taskResults,
      finalValidation,
      changedFiles: delta.changedFiles,
      diff: delta.diff,
      rolledBack: false,
      totals: totals(plan.tasks.length, taskResults, finalValidation)
    };
  } catch (error) {
    if (rollbackPlanOnFailure) await restoreSnapshots(workspace, original);
    throw error;
  }
}
