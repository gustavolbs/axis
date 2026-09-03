import type { AgentAuthKind, AgentRoot, AgentSessionContext, MutationStatus } from '../agent-runtime/index.js';

export const PROJECT_MEMORY_VERSION = 1 as const;

export type ProjectMemorySessionStatus = 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface ProjectMemoryScope {
  readonly companyId: string;
  readonly projectId: string;
  readonly rootId: string;
  readonly rootFingerprint: string;
}

export interface ProjectMemoryRootBinding {
  readonly scope: ProjectMemoryScope;
  readonly root: AgentRoot;
}

export interface ProjectMemoryOrigin {
  readonly connectionId: string;
  readonly providerFamily: string;
  readonly authKind: AgentAuthKind;
  readonly modelId: string;
  readonly executionTargetId: string;
}

export interface ProjectMemoryToolObservation {
  readonly callId: string;
  readonly toolName: string;
  readonly status?: 'success' | 'error' | 'cancelled';
  readonly timestamp: string;
}

export interface ProjectMemoryActivity {
  readonly callId: string;
  readonly toolName: string;
  readonly status: 'success' | 'error' | 'cancelled';
  readonly timestamp: string;
  readonly detail?: string;
  readonly path?: string;
  readonly mutationStatus?: MutationStatus;
}

export interface ProjectMemoryDecision {
  readonly id: string;
  readonly kind: string;
  readonly prompt: string;
  readonly timestamp: string;
  status: 'pending' | 'resolved' | 'denied';
  resolution?: string;
}

export interface ProjectMemoryError {
  readonly code: string;
  readonly kind: string;
  readonly message: string;
  readonly timestamp: string;
  readonly callId?: string;
  readonly toolName?: string;
}

export interface ProjectMemoryCancellation {
  readonly source: 'caller' | 'provider' | 'tool';
  readonly timestamp: string;
  readonly callId?: string;
  readonly toolName?: string;
}

export interface ProjectMemorySessionRecord {
  readonly sessionId: string;
  origin: ProjectMemoryOrigin;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  status: ProjectMemorySessionStatus;
  turnCount: number;
  toolCalls: ProjectMemoryToolObservation[];
  toolResults: ProjectMemoryToolObservation[];
  goals: string[];
  reads: ProjectMemoryActivity[];
  mutations: ProjectMemoryActivity[];
  commands: ProjectMemoryActivity[];
  validations: ProjectMemoryActivity[];
  decisions: ProjectMemoryDecision[];
  errors: ProjectMemoryError[];
  cancellations: ProjectMemoryCancellation[];
  activeFiles: string[];
  changedFiles: string[];
  branch?: string;
  worktree?: string;
  completionSummary?: string;
  currentState: string;
  observedEventIds: string[];
}

export interface ProjectMemoryCompaction {
  sessionCount: number;
  firstCompactedAt?: string;
  lastCompactedAt?: string;
  statuses: Partial<Record<ProjectMemorySessionStatus, number>>;
  changedFiles: string[];
  recentGoals: string[];
  recentFailures: string[];
}

export interface ProjectMemoryDocument {
  version: typeof PROJECT_MEMORY_VERSION;
  scope: ProjectMemoryScope;
  createdAt: string;
  updatedAt: string;
  sessions: ProjectMemorySessionRecord[];
  compaction: ProjectMemoryCompaction;
}

export interface ProjectMemoryRetentionPolicy {
  readonly maxSessions: number;
  readonly maxSessionAgeDays: number;
  readonly maxActivitiesPerKind: number;
  readonly maxGoalsPerSession: number;
  readonly maxFilesPerSession: number;
  readonly maxObservedEventIds: number;
  readonly maxTextChars: number;
}

export interface ProjectMemoryHandoff {
  readonly companyId: string;
  readonly projectId: string;
  readonly rootId: string;
  readonly sessionId: string;
  readonly origin: ProjectMemoryOrigin;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: ProjectMemorySessionStatus;
  readonly goal?: string;
  readonly branch?: string;
  readonly worktree?: string;
  readonly investigationSummary: string;
  readonly activeFiles: readonly string[];
  readonly changedFiles: readonly string[];
  readonly decisions: readonly string[];
  readonly failedAttempts: readonly string[];
  readonly validations: readonly string[];
  readonly openQuestions: readonly string[];
  readonly currentState: string;
  readonly nextStep: string;
  readonly completionSummary?: string;
}

export interface ProjectDurableMemoryResult {
  readonly capsule: string;
  readonly retrievedFacts?: number;
}

export interface ProjectDurableMemorySource {
  load(input: {
    readonly session: AgentSessionContext;
    readonly root: AgentRoot;
    readonly task: string;
  }): Promise<ProjectDurableMemoryResult | undefined>;
}

export interface ProjectMemoryContextEntry {
  readonly scope: ProjectMemoryScope;
  readonly handoff?: ProjectMemoryHandoff;
  readonly durableMemory?: ProjectDurableMemoryResult;
  readonly capsule: string;
}

export interface ProjectMemoryContext {
  readonly companyId: string;
  readonly projectId: string;
  readonly entries: readonly ProjectMemoryContextEntry[];
  readonly capsule: string;
}
