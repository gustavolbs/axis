import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import * as z from 'zod/v4';

import {
  prepareContextCapsule,
  RepoIndexStore,
  type ContextCapsule
} from './context-capsule.js';
import type { LocalCoderConfig } from './config.js';
import { discoverWorkspace, searchWorkspace } from './discovery.js';
import { executeAgenticCodeTask } from './executor.js';
import type { OllamaClient, OllamaGeneration } from './ollama.js';
import {
  executeLocalCodePlan,
  type LocalExecutionPlan,
  type LocalExecutionPlanResult
} from './orchestrator.js';
import type { ValidationCommand, ValidationResult } from './validation.js';
import {
  readWorkspaceFile,
  resolveWorkspace,
  resolveWorkspacePath,
  restoreWorkspaceFile,
  type WorkspaceFileSnapshot
} from './workspace.js';

export interface LocalEngineerInput {
  workspace: string;
  goal: string;
  context?: string;
  constraints?: string[];
  language?: string;
  /**
   * Guidance supplied by Claude after the local engineer explicitly asked for
   * premium reasoning, external research, or a sensitive decision.
   */
  claudeGuidance?: string;
  maxRepairRounds?: number;
}

export interface LocalEngineerPlanTask {
  id: string;
  task: string;
  dependsOn: string[];
  editableFiles: string[];
  contextFiles: string[];
  constraints: string[];
}

export interface LocalEngineerPlan {
  summary: string;
  analysis: string;
  confidence: number;
  decisions: string[];
  riskTags: string[];
  sensitiveDecisionRequired: boolean;
  validationScripts: string[];
  tasks: LocalEngineerPlanTask[];
}

export interface LocalEngineerEscalation {
  kind: 'decision' | 'external-research' | 'sensitive-decision' | 'execution-failure' | 'review-failure';
  reason: string;
  questions: string[];
  researchRequests: string[];
  evidence: string[];
  resumeWith:
    'Call local_engineer again with the same workspace/goal plus claudeGuidance containing the resolved decision or research evidence.';
}

export interface LocalEngineerReviewIssue {
  severity: 'low' | 'medium' | 'high';
  file?: string;
  description: string;
  fix: string;
}

export interface LocalEngineerReview {
  verdict: 'pass' | 'repair' | 'needs-claude';
  confidence: number;
  summary: string;
  issues: LocalEngineerReviewIssue[];
  researchRequests: string[];
}

export interface LocalEngineerFileChange {
  path: string;
  beforeSha256: string | null;
  contentBase64: string | null;
}

export interface LocalEngineerResult {
  status: 'success' | 'needs-claude' | 'escalated';
  phase: 'investigation' | 'planning' | 'execution' | 'review' | 'complete';
  workspace: string;
  goal: string;
  summary: string;
  investigation: {
    searchQueries: string[];
    evidenceFiles: string[];
    researchRequests: string[];
  };
  plan?: LocalEngineerPlan;
  execution?: LocalExecutionPlanResult;
  review?: LocalEngineerReview;
  repairRounds: number;
  changedFiles: string[];
  diff: string;
  validation: ValidationResult[];
  escalation?: LocalEngineerEscalation;
  modelCalls: Array<{
    stage: 'investigation' | 'planning' | 'review';
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    totalDurationNs?: number;
  }>;
}

export interface LocalEngineerExecution {
  result: LocalEngineerResult;
  changes: LocalEngineerFileChange[];
}

type EngineerChatClient = Pick<OllamaClient, 'chat'>;

type SnapshotMap = Map<string, WorkspaceFileSnapshot>;

const investigationSchema = z.object({
  summary: z.string().min(1),
  searchQueries: z.array(z.string().min(1).max(200)).max(8).default([]),
  fileHints: z.array(z.string().min(1).max(500)).max(16).default([]),
  researchRequests: z.array(z.string().min(1).max(500)).max(6).default([])
});

const planTaskSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  task: z.string().min(1).max(4000),
  dependsOn: z.array(z.string().min(1).max(80)).max(20).default([]),
  editableFiles: z.array(z.string().min(1).max(500)).min(1).max(8),
  contextFiles: z.array(z.string().min(1).max(500)).max(16).default([]),
  constraints: z.array(z.string().min(1).max(1000)).max(20).default([])
});

const planningSchema = z.object({
  outcome: z.enum(['ready', 'needs-claude']),
  summary: z.string().min(1),
  analysis: z.string().min(1),
  confidence: z.number().min(0).max(1),
  decisions: z.array(z.string().min(1).max(1000)).max(20).default([]),
  unresolvedQuestions: z.array(z.string().min(1).max(1000)).max(10).default([]),
  researchRequests: z.array(z.string().min(1).max(1000)).max(8).default([]),
  riskTags: z.array(z.string().min(1).max(80)).max(20).default([]),
  sensitiveDecisionRequired: z.boolean().default(false),
  validationScripts: z.array(z.string().min(1).max(100)).max(6).default([]),
  tasks: z.array(planTaskSchema).max(12).default([])
});

const reviewSchema = z.object({
  verdict: z.enum(['pass', 'repair', 'needs-claude']),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  issues: z
    .array(
      z.object({
        severity: z.enum(['low', 'medium', 'high']),
        file: z.string().min(1).max(500).optional(),
        description: z.string().min(1).max(2000),
        fix: z.string().min(1).max(2000)
      })
    )
    .max(20)
    .default([]),
  repairTask: z.string().max(5000).optional(),
  repairFiles: z.array(z.string().min(1).max(500)).max(12).default([]),
  researchRequests: z.array(z.string().min(1).max(1000)).max(8).default([])
});

const investigationFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'searchQueries', 'fileHints', 'researchRequests'],
  properties: {
    summary: { type: 'string' },
    searchQueries: { type: 'array', maxItems: 8, items: { type: 'string' } },
    fileHints: { type: 'array', maxItems: 16, items: { type: 'string' } },
    researchRequests: { type: 'array', maxItems: 6, items: { type: 'string' } }
  }
} satisfies Record<string, unknown>;

const planningFormat = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'summary',
    'analysis',
    'confidence',
    'decisions',
    'unresolvedQuestions',
    'researchRequests',
    'riskTags',
    'sensitiveDecisionRequired',
    'validationScripts',
    'tasks'
  ],
  properties: {
    outcome: { type: 'string', enum: ['ready', 'needs-claude'] },
    summary: { type: 'string' },
    analysis: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    decisions: { type: 'array', maxItems: 20, items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', maxItems: 10, items: { type: 'string' } },
    researchRequests: { type: 'array', maxItems: 8, items: { type: 'string' } },
    riskTags: { type: 'array', maxItems: 20, items: { type: 'string' } },
    sensitiveDecisionRequired: { type: 'boolean' },
    validationScripts: { type: 'array', maxItems: 6, items: { type: 'string' } },
    tasks: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'task', 'dependsOn', 'editableFiles', 'contextFiles', 'constraints'],
        properties: {
          id: { type: 'string' },
          task: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          editableFiles: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
          contextFiles: { type: 'array', maxItems: 16, items: { type: 'string' } },
          constraints: { type: 'array', maxItems: 20, items: { type: 'string' } }
        }
      }
    }
  }
} satisfies Record<string, unknown>;

const reviewFormat = {
  type: 'object',
  additionalProperties: false,
  required: [
    'verdict',
    'confidence',
    'summary',
    'issues',
    'repairTask',
    'repairFiles',
    'researchRequests'
  ],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'repair', 'needs-claude'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'description', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          file: { type: 'string' },
          description: { type: 'string' },
          fix: { type: 'string' }
        }
      }
    },
    repairTask: { type: 'string' },
    repairFiles: { type: 'array', maxItems: 12, items: { type: 'string' } },
    researchRequests: { type: 'array', maxItems: 8, items: { type: 'string' } }
  }
} satisfies Record<string, unknown>;

const INVESTIGATOR_SYSTEM_PROMPT = `You are the investigation stage of a local software-engineering agent.
Your job is to reduce an open-ended engineering request into targeted repository evidence requests.
Do not design a solution yet and do not edit code.
Prefer concrete symbol/path/error searches over broad questions.
If repository evidence is insufficient because current external library/provider behavior must be verified, ask for a precise external research request.
Return only the required JSON.`;

const PLANNER_SYSTEM_PROMPT = `You are the reasoning/planning stage of a local software-engineering agent.
Use only the supplied repository evidence plus explicit Claude guidance.
Reason from evidence, not assumptions. For bugs, distinguish observed behavior, plausible causes, evidence, and root cause. For features, identify existing architecture/contracts before proposing changes.
Produce small dependency-ordered implementation tasks. Each task should normally touch 1-5 files and must list exact editable paths.
Do not broaden scope merely to make implementation easier.
Choose validation only from the supplied existing package scripts.
Set outcome=needs-claude when a material decision remains ambiguous, external facts must be researched, a sensitive auth/credential/permission contract is unresolved, or evidence is too weak to implement safely.
If Claude guidance is supplied, treat it as the resolved premium decision/evidence and continue locally when possible.
Return only the required JSON.`;

const REVIEWER_SYSTEM_PROMPT = `You are an adversarial software-engineering reviewer. You did not author the code.
Check the implementation against the original goal, the evidence-backed plan, constraints, changed files, and validation results.
Try to falsify correctness. Look for missing requirements, regressions, unsafe assumptions, broken contracts, incomplete error handling, and tests that fail to cover the changed behavior.
Use repair when a bounded correction can be made within the already-approved editable-file set.
Use needs-claude when correctness depends on unresolved product/security/architecture judgment or external research.
Do not request cosmetic-only repairs unless they hide a correctness problem.
Return only the required JSON.`;

const HARD_PREMIUM_PATTERNS: Array<{ tag: string; regex: RegExp }> = [
  {
    tag: 'cryptography',
    regex: /\b(cryptograph|encryption scheme|decrypt|signature verification|key derivation|certificate validation)\b/i
  },
  {
    tag: 'destructive-production-data',
    regex: /\b(drop\s+(table|database)|truncate\s+table|delete production data|destructive migration)\b/i
  },
  {
    tag: 'production-access-control',
    regex: /\b(production\s+iam|iam\s+policy|root credentials?|production secrets? rotation)\b/i
  }
];

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sha256(content: string | null): string | null {
  if (content === null) return null;
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function generationMeta(
  stage: 'investigation' | 'planning' | 'review',
  generation: OllamaGeneration
) {
  return {
    stage,
    model: generation.model,
    promptTokens: generation.promptTokens,
    completionTokens: generation.completionTokens,
    totalDurationNs: generation.totalDurationNs
  };
}

async function structuredCall<T>(
  model: EngineerChatClient,
  config: LocalCoderConfig,
  systemPrompt: string,
  userPrompt: string,
  format: Record<string, unknown>,
  schema: z.ZodType<T>,
  think: 'medium' | 'high'
): Promise<{ parsed: T; generation: OllamaGeneration }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt =
      attempt === 1
        ? userPrompt
        : `${userPrompt}\n\nPrevious structured response was invalid. Return a schema-valid JSON object only.`;
    // Transport/model failures are not schema failures. Retrying them can double a
    // multi-minute timeout. Retry only after the model returned invalid structured content.
    const generation = await model.chat(systemPrompt, prompt, format, {
      model: config.model,
      numCtx: config.ollamaNumCtx ?? 16_384,
      keepAlive: config.fastModelKeepAlive ?? '90s',
      think
    });
    try {
      return { parsed: schema.parse(JSON.parse(generation.content) as unknown), generation };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function capsuleText(capsule: ContextCapsule): string {
  const files = capsule.relevantFiles
    .map((file) => {
      const evidence = file.evidence
        .map(
          (item) =>
            `${file.path}:${item.startLine}-${item.endLine}\n${item.content}`
        )
        .join('\n\n');
      return `## ${file.path}\nscore=${file.score}; reasons=${file.reasons.join(', ')}\n${evidence}`;
    })
    .join('\n\n');

  return [
    `packageManager=${capsule.packageManager ?? 'unknown'}`,
    `validationCandidates=${capsule.validationCandidates.join(', ') || '[none]'}`,
    `queryTerms=${capsule.queryTerms.join(', ')}`,
    files || '[no ranked evidence]'
  ].join('\n\n');
}

function discoveryText(discovery: Awaited<ReturnType<typeof discoverWorkspace>>): string {
  const files = discovery.files.slice(0, 300);
  return [
    `packageManager=${discovery.packageManager ?? 'unknown'}`,
    `packageScripts=${(discovery.packageScripts ?? []).join(', ') || '[none]'}`,
    `truncated=${String(discovery.truncated)}`,
    '# FILE MAP',
    files.join('\n') || '[empty]'
  ].join('\n');
}

async function collectSearchEvidence(
  workspace: string,
  queries: string[],
  config: LocalCoderConfig
): Promise<{ text: string; matchedFiles: string[] }> {
  const sections: string[] = [];
  const matchedFiles: string[] = [];

  for (const query of queries.slice(0, 8)) {
    try {
      const result = await searchWorkspace(workspace, query, {
        maxResults: 12,
        maxFiles: 800,
        maxDepth: 10,
        maxFileBytes: config.maxFileBytes
      });
      sections.push(
        `## SEARCH ${JSON.stringify(query)}\n${result.matches
          .map((match) => `${match.path}:${match.line} ${match.preview}`)
          .join('\n') || '[no matches]'}`
      );
      matchedFiles.push(...result.matches.map((match) => match.path));
    } catch (error) {
      sections.push(
        `## SEARCH ${JSON.stringify(query)}\n[search failed: ${error instanceof Error ? error.message : String(error)}]`
      );
    }
  }

  return { text: sections.join('\n\n'), matchedFiles: dedupe(matchedFiles) };
}

async function collectFullEvidence(
  workspace: string,
  files: string[],
  config: LocalCoderConfig
): Promise<{ text: string; files: string[] }> {
  const sections: string[] = [];
  const included: string[] = [];
  let used = 0;
  const budget = Math.min(config.maxContextBytes, 28_000);

  for (const file of dedupe(files).slice(0, 8)) {
    try {
      resolveWorkspacePath(workspace, file);
      const snapshot = await readWorkspaceFile(workspace, file, config.maxFileBytes);
      if (snapshot.content === null) continue;
      const remaining = Math.max(0, budget - used);
      if (remaining < 500) break;
      const content = snapshot.content.slice(0, Math.min(6_000, remaining));
      sections.push(`## FILE ${file}\n${content}`);
      included.push(file);
      used += content.length;
    } catch {
      // Planner hints are untrusted model output; invalid/blocked paths are simply ignored.
    }
  }

  return { text: sections.join('\n\n'), files: included };
}

function hardPremiumTags(goal: string): string[] {
  return HARD_PREMIUM_PATTERNS.filter((entry) => entry.regex.test(goal)).map((entry) => entry.tag);
}

function escalation(
  kind: LocalEngineerEscalation['kind'],
  reason: string,
  questions: string[],
  researchRequests: string[],
  evidence: string[]
): LocalEngineerEscalation {
  return {
    kind,
    reason,
    questions,
    researchRequests,
    evidence: evidence.slice(0, 12),
    resumeWith:
      'Call local_engineer again with the same workspace/goal plus claudeGuidance containing the resolved decision or research evidence.'
  };
}

function validationCommands(
  packageManager: string | undefined,
  availableScripts: string[],
  requestedScripts: string[],
  config: LocalCoderConfig
): ValidationCommand[] {
  const command = packageManager?.split('@')[0];
  if (!command || !config.allowedValidationCommands.has(command)) return [];

  const available = new Set(availableScripts);
  let selected = dedupe(requestedScripts).filter((script) => available.has(script)).slice(0, 4);

  if (selected.length === 0) {
    if (available.has('check')) selected = ['check'];
    else {
      selected = ['typecheck', 'test', 'lint', 'build'].filter((script) => available.has(script)).slice(0, 3);
    }
  }

  return selected.map((script) => ({ command, args: ['run', script] }));
}

function validatePlanPaths(workspace: string, plan: LocalEngineerPlanTask[]): void {
  const ids = new Set(plan.map((task) => task.id));
  const allEditable = new Set<string>();

  for (const task of plan) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency) || dependency === task.id) {
        throw new Error(`Invalid local engineer dependency ${dependency} for task ${task.id}.`);
      }
    }
    for (const file of [...task.editableFiles, ...task.contextFiles]) {
      resolveWorkspacePath(workspace, file);
    }
    for (const file of task.editableFiles) allEditable.add(file);
  }

  if (allEditable.size > 30) {
    throw new Error(`Local engineer plan touches ${allEditable.size} editable files; maximum is 30.`);
  }
}

async function snapshotFiles(
  workspace: string,
  files: string[],
  config: LocalCoderConfig
): Promise<SnapshotMap> {
  const snapshots: SnapshotMap = new Map();
  for (const file of dedupe(files)) {
    snapshots.set(file, await readWorkspaceFile(workspace, file, config.maxFileBytes));
  }
  return snapshots;
}

async function currentSnapshots(
  workspace: string,
  originals: SnapshotMap,
  config: LocalCoderConfig
): Promise<SnapshotMap> {
  return await snapshotFiles(workspace, [...originals.keys()], config);
}

async function restoreSnapshots(workspace: string, snapshots: SnapshotMap): Promise<void> {
  for (const snapshot of snapshots.values()) await restoreWorkspaceFile(workspace, snapshot);
}

function aggregateDiff(before: SnapshotMap, after: SnapshotMap): { changedFiles: string[]; diff: string } {
  const changedFiles: string[] = [];
  const patches: string[] = [];

  for (const [file, original] of before) {
    const current = after.get(file);
    if (!current || current.content === original.content) continue;
    changedFiles.push(file);
    patches.push(
      createTwoFilesPatch(
        `${file} (before local engineer)`,
        `${file} (after local engineer)`,
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

function changesFromSnapshots(before: SnapshotMap, after: SnapshotMap): LocalEngineerFileChange[] {
  const changes: LocalEngineerFileChange[] = [];
  for (const [file, original] of before) {
    const current = after.get(file);
    if (!current || current.content === original.content) continue;
    changes.push({
      path: file,
      beforeSha256: sha256(original.content),
      contentBase64:
        current.content === null ? null : Buffer.from(current.content, 'utf8').toString('base64')
    });
  }
  return changes;
}

function reviewPrompt(
  input: LocalEngineerInput,
  plan: LocalEngineerPlan,
  diff: string,
  validation: ValidationResult[],
  chunkIndex: number,
  chunks: number
): string {
  return [
    `# ORIGINAL GOAL\n${input.goal}`,
    input.context ? `# USER/PROJECT CONTEXT\n${input.context}` : '',
    input.claudeGuidance ? `# CLAUDE GUIDANCE\n${input.claudeGuidance}` : '',
    `# PLAN ANALYSIS\n${plan.analysis}`,
    `# PLAN DECISIONS\n${plan.decisions.map((item) => `- ${item}`).join('\n') || '[none]'}`,
    `# DIFF CHUNK\n${chunkIndex + 1}/${chunks}\n${diff}`,
    `# VALIDATION\n${validation
      .map((item) => `$ ${item.command} ${item.args.join(' ')}\nok=${String(item.ok)}\n${item.output.slice(-4000)}`)
      .join('\n\n') || '[no deterministic validation available]'}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

function chunkDiff(diff: string, chunkSize: number): string[] {
  if (!diff) return ['[no diff]'];
  const chunks: string[] = [];
  for (let offset = 0; offset < diff.length; offset += chunkSize) {
    chunks.push(diff.slice(offset, offset + chunkSize));
    if (chunks.length >= 5) break;
  }
  return chunks;
}

async function reviewImplementation(
  model: EngineerChatClient,
  config: LocalCoderConfig,
  input: LocalEngineerInput,
  plan: LocalEngineerPlan,
  diff: string,
  validation: ValidationResult[],
  modelCalls: LocalEngineerResult['modelCalls']
): Promise<{
  review: LocalEngineerReview;
  repairTask?: string;
  repairFiles: string[];
}> {
  const chunkSize = Math.max(12_000, Math.min(32_000, Math.floor(config.maxContextBytes / 3)));
  const chunks = chunkDiff(diff, chunkSize);
  if (diff.length > chunkSize * chunks.length) {
    return {
      review: {
        verdict: 'needs-claude',
        confidence: 0,
        summary: 'The aggregate diff exceeded the bounded local review window.',
        issues: [],
        researchRequests: []
      },
      repairFiles: []
    };
  }

  const reviews: Array<z.infer<typeof reviewSchema>> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const call = await structuredCall(
      model,
      config,
      REVIEWER_SYSTEM_PROMPT,
      reviewPrompt(input, plan, chunks[index], validation, index, chunks.length),
      reviewFormat,
      reviewSchema,
      'high'
    );
    modelCalls.push(generationMeta('review', call.generation));
    reviews.push(call.parsed);
  }

  const allIssues = reviews.flatMap((review) => review.issues);
  const researchRequests = dedupe(reviews.flatMap((review) => review.researchRequests));
  const needsClaude = reviews.some((review) => review.verdict === 'needs-claude');
  const needsRepair = reviews.some((review) => review.verdict === 'repair');
  const confidence = Math.min(...reviews.map((review) => review.confidence));
  const summary = reviews.map((review) => review.summary).join(' | ');

  return {
    review: {
      verdict: needsClaude ? 'needs-claude' : needsRepair ? 'repair' : 'pass',
      confidence,
      summary,
      issues: allIssues,
      researchRequests
    },
    repairTask: reviews.map((review) => review.repairTask).filter(Boolean).join('\n\n') || undefined,
    repairFiles: dedupe(reviews.flatMap((review) => review.repairFiles))
  };
}

function compactEvidence(capsule: ContextCapsule, searchText: string): string[] {
  const cited = capsule.relevantFiles.flatMap((file) =>
    file.evidence.map((evidence) => `${file.path}:${evidence.startLine}-${evidence.endLine}`)
  );
  const searchLines = searchText
    .split(/\r?\n/)
    .filter((line) => /:\d+\s/.test(line))
    .slice(0, 12);
  return dedupe([...cited, ...searchLines]).slice(0, 12);
}

function emptyResult(
  workspace: string,
  input: LocalEngineerInput,
  status: LocalEngineerResult['status'],
  phase: LocalEngineerResult['phase'],
  summary: string,
  escalationValue?: LocalEngineerEscalation
): LocalEngineerExecution {
  return {
    result: {
      status,
      phase,
      workspace,
      goal: input.goal,
      summary,
      investigation: { searchQueries: [], evidenceFiles: [], researchRequests: [] },
      repairRounds: 0,
      changedFiles: [],
      diff: '',
      validation: [],
      escalation: escalationValue,
      modelCalls: []
    },
    changes: []
  };
}

export async function executeLocalEngineer(
  model: EngineerChatClient,
  config: LocalCoderConfig,
  input: LocalEngineerInput
): Promise<LocalEngineerExecution> {
  const workspace = await resolveWorkspace(input.workspace);
  const hardTags = hardPremiumTags(input.goal);

  if (hardTags.length > 0 && !input.claudeGuidance?.trim()) {
    return emptyResult(
      workspace,
      input,
      'needs-claude',
      'investigation',
      'Premium reasoning is required before local implementation for this high-risk request.',
      escalation(
        'decision',
        `High-risk categories require an explicit Claude decision before local execution: ${hardTags.join(', ')}.`,
        ['Resolve the risky behavior/contract and provide the bounded implementation decision.'],
        [],
        hardTags
      )
    );
  }

  const discovery = await discoverWorkspace(workspace, { maxDepth: 6, maxEntries: 1_000 });
  const index = new RepoIndexStore(config.contextIndexPath);
  const initialCapsule = await prepareContextCapsule(index, config, {
    workspace,
    task: input.goal,
    maxFiles: 10,
    maxCharsPerFile: 1_800
  });

  const modelCalls: LocalEngineerResult['modelCalls'] = [];
  const investigationCall = await structuredCall(
    model,
    config,
    INVESTIGATOR_SYSTEM_PROMPT,
    [
      `# GOAL\n${input.goal}`,
      input.context ? `# CONTEXT\n${input.context}` : '',
      input.claudeGuidance ? `# CLAUDE GUIDANCE\n${input.claudeGuidance}` : '',
      `# REPOSITORY MAP\n${discoveryText(discovery)}`,
      `# INITIAL EVIDENCE\n${capsuleText(initialCapsule)}`
    ]
      .filter(Boolean)
      .join('\n\n'),
    investigationFormat,
    investigationSchema,
    'high'
  );
  modelCalls.push(generationMeta('investigation', investigationCall.generation));

  const investigation = investigationCall.parsed;
  const searchEvidence = await collectSearchEvidence(
    workspace,
    investigation.searchQueries,
    config
  );
  const focusedCapsule = await prepareContextCapsule(index, config, {
    workspace,
    task: input.goal,
    hints: investigation.searchQueries,
    maxFiles: 8,
    maxCharsPerFile: 1_200
  });
  const fullEvidence = await collectFullEvidence(
    workspace,
    [
      ...investigation.fileHints,
      ...searchEvidence.matchedFiles,
      ...focusedCapsule.relevantFiles.map((file) => file.path)
    ],
    config
  );

  const planningCall = await structuredCall(
    model,
    config,
    PLANNER_SYSTEM_PROMPT,
    [
      `# GOAL\n${input.goal}`,
      input.context ? `# USER/PROJECT CONTEXT\n${input.context}` : '',
      input.constraints?.length
        ? `# CONSTRAINTS\n${input.constraints.map((item) => `- ${item}`).join('\n')}`
        : '',
      input.language ? `# LANGUAGE / STACK\n${input.language}` : '',
      input.claudeGuidance ? `# CLAUDE GUIDANCE\n${input.claudeGuidance}` : '',
      `# INVESTIGATION INTENT\n${investigation.summary}`,
      `# SEARCH EVIDENCE\n${searchEvidence.text || '[none]'}`,
      `# RANKED FILE EVIDENCE\n${capsuleText(focusedCapsule)}`,
      `# VERIFIED FILE CONTENT\n${fullEvidence.text || '[none]'}`,
      `# ALLOWED VALIDATION SCRIPTS\n${focusedCapsule.validationCandidates.join(', ') || '[none]'}`
    ]
      .filter(Boolean)
      .join('\n\n'),
    planningFormat,
    planningSchema,
    'medium'
  );
  modelCalls.push(generationMeta('planning', planningCall.generation));
  const planned = planningCall.parsed;
  const evidenceRefs = compactEvidence(focusedCapsule, searchEvidence.text);

  if (
    planned.outcome === 'needs-claude' ||
    planned.tasks.length === 0 ||
    planned.confidence < 0.58 ||
    (planned.sensitiveDecisionRequired && !input.claudeGuidance?.trim())
  ) {
    const kind: LocalEngineerEscalation['kind'] = planned.sensitiveDecisionRequired
      ? 'sensitive-decision'
      : planned.researchRequests.length > 0 || investigation.researchRequests.length > 0
        ? 'external-research'
        : 'decision';
    return {
      result: {
        status: 'needs-claude',
        phase: 'planning',
        workspace,
        goal: input.goal,
        summary: planned.summary,
        investigation: {
          searchQueries: investigation.searchQueries,
          evidenceFiles: fullEvidence.files,
          researchRequests: dedupe([
            ...investigation.researchRequests,
            ...planned.researchRequests
          ])
        },
        plan: {
          summary: planned.summary,
          analysis: planned.analysis,
          confidence: planned.confidence,
          decisions: planned.decisions,
          riskTags: planned.riskTags,
          sensitiveDecisionRequired: planned.sensitiveDecisionRequired,
          validationScripts: planned.validationScripts,
          tasks: planned.tasks
        },
        repairRounds: 0,
        changedFiles: [],
        diff: '',
        validation: [],
        escalation: escalation(
          kind,
          planned.summary,
          planned.unresolvedQuestions.length > 0
            ? planned.unresolvedQuestions
            : ['Resolve the remaining ambiguity and provide a concrete bounded decision.'],
          dedupe([...investigation.researchRequests, ...planned.researchRequests]),
          evidenceRefs
        ),
        modelCalls
      },
      changes: []
    };
  }

  const plan: LocalEngineerPlan = {
    summary: planned.summary,
    analysis: planned.analysis,
    confidence: planned.confidence,
    decisions: planned.decisions,
    riskTags: planned.riskTags,
    sensitiveDecisionRequired: planned.sensitiveDecisionRequired,
    validationScripts: planned.validationScripts,
    tasks: planned.tasks
  };

  validatePlanPaths(workspace, plan.tasks);
  const editableFiles = dedupe(plan.tasks.flatMap((task) => task.editableFiles));
  const originals = await snapshotFiles(workspace, editableFiles, config);
  const finalValidation = validationCommands(
    focusedCapsule.packageManager,
    discovery.packageScripts ?? [],
    plan.validationScripts,
    config
  );
  const sensitiveResolved = plan.sensitiveDecisionRequired && Boolean(input.claudeGuidance?.trim());

  const executionPlan: LocalExecutionPlan = {
    workspace,
    goal: input.goal,
    context: [input.context, `Local planner analysis: ${plan.analysis}`, input.claudeGuidance]
      .filter(Boolean)
      .join('\n\n'),
    language: input.language,
    sharedContextFiles: fullEvidence.files.slice(0, 12),
    sharedConstraints: input.constraints,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      task: task.task,
      dependsOn: task.dependsOn,
      editableFiles: task.editableFiles,
      contextFiles: task.contextFiles,
      constraints: task.constraints,
      maxAttempts: 2,
      routing: {
        solutionKnown: true,
        requiresDiscovery: false,
        requiresArchitecture: false,
        validationKnown: finalValidation.length > 0,
        riskTags: plan.riskTags,
        sensitiveDecisionResolved: sensitiveResolved || undefined
      }
    })),
    finalValidation,
    rollbackPlanOnFailure: true
  };

  let execution: LocalExecutionPlanResult;
  try {
    execution = await executeLocalCodePlan(model, config, executionPlan);
  } catch (error) {
    await restoreSnapshots(workspace, originals);
    throw error;
  }

  if (execution.status !== 'success') {
    await restoreSnapshots(workspace, originals);
    return {
      result: {
        status: 'escalated',
        phase: 'execution',
        workspace,
        goal: input.goal,
        summary: `Local implementation did not converge: ${execution.blockers.join(' ') || execution.phase}`,
        investigation: {
          searchQueries: investigation.searchQueries,
          evidenceFiles: fullEvidence.files,
          researchRequests: dedupe([...investigation.researchRequests, ...planned.researchRequests])
        },
        plan,
        execution,
        repairRounds: 0,
        changedFiles: [],
        diff: '',
        validation: execution.finalValidation,
        escalation: escalation(
          'execution-failure',
          `The local executor escalated during ${execution.phase}${execution.failedTaskId ? ` at ${execution.failedTaskId}` : ''}.`,
          ['Use Claude to resolve the failed implementation point; then send the concrete fix back through local_engineer or the bounded local executor.'],
          [],
          evidenceRefs
        ),
        modelCalls
      },
      changes: []
    };
  }

  let repairRounds = 0;
  const maxRepairRounds = Math.max(0, Math.min(input.maxRepairRounds ?? 1, 2));
  let current = await currentSnapshots(workspace, originals, config);
  let delta = aggregateDiff(originals, current);
  let validation = execution.finalValidation;
  let reviewResult = await reviewImplementation(
    model,
    config,
    input,
    plan,
    delta.diff,
    validation,
    modelCalls
  );

  while (reviewResult.review.verdict === 'repair' && repairRounds < maxRepairRounds) {
    const approvedFiles = new Set(editableFiles);
    const repairFiles = reviewResult.repairFiles.filter((file) => approvedFiles.has(file));
    const effectiveFiles = repairFiles.length > 0 ? repairFiles : delta.changedFiles;
    if (effectiveFiles.length === 0) break;

    const repair = await executeAgenticCodeTask(model, config, {
      workspace,
      task:
        reviewResult.repairTask?.trim() ||
        `Repair the adversarial review findings:\n${reviewResult.review.issues
          .map((issue) => `- [${issue.severity}] ${issue.file ?? ''} ${issue.description}: ${issue.fix}`)
          .join('\n')}`,
      editableFiles: effectiveFiles,
      contextFiles: fullEvidence.files.slice(0, 10),
      context: `Original goal: ${input.goal}\nLocal plan: ${plan.analysis}`,
      constraints: input.constraints,
      language: input.language,
      validation: finalValidation,
      maxAttempts: 2,
      rollbackOnFailure: true
    });
    repairRounds += 1;

    if (repair.status !== 'success') {
      await restoreSnapshots(workspace, originals);
      return {
        result: {
          status: 'escalated',
          phase: 'review',
          workspace,
          goal: input.goal,
          summary: 'Local repair loop did not converge.',
          investigation: {
            searchQueries: investigation.searchQueries,
            evidenceFiles: fullEvidence.files,
            researchRequests: dedupe([...investigation.researchRequests, ...planned.researchRequests])
          },
          plan,
          execution,
          review: reviewResult.review,
          repairRounds,
          changedFiles: [],
          diff: '',
          validation: repair.validation,
          escalation: escalation(
            'review-failure',
            'The local reviewer found a bounded issue, but the local repair failed validation.',
            ['Use Claude to resolve the review/repair failure, then optionally resume local execution with claudeGuidance.'],
            reviewResult.review.researchRequests,
            evidenceRefs
          ),
          modelCalls
        },
        changes: []
      };
    }

    validation = repair.validation;
    current = await currentSnapshots(workspace, originals, config);
    delta = aggregateDiff(originals, current);
    reviewResult = await reviewImplementation(
      model,
      config,
      input,
      plan,
      delta.diff,
      validation,
      modelCalls
    );
  }

  if (reviewResult.review.verdict !== 'pass' || reviewResult.review.confidence < 0.58) {
    await restoreSnapshots(workspace, originals);
    return {
      result: {
        status: 'needs-claude',
        phase: 'review',
        workspace,
        goal: input.goal,
        summary: reviewResult.review.summary,
        investigation: {
          searchQueries: investigation.searchQueries,
          evidenceFiles: fullEvidence.files,
          researchRequests: dedupe([
            ...investigation.researchRequests,
            ...planned.researchRequests,
            ...reviewResult.review.researchRequests
          ])
        },
        plan,
        execution,
        review: reviewResult.review,
        repairRounds,
        changedFiles: [],
        diff: '',
        validation,
        escalation: escalation(
          reviewResult.review.researchRequests.length > 0 ? 'external-research' : 'review-failure',
          reviewResult.review.summary,
          reviewResult.review.issues.map((issue) => `${issue.description} Suggested fix: ${issue.fix}`),
          reviewResult.review.researchRequests,
          evidenceRefs
        ),
        modelCalls
      },
      changes: []
    };
  }

  current = await currentSnapshots(workspace, originals, config);
  delta = aggregateDiff(originals, current);
  const changes = changesFromSnapshots(originals, current);

  return {
    result: {
      status: 'success',
      phase: 'complete',
      workspace,
      goal: input.goal,
      summary: reviewResult.review.summary,
      investigation: {
        searchQueries: investigation.searchQueries,
        evidenceFiles: fullEvidence.files,
        researchRequests: dedupe([...investigation.researchRequests, ...planned.researchRequests])
      },
      plan,
      execution,
      review: reviewResult.review,
      repairRounds,
      changedFiles: delta.changedFiles,
      diff: delta.diff,
      validation,
      modelCalls
    },
    changes
  };
}
