import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LocalCoderConfig } from './config.js';
import {
  executeLocalEngineer,
  type LocalEngineerExecution,
  type LocalEngineerInput,
  type LocalEngineerResult
} from './local-engineer.js';
import type { OllamaClient, OllamaGeneration } from './ollama.js';
import { resolveWorkspace, resolveWorkspacePath } from './workspace.js';

const MEMORY_VERSION = 1 as const;
const MAX_FACTS = 160;
const MAX_EPISODES = 120;
const MAX_RETRIEVED_FACTS = 14;
const MAX_CHANGED_PATHS = 500;

export type RepoMemoryKind =
  | 'architecture'
  | 'convention'
  | 'invariant'
  | 'procedure'
  | 'episodic'
  | 'failure';

export interface RepoMemoryFact {
  id: string;
  kind: RepoMemoryKind;
  text: string;
  tags: string[];
  confidence: number;
  sourcePaths: string[];
  sourceFingerprints: Record<string, string | null>;
  observedAtSha: string;
  lastValidatedSha: string;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RepoEpisode {
  id: string;
  createdAt: string;
  sha: string;
  outcome: 'success' | 'needs-claude' | 'escalated' | 'git-change';
  goal?: string;
  summary: string;
  changedFiles: string[];
  repairRounds: number;
}

interface RepoIntelligenceDocument {
  version: typeof MEMORY_VERSION;
  identityKey: string;
  repositoryHash: string;
  workspaceRelativePath: string;
  createdAt: string;
  updatedAt: string;
  lastSeenSha: string;
  facts: RepoMemoryFact[];
  episodes: RepoEpisode[];
}

export interface RepoFamiliarity {
  overall: number;
  architecture: number;
  conventions: number;
  history: number;
  freshness: number;
  facts: number;
  episodes: number;
  staleFacts: number;
}

export interface RepoIntelligenceRunSummary {
  enabled: boolean;
  identityKey?: string;
  familiarity?: RepoFamiliarity;
  retrievedFacts?: number;
  learnedFacts?: number;
  gitChangesDetected?: number;
  reason?: string;
}

export interface RepoIntelligenceSession {
  identityKey: string;
  memoryScopeKey: string;
  workspace: string;
  repoRoot: string;
  repositoryHash: string;
  workspaceRelativePath: string;
  currentSha: string;
  memoryFile: string;
  retrieved: RepoMemoryFact[];
  familiarity: RepoFamiliarity;
  gitChangesDetected: string[];
  capsule: string;
}

export interface ProposedRepoLearning {
  kind: RepoMemoryKind;
  text: string;
  tags: string[];
  sourcePaths: string[];
  confidence: number;
}

type IntelligenceConfig = Pick<LocalCoderConfig, 'workerStatePath'>;
type IntelligenceModel = Pick<OllamaClient, 'chat'>;
type RepoIntelligenceEngineerInput = LocalEngineerInput & { repoMemoryScopeKey?: string };

interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

function intelligenceEnabled(): boolean {
  const raw = process.env.LOCAL_CODER_REPO_INTELLIGENCE_ENABLED;
  return raw === undefined || !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function intelligenceRoot(config: IntelligenceConfig): string {
  const override = process.env.LOCAL_CODER_REPO_INTELLIGENCE_PATH?.trim();
  return override || path.join(config.workerStatePath, 'repo-intelligence');
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clamp100(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

function tokenize(value: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'using', 'use', 'add',
    'update', 'change', 'implement', 'fix', 'repo', 'repository', 'code', 'file', 'files',
    'como', 'para', 'com', 'uma', 'que', 'dos', 'das', 'por', 'fazer', 'usar', 'repo'
  ]);
  return [
    ...new Set(
      (value.toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) ?? []).filter(
        (term) => !stop.has(term)
      )
    )
  ];
}

async function runProcess(command: string, args: string[], cwd: string): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? -1 })
    );
  });
}

async function git(workspace: string, args: string[]): Promise<string> {
  const result = await runProcess('git', args, workspace);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString('utf8').trim()}`);
  }
  return result.stdout.toString('utf8').trim();
}

async function localMemoryScopeKey(repoRoot: string): Promise<string> {
  const rawCommonDir = await git(repoRoot, ['rev-parse', '--git-common-dir']);
  const commonDir = path.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : path.resolve(repoRoot, rawCommonDir);
  const realCommonDir = await fs.realpath(commonDir);
  return hash(realCommonDir).slice(0, 24);
}

async function gitIdentity(workspace: string, suppliedMemoryScopeKey?: string): Promise<{
  repoRoot: string;
  repositoryUrl: string;
  repositoryHash: string;
  workspaceRelativePath: string;
  currentSha: string;
  memoryScopeKey: string;
  identityKey: string;
}> {
  const resolvedWorkspace = await resolveWorkspace(workspace);
  const repoRoot = await fs.realpath(
    await git(resolvedWorkspace, ['rev-parse', '--show-toplevel'])
  );
  const repositoryUrl = await git(repoRoot, ['remote', 'get-url', 'origin']);
  const currentSha = await git(repoRoot, ['rev-parse', 'HEAD']);
  const relative = path.relative(repoRoot, resolvedWorkspace);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Repo intelligence workspace is outside its Git root.');
  }
  const workspaceRelativePath = relative.split(path.sep).join('/');
  const repositoryHash = hash(repositoryUrl);
  const memoryScopeKey = suppliedMemoryScopeKey?.trim() || await localMemoryScopeKey(repoRoot);
  if (!/^[a-f0-9]{16,64}$/i.test(memoryScopeKey)) {
    throw new Error('Repo intelligence memory scope key is invalid.');
  }
  const identityKey = hash(`${memoryScopeKey}\0${repositoryUrl}\0${workspaceRelativePath}`).slice(0, 32);
  return {
    repoRoot,
    repositoryUrl,
    repositoryHash,
    workspaceRelativePath,
    currentSha,
    memoryScopeKey,
    identityKey
  };
}

async function loadDocument(
  memoryFile: string,
  identity: Awaited<ReturnType<typeof gitIdentity>>
): Promise<RepoIntelligenceDocument> {
  try {
    const parsed = JSON.parse(await fs.readFile(memoryFile, 'utf8')) as RepoIntelligenceDocument;
    if (parsed.version !== MEMORY_VERSION || parsed.identityKey !== identity.identityKey) {
      throw new Error('Repo intelligence identity/version mismatch.');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Corrupt or old memory should not poison an engineering run. Keep a backup and rebuild.
      await fs.rename(memoryFile, `${memoryFile}.invalid-${Date.now()}`).catch(() => undefined);
    }
    const now = new Date().toISOString();
    return {
      version: MEMORY_VERSION,
      identityKey: identity.identityKey,
      repositoryHash: identity.repositoryHash,
      workspaceRelativePath: identity.workspaceRelativePath,
      createdAt: now,
      updatedAt: now,
      lastSeenSha: identity.currentSha,
      facts: [],
      episodes: []
    };
  }
}

async function saveDocument(memoryFile: string, document: RepoIntelligenceDocument): Promise<void> {
  document.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  const temporary = `${memoryFile}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, memoryFile);
}

async function withMemoryLock<T>(memoryFile: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${memoryFile}.lock`;
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        return await run();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 600_000) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for repo-intelligence lock.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function fileFingerprint(workspace: string, relativePath: string): Promise<string | null> {
  try {
    const absolute = resolveWorkspacePath(workspace, relativePath);
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > 512_000) return null;
    return hash(await fs.readFile(absolute, 'utf8'));
  } catch {
    return null;
  }
}

async function changedPathsBetween(repoRoot: string, fromSha: string, toSha: string): Promise<string[]> {
  if (!fromSha || fromSha === toSha) return [];
  const ancestor = await runProcess('git', ['merge-base', '--is-ancestor', fromSha, toSha], repoRoot);
  if (ancestor.exitCode !== 0) return [];
  const raw = await git(repoRoot, ['diff', '--name-only', '-z', `${fromSha}..${toSha}`]);
  return raw.split('\0').filter(Boolean).slice(0, MAX_CHANGED_PATHS);
}

async function refreshFreshness(
  workspace: string,
  currentSha: string,
  facts: RepoMemoryFact[],
  gitChangedPaths: Set<string>
): Promise<void> {
  for (const fact of facts) {
    let stale = false;

    for (const source of fact.sourcePaths.slice(0, 8)) {
      const expected = fact.sourceFingerprints[source] ?? null;
      const current = await fileFingerprint(workspace, source);

      // A Git-path change is a revalidation signal, not automatic invalidation. This
      // matters when local-coder learned from a dirty file and the user later commits
      // exactly that content: the SHA changes but the learned source remains identical.
      if (current !== expected || (gitChangedPaths.has(source) && expected === null)) {
        stale = true;
        break;
      }
    }

    fact.stale = stale;
    if (!stale) fact.lastValidatedSha = currentSha;
  }
}

function familiarity(document: RepoIntelligenceDocument): RepoFamiliarity {
  const architectureFacts = document.facts.filter((fact) =>
    ['architecture', 'invariant'].includes(fact.kind)
  ).length;
  const conventionFacts = document.facts.filter((fact) =>
    ['convention', 'procedure'].includes(fact.kind)
  ).length;
  const staleFacts = document.facts.filter((fact) => fact.stale).length;
  const freshness = document.facts.length === 0 ? 0 : 1 - staleFacts / document.facts.length;
  const architecture = clamp100((architectureFacts / 12) * 100);
  const conventions = clamp100((conventionFacts / 12) * 100);
  const history = clamp100((document.episodes.filter((episode) => episode.outcome !== 'git-change').length / 20) * 100);
  const freshnessScore = clamp100(freshness * 100);
  const coverage = clamp100((document.facts.length / 30) * 100);
  return {
    overall: clamp100(
      architecture * 0.25 + conventions * 0.2 + history * 0.2 + freshnessScore * 0.2 + coverage * 0.15
    ),
    architecture,
    conventions,
    history,
    freshness: freshnessScore,
    facts: document.facts.length,
    episodes: document.episodes.length,
    staleFacts
  };
}

function retrieveFacts(document: RepoIntelligenceDocument, goal: string): RepoMemoryFact[] {
  const terms = new Set(tokenize(goal));
  const kindWeight: Record<RepoMemoryKind, number> = {
    invariant: 8,
    architecture: 7,
    procedure: 6,
    convention: 5,
    failure: 4,
    episodic: 2
  };

  const scored = document.facts.map((fact) => {
    const factTerms = new Set(tokenize(`${fact.text} ${fact.tags.join(' ')} ${fact.sourcePaths.join(' ')}`));
    let overlap = 0;
    for (const term of terms) if (factTerms.has(term)) overlap += 1;
    const generalPrior = ['invariant', 'architecture', 'procedure'].includes(fact.kind) ? 1 : 0;
    const score =
      (overlap * 10 + kindWeight[fact.kind] + generalPrior) *
      fact.confidence *
      (fact.stale ? 0.3 : 1);
    return { fact, score };
  });

  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.fact.updatedAt.localeCompare(a.fact.updatedAt))
    .slice(0, MAX_RETRIEVED_FACTS)
    .map(({ fact }) => fact);
}

function memoryCapsule(retrieved: RepoMemoryFact[], score: RepoFamiliarity): string {
  if (retrieved.length === 0) {
    return `# PERSISTENT REPO INTELLIGENCE\nFamiliarity: ${score.overall}/100. No relevant durable memories yet. Treat current repository evidence as authoritative.`;
  }
  const lines = retrieved.map((fact) => {
    const state = fact.stale ? 'STALE: verify source before relying' : 'fresh';
    return `- [${fact.kind}] [${state}] confidence=${fact.confidence.toFixed(2)} ${fact.text}\n  sources: ${fact.sourcePaths.join(', ') || '[none]'}`;
  });
  return [
    '# PERSISTENT REPO INTELLIGENCE',
    `Familiarity: ${score.overall}/100 (architecture=${score.architecture}, conventions=${score.conventions}, history=${score.history}, freshness=${score.freshness}).`,
    'These are prior evidence-backed memories, not authority. Current source code/tests win. Verify any STALE memory before using it, and do not preserve a remembered pattern when current repository evidence contradicts it.',
    ...lines
  ].join('\n');
}

export async function prepareRepoIntelligence(
  workspace: string,
  goal: string,
  config: IntelligenceConfig,
  memoryScopeKey?: string
): Promise<RepoIntelligenceSession> {
  const resolvedWorkspace = await resolveWorkspace(workspace);
  const identity = await gitIdentity(resolvedWorkspace, memoryScopeKey);
  const memoryFile = path.join(intelligenceRoot(config), identity.identityKey, 'memory.json');
  return await withMemoryLock(memoryFile, async () => {
    const document = await loadDocument(memoryFile, identity);
    const changed = await changedPathsBetween(identity.repoRoot, document.lastSeenSha, identity.currentSha);
    const changedSet = new Set(changed);
    await refreshFreshness(resolvedWorkspace, identity.currentSha, document.facts, changedSet);
    if (changed.length > 0) {
      document.episodes.push({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        sha: identity.currentSha,
        outcome: 'git-change',
        summary: `Observed ${changed.length} committed path change(s) since the previous repo-intelligence run.`,
        changedFiles: changed,
        repairRounds: 0
      });
    }
    document.lastSeenSha = identity.currentSha;
    document.episodes = document.episodes.slice(-MAX_EPISODES);
    await saveDocument(memoryFile, document);
    const score = familiarity(document);
    const retrieved = retrieveFacts(document, goal);
    return {
      identityKey: identity.identityKey,
      memoryScopeKey: identity.memoryScopeKey,
      workspace: resolvedWorkspace,
      repoRoot: identity.repoRoot,
      repositoryHash: identity.repositoryHash,
      workspaceRelativePath: identity.workspaceRelativePath,
      currentSha: identity.currentSha,
      memoryFile,
      retrieved,
      familiarity: score,
      gitChangesDetected: changed,
      capsule: memoryCapsule(retrieved, score)
    };
  });
}

async function sourceFingerprints(
  workspace: string,
  sourcePaths: string[]
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const source of sourcePaths.slice(0, 8)) result[source] = await fileFingerprint(workspace, source);
  return result;
}

function learningKey(kind: RepoMemoryKind, text: string): string {
  return hash(`${kind}\0${text.trim().toLowerCase().replace(/\s+/g, ' ')}`).slice(0, 24);
}

export async function recordRepoIntelligenceLearning(
  session: RepoIntelligenceSession,
  config: IntelligenceConfig,
  input: {
    result: LocalEngineerResult;
    facts?: ProposedRepoLearning[];
  }
): Promise<{ learnedFacts: number; familiarity: RepoFamiliarity }> {
  const identity = await gitIdentity(session.workspace, session.memoryScopeKey);
  return await withMemoryLock(session.memoryFile, async () => {
    const document = await loadDocument(session.memoryFile, identity);
    const now = new Date().toISOString();
    let learnedFacts = 0;
    const allowedEvidence = new Set([
      ...input.result.changedFiles,
      ...input.result.investigation.evidenceFiles,
      ...(input.result.plan?.tasks.flatMap((task) => [...task.editableFiles, ...task.contextFiles]) ?? [])
    ]);

    for (const proposed of input.facts ?? []) {
      const sourcePaths = [...new Set(proposed.sourcePaths.filter((source) => allowedEvidence.has(source)))].slice(0, 8);
      if (
        ['architecture', 'convention', 'invariant', 'procedure'].includes(proposed.kind) &&
        sourcePaths.length === 0
      ) {
        continue;
      }
      const id = learningKey(proposed.kind, proposed.text);
      const fingerprints = await sourceFingerprints(session.workspace, sourcePaths);
      const existing = document.facts.find((fact) => fact.id === id);
      const next: RepoMemoryFact = {
        id,
        kind: proposed.kind,
        text: proposed.text.trim().slice(0, 1200),
        tags: [...new Set(proposed.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12),
        confidence: Math.min(0.95, clamp01(proposed.confidence)),
        sourcePaths,
        sourceFingerprints: fingerprints,
        observedAtSha: identity.currentSha,
        lastValidatedSha: identity.currentSha,
        stale: false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if (existing) Object.assign(existing, next);
      else document.facts.push(next);
      learnedFacts += 1;
    }

    document.episodes.push({
      id: randomUUID(),
      createdAt: now,
      sha: identity.currentSha,
      outcome: input.result.status,
      goal: input.result.goal.slice(0, 1200),
      summary: input.result.summary.slice(0, 1600),
      changedFiles: input.result.changedFiles.slice(0, 60),
      repairRounds: input.result.repairRounds
    });
    document.facts = document.facts
      .sort((a, b) => Number(a.stale) - Number(b.stale) || b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_FACTS);
    document.episodes = document.episodes.slice(-MAX_EPISODES);
    document.lastSeenSha = identity.currentSha;
    await saveDocument(session.memoryFile, document);
    return { learnedFacts, familiarity: familiarity(document) };
  });
}

const learningFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'tags', 'sourcePaths', 'confidence'],
        properties: {
          kind: {
            type: 'string',
            enum: ['architecture', 'convention', 'invariant', 'procedure', 'episodic', 'failure']
          },
          text: { type: 'string' },
          tags: { type: 'array', maxItems: 12, items: { type: 'string' } },
          sourcePaths: { type: 'array', maxItems: 8, items: { type: 'string' } },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        }
      }
    }
  }
} satisfies Record<string, unknown>;

interface LearningPayload {
  facts: ProposedRepoLearning[];
}

async function extractLearnings(
  model: IntelligenceModel,
  config: LocalCoderConfig,
  result: LocalEngineerResult
): Promise<{ payload: LearningPayload; generation: OllamaGeneration }> {
  const prompt = [
    `# GOAL\n${result.goal}`,
    `# RESULT\n${result.summary}`,
    result.plan
      ? `# PLAN DECISIONS\n${result.plan.decisions.map((item) => `- ${item}`).join('\n')}`
      : '',
    `# CHANGED FILES\n${result.changedFiles.map((item) => `- ${item}`).join('\n')}`,
    result.review
      ? `# REVIEW\nverdict=${result.review.verdict}; confidence=${result.review.confidence}\n${result.review.summary}`
      : '',
    `# VALIDATION\n${result.validation
      .map((item) => `${item.ok ? 'PASS' : 'FAIL'} ${item.command} ${item.args.join(' ')}`)
      .join('\n')}`,
    `# REPAIR ROUNDS\n${result.repairRounds}`,
    `# DIFF (bounded)\n${result.diff.slice(0, 12_000)}`
  ]
    .filter(Boolean)
    .join('\n\n');

  const system = `You maintain durable repository intelligence for future software-engineering tasks.
Extract only reusable knowledge supported by this successful run: architecture boundaries, conventions, invariants, repeatable procedures, useful past failure lessons, or a concise episode.
Do not store secrets, credentials, tokens, user data, transient generated values, or broad facts unsupported by repository evidence.
For architecture/convention/invariant/procedure facts, cite one or more supplied repository paths. Prefer a few high-value durable facts over many weak facts.
Do not treat Claude-only guidance or model speculation as durable truth unless the successful repository result provides source evidence.
Return JSON only.`;

  const generation = await model.chat(system, prompt, learningFormat, {
    model: config.model,
    numCtx: config.ollamaNumCtx ?? 16_384,
    keepAlive: config.fastModelKeepAlive ?? '90s',
    think: 'low'
  });
  const parsed = JSON.parse(generation.content) as LearningPayload;
  if (!parsed || !Array.isArray(parsed.facts)) throw new Error('Repo-intelligence learner returned invalid JSON.');
  return { payload: parsed, generation };
}

function attachSummary(
  execution: LocalEngineerExecution,
  summary: RepoIntelligenceRunSummary
): LocalEngineerExecution {
  (execution.result as LocalEngineerResult & { repoIntelligence?: RepoIntelligenceRunSummary }).repoIntelligence = summary;
  return execution;
}

export async function executeLocalEngineerWithRepoIntelligence(
  model: IntelligenceModel,
  config: LocalCoderConfig,
  input: RepoIntelligenceEngineerInput
): Promise<LocalEngineerExecution> {
  if (!intelligenceEnabled()) return await executeLocalEngineer(model, config, input);

  const { repoMemoryScopeKey, ...engineerInput } = input;
  let session: RepoIntelligenceSession;
  try {
    session = await prepareRepoIntelligence(
      engineerInput.workspace,
      engineerInput.goal,
      config,
      repoMemoryScopeKey
    );
  } catch (error) {
    const execution = await executeLocalEngineer(model, config, engineerInput);
    return attachSummary(execution, {
      enabled: false,
      reason: `Repo intelligence unavailable; engineering continued without memory. ${error instanceof Error ? error.message : String(error)}`
    });
  }

  const context = [engineerInput.context?.trim(), session.capsule].filter(Boolean).join('\n\n');
  const execution = await executeLocalEngineer(model, config, { ...engineerInput, context });
  let learnedFacts = 0;
  let updatedFamiliarity = session.familiarity;

  try {
    let facts: ProposedRepoLearning[] = [];
    if (execution.result.status === 'success') {
      const learned = await extractLearnings(model, config, execution.result);
      facts = learned.payload.facts.slice(0, 12);
    }
    const recorded = await recordRepoIntelligenceLearning(session, config, {
      result: execution.result,
      facts
    });
    learnedFacts = recorded.learnedFacts;
    updatedFamiliarity = recorded.familiarity;
  } catch {
    // Memory learning is advisory and must never invalidate an otherwise-correct engineering run.
  }

  return attachSummary(execution, {
    enabled: true,
    identityKey: session.identityKey,
    familiarity: updatedFamiliarity,
    retrievedFacts: session.retrieved.length,
    learnedFacts,
    gitChangesDetected: session.gitChangesDetected.length
  });
}
