import { createTwoFilesPatch } from 'diff';
import * as z from 'zod/v4';

import type { LocalCoderConfig } from './config.js';
import {
  codingThinkingForModel,
  type OllamaClient,
  type OllamaGeneration
} from './ollama.js';
import {
  readWorkspaceFile,
  resolveWorkspace,
  restoreWorkspaceFile,
  writeWorkspaceFile,
  type WorkspaceFileSnapshot
} from './workspace.js';
import {
  runValidations,
  type ValidationCommand,
  type ValidationResult
} from './validation.js';

export interface AgenticCodeTask {
  workspace: string;
  task: string;
  editableFiles: string[];
  contextFiles?: string[];
  context?: string;
  constraints?: string[];
  language?: string;
  validation?: ValidationCommand[];
  maxAttempts?: number;
  rollbackOnFailure?: boolean;
}

interface EditProposal {
  summary: string;
  files: Array<{ path: string; content: string }>;
}

export interface AgenticExecutionResult {
  status: 'success' | 'escalated';
  workspace: string;
  attempts: number;
  changedFiles: string[];
  diff: string;
  validation: ValidationResult[];
  rolledBack: boolean;
  summary: string;
  modelEscalated: boolean;
  generations: Array<{
    model: string;
    tier?: 'fast' | 'strong';
    doneReason?: string;
    totalDurationNs?: number;
    promptTokens?: number;
    completionTokens?: number;
  }>;
}

type LocalChatClient = Pick<OllamaClient, 'chat'>;

const proposalSchema = z.object({
  summary: z.string(),
  files: z.array(
    z.object({
      path: z.string().min(1),
      content: z.string()
    })
  )
});

const EXECUTOR_SYSTEM_PROMPT = `You are a local coding executor working under a stronger planner/reviewer.

You receive a bounded task and exact repository file contents. Implement the task directly.

Rules:
- Modify only paths listed under EDITABLE FILES.
- Return complete file contents, not patches or markdown fences.
- Omit files that do not need changes.
- Preserve unrelated behavior and formatting as much as possible.
- Follow supplied constraints and existing patterns exactly.
- Never invent test results. Validation is run by the host after you respond.
- If previous validation failed, fix the failure without broadening scope.
- Return only the JSON object required by the supplied schema.`;

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function generationMetadata(generation: OllamaGeneration, tier: 'fast' | 'strong') {
  return {
    model: generation.model,
    tier,
    doneReason: generation.doneReason,
    totalDurationNs: generation.totalDurationNs,
    promptTokens: generation.promptTokens,
    completionTokens: generation.completionTokens
  };
}

function modelForAttempt(config: LocalCoderConfig, attempt: number): {
  model: string;
  tier: 'fast' | 'strong';
  keepAlive: string;
  numCtx: number;
} {
  const fastModel = config.model;
  const strongModel = config.strongModel ?? fastModel;
  const adaptive = config.adaptiveModelsEnabled ?? false;
  const useStrong = adaptive && attempt > 1 && strongModel !== fastModel;

  return {
    model: useStrong ? strongModel : fastModel,
    tier: useStrong ? 'strong' : 'fast',
    keepAlive: useStrong
      ? config.strongModelKeepAlive ?? '30s'
      : config.fastModelKeepAlive ?? '90s',
    numCtx: config.ollamaNumCtx ?? 16_384
  };
}

function responseFormat(editableFiles: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'files'],
    properties: {
      summary: { type: 'string' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'content'],
          properties: {
            path: { type: 'string', enum: editableFiles },
            content: { type: 'string' }
          }
        }
      }
    }
  };
}

async function loadPromptFiles(
  workspace: string,
  files: string[],
  config: LocalCoderConfig
): Promise<WorkspaceFileSnapshot[]> {
  const snapshots: WorkspaceFileSnapshot[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const snapshot = await readWorkspaceFile(workspace, file, config.maxFileBytes);
    const bytes = snapshot.content === null ? 0 : Buffer.byteLength(snapshot.content, 'utf8');
    totalBytes += bytes;

    if (totalBytes > config.maxContextBytes) {
      throw new Error(
        `Local coder context exceeds ${config.maxContextBytes} bytes. Reduce contextFiles/editableFiles.`
      );
    }

    snapshots.push(snapshot);
  }

  return snapshots;
}

function buildExecutorPrompt(
  input: AgenticCodeTask,
  files: WorkspaceFileSnapshot[],
  validationFeedback?: ValidationResult[]
): string {
  const sections: string[] = [
    `# TASK\n${input.task.trim()}`,
    `# EDITABLE FILES\n${input.editableFiles.map((file) => `- ${file}`).join('\n')}`
  ];

  if (input.language) sections.push(`# LANGUAGE / STACK\n${input.language.trim()}`);
  if (input.context) sections.push(`# PLANNER CONTEXT\n${input.context.trim()}`);
  if (input.constraints?.length) {
    sections.push(
      `# CONSTRAINTS\n${input.constraints.map((constraint) => `- ${constraint.trim()}`).join('\n')}`
    );
  }

  sections.push(
    `# REPOSITORY FILES\n${files
      .map(
        (file) =>
          `\n--- FILE: ${file.path} ---\n${file.content ?? '[FILE DOES NOT EXIST YET]'}\n--- END FILE ---`
      )
      .join('\n')}`
  );

  if (validationFeedback?.length) {
    sections.push(
      `# PREVIOUS VALIDATION FAILURE\n${validationFeedback
        .map(
          (result) =>
            `$ ${result.command} ${result.args.join(' ')}\nexit=${String(result.exitCode)}\n${result.output}`
        )
        .join('\n\n')}`
    );
  }

  sections.push('# OUTPUT\nReturn JSON only. Include complete content only for files you changed.');

  return sections.join('\n\n');
}

function parseProposal(raw: string, allowedFiles: Set<string>, maxFileBytes: number): EditProposal {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error('Local model returned invalid JSON for the edit proposal.');
  }

  const proposal = proposalSchema.parse(parsedJson);
  const seen = new Set<string>();

  for (const file of proposal.files) {
    if (!allowedFiles.has(file.path)) {
      throw new Error(`Local model attempted to edit a non-allowed file: ${file.path}`);
    }
    if (seen.has(file.path)) {
      throw new Error(`Local model returned duplicate file edits: ${file.path}`);
    }
    if (Buffer.byteLength(file.content, 'utf8') > maxFileBytes) {
      throw new Error(`Generated file exceeds ${maxFileBytes} bytes: ${file.path}`);
    }
    seen.add(file.path);
  }

  return proposal;
}

async function snapshotFiles(
  workspace: string,
  paths: string[],
  config: LocalCoderConfig
): Promise<Map<string, WorkspaceFileSnapshot>> {
  const map = new Map<string, WorkspaceFileSnapshot>();
  for (const file of paths) {
    map.set(file, await readWorkspaceFile(workspace, file, config.maxFileBytes));
  }
  return map;
}

async function restoreSnapshots(
  workspace: string,
  snapshots: Map<string, WorkspaceFileSnapshot>
): Promise<void> {
  for (const snapshot of snapshots.values()) {
    await restoreWorkspaceFile(workspace, snapshot);
  }
}

function buildDiff(
  before: Map<string, WorkspaceFileSnapshot>,
  after: Map<string, WorkspaceFileSnapshot>
): { changedFiles: string[]; diff: string } {
  const changedFiles: string[] = [];
  const patches: string[] = [];

  for (const [file, original] of before) {
    const current = after.get(file);
    if (!current || original.content === current.content) continue;

    changedFiles.push(file);
    patches.push(
      createTwoFilesPatch(
        `${file} (before)`,
        `${file} (after)`,
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

function retryFeedback(error: unknown): ValidationResult[] {
  return [
    {
      command: 'local-coder',
      args: [],
      ok: false,
      exitCode: null,
      output: error instanceof Error ? error.message : String(error),
      durationMs: 0
    }
  ];
}

export async function executeAgenticCodeTask(
  ollama: LocalChatClient,
  config: LocalCoderConfig,
  input: AgenticCodeTask
): Promise<AgenticExecutionResult> {
  const workspace = await resolveWorkspace(input.workspace);
  const editableFiles = dedupe(input.editableFiles);
  const contextFiles = dedupe([...(input.contextFiles ?? []), ...editableFiles]);
  const allowedFiles = new Set(editableFiles);
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? 2, 3));
  const rollbackOnFailure = input.rollbackOnFailure ?? true;
  const original = await snapshotFiles(workspace, editableFiles, config);
  const generations: AgenticExecutionResult['generations'] = [];
  let validationFeedback: ValidationResult[] | undefined;
  let lastValidation: ValidationResult[] = [];
  let lastSummary = '';
  let attempts = 0;

  try {
    for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
      const promptFiles = await loadPromptFiles(workspace, contextFiles, config);
      const prompt = buildExecutorPrompt(input, promptFiles, validationFeedback);
      const selected = modelForAttempt(config, attempts);
      const generation = await ollama.chat(
        EXECUTOR_SYSTEM_PROMPT,
        prompt,
        responseFormat(editableFiles),
        {
          model: selected.model,
          numCtx: selected.numCtx,
          keepAlive: selected.keepAlive,
          think: codingThinkingForModel(selected.model)
        }
      );
      generations.push(generationMetadata(generation, selected.tier));

      let proposal: EditProposal;
      try {
        proposal = parseProposal(generation.content, allowedFiles, config.maxFileBytes);
      } catch (error) {
        lastValidation = retryFeedback(error);
        validationFeedback = lastValidation;
        lastSummary = 'Local model returned an unusable edit proposal.';
        continue;
      }

      lastSummary = proposal.summary;

      for (const file of proposal.files) {
        await writeWorkspaceFile(workspace, file.path, file.content);
      }

      const current = await snapshotFiles(workspace, editableFiles, config);
      const delta = buildDiff(original, current);

      if (delta.changedFiles.length === 0) {
        validationFeedback = retryFeedback('No file changes were produced. Implement the requested task.');
        lastValidation = validationFeedback;
        continue;
      }

      lastValidation = await runValidations(
        workspace,
        input.validation ?? [],
        config.allowedValidationCommands,
        config.validationTimeoutMs
      );

      if (lastValidation.every((result) => result.ok)) {
        return {
          status: 'success',
          workspace,
          attempts,
          changedFiles: delta.changedFiles,
          diff: delta.diff,
          validation: lastValidation,
          rolledBack: false,
          summary: lastSummary,
          modelEscalated: generations.some((item) => item.tier === 'strong'),
          generations
        };
      }

      validationFeedback = lastValidation;
    }

    const current = await snapshotFiles(workspace, editableFiles, config);
    const delta = buildDiff(original, current);

    if (rollbackOnFailure) {
      await restoreSnapshots(workspace, original);
    }

    return {
      status: 'escalated',
      workspace,
      attempts: maxAttempts,
      changedFiles: delta.changedFiles,
      diff: delta.diff,
      validation: lastValidation,
      rolledBack: rollbackOnFailure,
      summary: lastSummary || 'Local executor could not complete the task.',
      modelEscalated: generations.some((item) => item.tier === 'strong'),
      generations
    };
  } catch (error) {
    if (rollbackOnFailure) {
      await restoreSnapshots(workspace, original);
    }
    throw error;
  }
}
