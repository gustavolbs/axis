import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectMemoryScopeKey } from './identity.js';
import {
  PROJECT_MEMORY_VERSION,
  type ProjectMemoryCompaction,
  type ProjectMemoryDocument,
  type ProjectMemoryHandoff,
  type ProjectMemoryRetentionPolicy,
  type ProjectMemoryScope,
  type ProjectMemorySessionRecord,
  type ProjectMemorySessionStatus
} from './types.js';

const DEFAULT_RETENTION: ProjectMemoryRetentionPolicy = Object.freeze({
  maxSessions: 24,
  maxSessionAgeDays: 45,
  maxActivitiesPerKind: 40,
  maxGoalsPerSession: 8,
  maxFilesPerSession: 60,
  maxObservedEventIds: 192,
  maxTextChars: 2_000
});

const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

export interface ProjectMemoryStoreOptions {
  readonly rootDirectory?: string;
  readonly retention?: Partial<ProjectMemoryRetentionPolicy>;
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 96);
  return normalized || 'unknown';
}

function emptyCompaction(): ProjectMemoryCompaction {
  return { sessionCount: 0, statuses: {}, changedFiles: [], recentGoals: [], recentFailures: [] };
}

function emptyDocument(scope: ProjectMemoryScope): ProjectMemoryDocument {
  const now = new Date().toISOString();
  return {
    version: PROJECT_MEMORY_VERSION,
    scope: { ...scope },
    createdAt: now,
    updatedAt: now,
    sessions: [],
    compaction: emptyCompaction()
  };
}

function sameScope(a: ProjectMemoryScope, b: ProjectMemoryScope): boolean {
  return a.companyId === b.companyId && a.projectId === b.projectId && a.rootFingerprint === b.rootFingerprint;
}

function boundedUnique(values: readonly string[], maxItems: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= maxItems) break;
  }
  return result;
}

function statusIncrement(
  statuses: Partial<Record<ProjectMemorySessionStatus, number>>,
  status: ProjectMemorySessionStatus
): void {
  statuses[status] = (statuses[status] ?? 0) + 1;
}

function compactSession(compaction: ProjectMemoryCompaction, session: ProjectMemorySessionRecord): void {
  compaction.sessionCount += 1;
  compaction.firstCompactedAt ??= session.updatedAt;
  compaction.lastCompactedAt = session.updatedAt;
  statusIncrement(compaction.statuses, session.status);
  compaction.changedFiles = boundedUnique(
    [...session.changedFiles, ...compaction.changedFiles],
    60
  );
  compaction.recentGoals = boundedUnique(
    [...session.goals.slice().reverse(), ...compaction.recentGoals],
    12
  );
  const failures = session.errors.map((error) => `${error.code}: ${error.message}`);
  compaction.recentFailures = boundedUnique(
    [...failures.slice().reverse(), ...compaction.recentFailures],
    12
  );
}

function normalizeRetention(input: Partial<ProjectMemoryRetentionPolicy> | undefined): ProjectMemoryRetentionPolicy {
  const merged = { ...DEFAULT_RETENTION, ...input };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Project Memory retention ${name} must be a positive integer.`);
  }
  return merged;
}

function retentionCutoff(policy: ProjectMemoryRetentionPolicy): number {
  return Date.now() - policy.maxSessionAgeDays * 24 * 60 * 60 * 1_000;
}

function compactDocument(document: ProjectMemoryDocument, policy: ProjectMemoryRetentionPolicy): void {
  const cutoff = retentionCutoff(policy);
  const live = document.sessions
    .filter((session) => session.status === 'active' || session.status === 'paused')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const completed = document.sessions
    .filter((session) => session.status !== 'active' && session.status !== 'paused')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const recentCompleted = completed.filter((session) => Date.parse(session.updatedAt) >= cutoff);
  const remainingSlots = Math.max(0, policy.maxSessions - live.length);
  const keptCompleted = recentCompleted.slice(0, remainingSlots);
  const keptIds = new Set([...live, ...keptCompleted].map((session) => session.sessionId));
  const dropped = document.sessions.filter((session) => !keptIds.has(session.sessionId));
  for (const session of dropped.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    compactSession(document.compaction, session);
  }
  document.sessions = [...live, ...keptCompleted];
}

function tokenize(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9_.\/-]{3,}/g) ?? []).slice(0, 120));
}

function relevance(session: ProjectMemorySessionRecord, task: string): number {
  const terms = tokenize(task);
  if (terms.size === 0) return 0;
  const haystack = tokenize([
    ...session.goals,
    session.completionSummary ?? '',
    ...session.activeFiles,
    ...session.changedFiles,
    ...session.errors.map((error) => error.message)
  ].join(' '));
  let overlap = 0;
  for (const term of terms) if (haystack.has(term)) overlap += 1;
  return overlap;
}

function investigationSummary(session: ProjectMemorySessionRecord): string {
  const parts: string[] = [];
  if (session.reads.length > 0) {
    const paths = boundedUnique(session.reads.map((item) => item.path ?? '').filter(Boolean), 6);
    parts.push(`Inspected ${session.reads.length} read operation(s)${paths.length ? ` across ${paths.join(', ')}` : ''}.`);
  }
  if (session.commands.length > 0) parts.push(`Ran ${session.commands.length} command operation(s).`);
  if (session.mutations.length > 0) parts.push(`Recorded ${session.mutations.length} mutation operation(s).`);
  if (session.validations.length > 0) parts.push(`Ran ${session.validations.length} validation operation(s).`);
  return parts.join(' ') || 'No repository activity was retained for this session.';
}

function validationLines(session: ProjectMemorySessionRecord): string[] {
  return session.validations.slice(-12).map((item) => {
    const detail = item.detail ? ` — ${item.detail}` : '';
    return `${item.status}${detail}`;
  });
}

function failureLines(session: ProjectMemorySessionRecord): string[] {
  return boundedUnique([
    ...session.errors.slice().reverse().map((error) => `${error.code}: ${error.message}`),
    ...session.commands.filter((item) => item.status !== 'success').slice().reverse().map((item) => item.detail ?? `${item.toolName} ${item.status}`),
    ...session.mutations.filter((item) => item.status !== 'success').slice().reverse().map((item) => item.detail ?? `${item.toolName} ${item.status}`)
  ], 12);
}

function nextStep(session: ProjectMemorySessionRecord): string {
  let pending;
  for (let index = session.decisions.length - 1; index >= 0; index -= 1) {
    if (session.decisions[index]?.status === 'pending') {
      pending = session.decisions[index];
      break;
    }
  }
  if (pending) return `Resolve the pending decision: ${pending.prompt}`;
  if (session.status === 'failed') return 'Resume from the recorded state after reviewing the retained failure and current repository evidence.';
  if (session.status === 'cancelled') return 'Resume only if the cancelled work is still desired; verify mutation state before repeating uncertain operations.';
  if (session.status === 'paused') return 'Continue the paused session from the recorded state and current repository evidence.';
  if (session.status === 'active') return 'Continue from the recorded active state without replaying completed investigation unnecessarily.';
  return 'Use the handoff as historical context, then verify current repository evidence before making new changes.';
}

export class ProjectMemoryStore {
  readonly rootDirectory: string;
  readonly retention: ProjectMemoryRetentionPolicy;

  constructor(options: ProjectMemoryStoreOptions = {}) {
    const configuredRoot = options.rootDirectory?.trim()
      || process.env.AXIS_PROJECT_MEMORY_PATH?.trim()
      || process.env.LOCAL_CODER_PROJECT_MEMORY_PATH?.trim()
      || path.join(os.homedir(), '.local-coder-mcp', 'project-memory');
    this.rootDirectory = path.resolve(configuredRoot);
    this.retention = normalizeRetention(options.retention);
  }

  fileForScope(scope: ProjectMemoryScope): string {
    return path.join(
      this.rootDirectory,
      'companies', safeSegment(scope.companyId),
      'projects', safeSegment(scope.projectId),
      'roots', projectMemoryScopeKey(scope),
      'memory.json'
    );
  }

  update(scope: ProjectMemoryScope, mutate: (document: ProjectMemoryDocument) => void): void {
    const file = this.fileForScope(scope);
    this.withLock(file, () => {
      const document = this.readDocument(file, scope);
      mutate(document);
      compactDocument(document, this.retention);
      document.updatedAt = new Date().toISOString();
      this.writeDocument(file, document);
    });
  }

  read(scope: ProjectMemoryScope): ProjectMemoryDocument {
    return structuredClone(this.readDocument(this.fileForScope(scope), scope));
  }

  loadHandoff(
    scope: ProjectMemoryScope,
    task = '',
    options: { readonly excludeSessionId?: string } = {}
  ): ProjectMemoryHandoff | undefined {
    const document = this.readDocument(this.fileForScope(scope), scope);
    const candidates = document.sessions.filter((session) => session.sessionId !== options.excludeSessionId);
    if (candidates.length === 0) return undefined;
    const ranked = candidates.slice().sort((a, b) => {
      const aLive = a.status === 'active' || a.status === 'paused' ? 1 : 0;
      const bLive = b.status === 'active' || b.status === 'paused' ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;
      const relevanceDelta = relevance(b, task) - relevance(a, task);
      if (relevanceDelta !== 0) return relevanceDelta;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return this.toHandoff(scope, ranked[0]!);
  }

  compact(scope: ProjectMemoryScope): void {
    this.update(scope, () => undefined);
  }

  private toHandoff(scope: ProjectMemoryScope, session: ProjectMemorySessionRecord): ProjectMemoryHandoff {
    const decisions = session.decisions.slice(-12).map((decision) => {
      const resolution = decision.resolution ? ` → ${decision.resolution}` : '';
      return `${decision.status}: ${decision.prompt}${resolution}`;
    });
    const openQuestions = session.decisions
      .filter((decision) => decision.status === 'pending')
      .slice(-8)
      .map((decision) => decision.prompt);
    return {
      companyId: scope.companyId,
      projectId: scope.projectId,
      rootId: scope.rootId,
      sessionId: session.sessionId,
      origin: structuredClone(session.origin),
      createdAt: session.startedAt,
      updatedAt: session.updatedAt,
      status: session.status,
      goal: session.goals.at(-1),
      branch: session.branch,
      worktree: session.worktree,
      investigationSummary: investigationSummary(session),
      activeFiles: [...session.activeFiles],
      changedFiles: [...session.changedFiles],
      decisions,
      failedAttempts: failureLines(session),
      validations: validationLines(session),
      openQuestions,
      currentState: session.currentState,
      nextStep: nextStep(session),
      completionSummary: session.completionSummary
    };
  }

  private readDocument(file: string, scope: ProjectMemoryScope): ProjectMemoryDocument {
    if (!fs.existsSync(file)) return emptyDocument(scope);
    let parsed: ProjectMemoryDocument;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectMemoryDocument;
    } catch (error) {
      throw new Error(`Could not read Project Memory: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed.version !== PROJECT_MEMORY_VERSION || !parsed.scope || !sameScope(parsed.scope, scope)) {
      throw new Error('Project Memory identity/version mismatch.');
    }
    return parsed;
  }

  private writeDocument(file: string, document: ProjectMemoryDocument): void {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temporary, file);
      try { fs.chmodSync(file, 0o600); } catch { /* best effort on non-POSIX */ }
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      throw error;
    }
  }

  private withLock<T>(file: string, run: () => T): T {
    const lock = `${file}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 2_000;
    while (true) {
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(lock, 'wx', 0o600);
        return run();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(lock);
          if (Date.now() - stat.mtimeMs > 30_000) {
            fs.unlinkSync(lock);
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
        if (Date.now() >= deadline) throw new Error('Timed out waiting for Project Memory lock.');
        Atomics.wait(LOCK_SLEEP, 0, 0, 15);
      } finally {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); } catch { /* best effort */ }
          try { fs.unlinkSync(lock); } catch { /* best effort */ }
        }
      }
    }
  }
}
