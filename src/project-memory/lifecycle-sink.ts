import type {
  AgentLifecycleEvent,
  AgentLifecycleSink,
  AgentSessionContext,
  ToolResult
} from '../agent-runtime/index.js';
import { projectMemoryRootBindings } from './identity.js';
import { redactProjectMemoryText, safeProjectMemoryString, safeProjectMemoryStringArray } from './redaction.js';
import { ProjectMemoryStore } from './store.js';
import type {
  ProjectMemoryActivity,
  ProjectMemoryDecision,
  ProjectMemoryRootBinding,
  ProjectMemorySessionRecord,
  ProjectMemorySessionStatus,
  ProjectMemoryToolObservation
} from './types.js';

interface SessionBinding {
  readonly context: AgentSessionContext;
  readonly roots: readonly ProjectMemoryRootBinding[];
  readonly callRootIds: Map<string, string>;
}

export interface ProjectMemoryLifecycleRecorderOptions {
  readonly onError?: (error: unknown, event: AgentLifecycleEvent) => void;
}

function eventIsTransient(event: AgentLifecycleEvent): boolean {
  return ['provider.started', 'provider.progress', 'provider.completed', 'tool.progress'].includes(event.type);
}

function boundedPush<T>(values: T[], value: T, maxItems: number): void {
  values.push(value);
  if (values.length > maxItems) values.splice(0, values.length - maxItems);
}

function boundedUniquePush(values: string[], value: string, maxItems: number): void {
  if (!value || values.includes(value)) return;
  values.push(value);
  if (values.length > maxItems) values.splice(0, values.length - maxItems);
}

function stringMetadata(metadata: Readonly<Record<string, unknown>> | undefined, key: string, maxChars = 500): string | undefined {
  return safeProjectMemoryString(metadata?.[key], maxChars);
}

function metadataForEvent(event: AgentLifecycleEvent): Readonly<Record<string, unknown>> | undefined {
  switch (event.type) {
    case 'read':
    case 'mutation':
    case 'command':
    case 'validation':
      return event.metadata;
    case 'tool.progress':
      return event.progress.metadata;
    case 'tool.result':
      return event.result.metadata;
    default:
      return undefined;
  }
}

function rootHint(event: AgentLifecycleEvent, binding: SessionBinding): string | undefined {
  if (event.type === 'tool.call') {
    const argumentRootId = safeProjectMemoryString(event.call.arguments.rootId, 200);
    if (argumentRootId) binding.callRootIds.set(event.call.id, argumentRootId);
    return argumentRootId;
  }
  const metadata = metadataForEvent(event);
  const explicit = stringMetadata(metadata, 'rootId', 200);
  if (explicit) return explicit;
  const callId = 'callId' in event && typeof event.callId === 'string'
    ? event.callId
    : event.type === 'tool.result'
      ? event.result.callId
      : undefined;
  return callId ? binding.callRootIds.get(callId) : undefined;
}

function eventIsRootScoped(event: AgentLifecycleEvent): boolean {
  return [
    'tool.call', 'tool.progress', 'tool.result', 'read', 'mutation', 'command', 'validation'
  ].includes(event.type);
}

function routeRoots(event: AgentLifecycleEvent, binding: SessionBinding): readonly ProjectMemoryRootBinding[] {
  if (!eventIsRootScoped(event)) return binding.roots;
  const hinted = rootHint(event, binding);
  if (hinted) return binding.roots.filter((candidate) => candidate.root.id === hinted);
  return binding.roots.length === 1 ? binding.roots : [];
}

function activityPath(metadata: Readonly<Record<string, unknown>> | undefined): string | undefined {
  return stringMetadata(metadata, 'relativePath', 800)
    ?? stringMetadata(metadata, 'path', 800)
    ?? safeProjectMemoryStringArray(metadata?.paths, 1, 800)[0];
}

function updateLocationHints(record: ProjectMemorySessionRecord, metadata: Readonly<Record<string, unknown>> | undefined): void {
  record.branch = stringMetadata(metadata, 'branch', 300) ?? record.branch;
  record.worktree = stringMetadata(metadata, 'worktree', 800)
    ?? stringMetadata(metadata, 'workspace', 800)
    ?? record.worktree;
}

function toolObservation(callId: string, toolName: string, timestamp: string, status?: ToolResult['status']): ProjectMemoryToolObservation {
  return { callId, toolName, timestamp, status };
}

function createSessionRecord(context: AgentSessionContext, timestamp: string): ProjectMemorySessionRecord {
  return {
    sessionId: context.sessionId,
    origin: {
      connectionId: context.connection.id,
      providerFamily: context.connection.providerFamily,
      authKind: context.connection.authKind,
      modelId: context.modelId,
      executionTargetId: context.executionTarget.id
    },
    startedAt: timestamp,
    updatedAt: timestamp,
    status: 'active',
    turnCount: 0,
    toolCalls: [],
    toolResults: [],
    goals: [],
    reads: [],
    mutations: [],
    commands: [],
    validations: [],
    decisions: [],
    errors: [],
    cancellations: [],
    activeFiles: [],
    changedFiles: [],
    currentState: 'Session started.',
    observedEventIds: []
  };
}

function upsertSession(
  record: ProjectMemorySessionRecord | undefined,
  context: AgentSessionContext,
  timestamp: string,
  activate: boolean
): ProjectMemorySessionRecord {
  if (record) {
    record.origin = {
      connectionId: context.connection.id,
      providerFamily: context.connection.providerFamily,
      authKind: context.connection.authKind,
      modelId: context.modelId,
      executionTargetId: context.executionTarget.id
    };
    record.updatedAt = timestamp;
    if (activate) {
      record.status = 'active';
      delete record.completedAt;
      record.currentState = 'Session resumed.';
    }
    return record;
  }
  return createSessionRecord(context, timestamp);
}

function findLastDecision(record: ProjectMemorySessionRecord, id: string): ProjectMemoryDecision | undefined {
  for (let index = record.decisions.length - 1; index >= 0; index -= 1) {
    const decision = record.decisions[index];
    if (decision?.id === id) return decision;
  }
  return undefined;
}

function decisionText(resolution: { optionId?: string; text?: string }): string | undefined {
  return safeProjectMemoryString(resolution.text, 1_000)
    ?? safeProjectMemoryString(resolution.optionId, 300);
}

function setSessionStatus(record: ProjectMemorySessionRecord, status: ProjectMemorySessionStatus): void {
  record.status = status;
}

function applyEvent(
  record: ProjectMemorySessionRecord,
  event: AgentLifecycleEvent,
  store: ProjectMemoryStore
): void {
  if (record.observedEventIds.includes(event.id)) return;
  boundedPush(record.observedEventIds, event.id, store.retention.maxObservedEventIds);
  record.updatedAt = event.timestamp;
  const maxActivity = store.retention.maxActivitiesPerKind;
  const maxFiles = store.retention.maxFilesPerSession;
  const textLimit = store.retention.maxTextChars;

  switch (event.type) {
    case 'session.started':
      record.currentState = 'Session started.';
      break;
    case 'turn.started':
      record.turnCount = Math.max(record.turnCount, event.turn.index + 1);
      record.currentState = `Turn ${event.turn.index + 1} started.`;
      break;
    case 'user.input': {
      const goal = redactProjectMemoryText(event.message.content, textLimit);
      if (goal) boundedPush(record.goals, goal, store.retention.maxGoalsPerSession);
      record.currentState = goal ? `Working on: ${goal}` : 'User input received.';
      break;
    }
    case 'permission.requested': {
      const prompt = redactProjectMemoryText(
        `Permission requested for ${event.call.name}: ${event.permissions.join(', ')}`,
        textLimit
      );
      const decision: ProjectMemoryDecision = {
        id: `permission:${event.call.id}`,
        kind: 'permission',
        prompt,
        timestamp: event.timestamp,
        status: 'pending'
      };
      boundedPush(record.decisions, decision, maxActivity);
      record.currentState = prompt;
      break;
    }
    case 'permission.resolved': {
      const id = `permission:${event.callId}`;
      const existing = findLastDecision(record, id);
      if (existing) {
        existing.status = event.allowed ? 'resolved' : 'denied';
        existing.resolution = redactProjectMemoryText(event.reason ?? (event.allowed ? 'allowed' : 'denied'), 1_000);
      }
      record.currentState = `Permission ${event.allowed ? 'allowed' : 'denied'} for tool call ${event.callId}.`;
      break;
    }
    case 'decision.requested': {
      const prompt = redactProjectMemoryText(event.request.prompt, textLimit);
      boundedPush(record.decisions, {
        id: event.request.id,
        kind: event.request.kind,
        prompt,
        timestamp: event.timestamp,
        status: 'pending'
      }, maxActivity);
      record.currentState = `Waiting for decision: ${prompt}`;
      break;
    }
    case 'decision.resolved': {
      const existing = findLastDecision(record, event.resolution.requestId);
      if (existing) {
        existing.status = 'resolved';
        existing.resolution = decisionText(event.resolution);
      }
      record.currentState = `Decision ${event.resolution.requestId} resolved.`;
      break;
    }
    case 'tool.call':
      boundedPush(record.toolCalls, toolObservation(event.call.id, event.call.name, event.timestamp), maxActivity);
      record.currentState = `Running tool ${event.call.name}.`;
      break;
    case 'tool.result':
      boundedPush(record.toolResults, toolObservation(
        event.result.callId,
        event.result.toolName,
        event.timestamp,
        event.result.status
      ), maxActivity);
      updateLocationHints(record, event.result.metadata);
      record.currentState = `Tool ${event.result.toolName} ${event.result.status}.`;
      break;
    case 'read':
    case 'mutation':
    case 'command':
    case 'validation': {
      const metadata = event.metadata;
      updateLocationHints(record, metadata);
      const detail = safeProjectMemoryString(event.detail, textLimit);
      const candidatePath = activityPath(metadata);
      const activity: ProjectMemoryActivity = {
        callId: event.callId,
        toolName: event.toolName,
        status: event.status,
        timestamp: event.timestamp,
        detail,
        path: candidatePath,
        ...(event.type === 'mutation' || event.type === 'command'
          ? { mutationStatus: event.mutationStatus }
          : {})
      };
      const target = event.type === 'read'
        ? record.reads
        : event.type === 'mutation'
          ? record.mutations
          : event.type === 'command'
            ? record.commands
            : record.validations;
      boundedPush(target, activity, maxActivity);
      if (candidatePath) {
        boundedUniquePush(record.activeFiles, candidatePath, maxFiles);
        if (event.type === 'mutation' && event.mutationStatus === 'committed') {
          boundedUniquePush(record.changedFiles, candidatePath, maxFiles);
        }
      }
      record.currentState = `${event.type} ${event.status}${detail ? `: ${detail}` : ''}.`;
      break;
    }
    case 'error':
      boundedPush(record.errors, {
        code: redactProjectMemoryText(event.error.code, 300),
        kind: redactProjectMemoryText(event.error.kind, 100),
        message: redactProjectMemoryText(event.error.message, textLimit),
        timestamp: event.timestamp,
        callId: event.callId,
        toolName: event.toolName
      }, maxActivity);
      record.currentState = `Error: ${redactProjectMemoryText(event.error.message, textLimit)}.`;
      break;
    case 'cancelled':
      boundedPush(record.cancellations, {
        source: event.source,
        timestamp: event.timestamp,
        callId: event.callId,
        toolName: event.toolName
      }, maxActivity);
      setSessionStatus(record, 'cancelled');
      record.currentState = `Cancelled by ${event.source}.`;
      break;
    case 'turn.completed':
      record.turnCount = Math.max(record.turnCount, event.turn.index + 1);
      if (event.turn.finalText) record.completionSummary = redactProjectMemoryText(event.turn.finalText, textLimit);
      setSessionStatus(record, event.turn.status === 'paused'
        ? 'paused'
        : event.turn.status === 'failed'
          ? 'failed'
          : event.turn.status === 'cancelled'
            ? 'cancelled'
            : record.status);
      record.currentState = `Turn ${event.turn.index + 1} ${event.turn.status}.`;
      break;
    case 'session.completed':
      setSessionStatus(record, event.status);
      record.completedAt = event.timestamp;
      if (event.error) {
        boundedPush(record.errors, {
          code: redactProjectMemoryText(event.error.code, 300),
          kind: redactProjectMemoryText(event.error.kind, 100),
          message: redactProjectMemoryText(event.error.message, textLimit),
          timestamp: event.timestamp
        }, maxActivity);
      }
      record.currentState = `Session ${event.status}.`;
      break;
    case 'provider.started':
    case 'provider.progress':
    case 'provider.completed':
    case 'tool.progress':
      // Transient provider/progress payloads are filtered before persistence.
      break;
  }
}

export class ProjectMemoryLifecycleRecorder {
  readonly sink: AgentLifecycleSink;
  private readonly sessions = new Map<string, SessionBinding>();

  constructor(
    readonly store: ProjectMemoryStore,
    private readonly options: ProjectMemoryLifecycleRecorderOptions = {}
  ) {
    this.sink = (event) => this.observe(event);
  }

  observe(event: AgentLifecycleEvent): void {
    try {
      if (eventIsTransient(event)) return;
      if (event.type === 'session.started') {
        const roots = projectMemoryRootBindings(event.context);
        if (roots.length === 0) return;
        this.sessions.set(event.sessionId, {
          context: event.context,
          roots,
          callRootIds: new Map<string, string>()
        });
      }
      const binding = this.sessions.get(event.sessionId);
      if (!binding) return;
      for (const rootBinding of routeRoots(event, binding)) {
        this.store.update(rootBinding.scope, (document) => {
          let record = document.sessions.find((candidate) => candidate.sessionId === event.sessionId);
          record = upsertSession(record, binding.context, event.timestamp, event.type === 'session.started');
          if (!document.sessions.includes(record)) document.sessions.push(record);
          applyEvent(record, event, this.store);
        });
      }
      if (event.type === 'session.completed') this.sessions.delete(event.sessionId);
    } catch (error) {
      this.options.onError?.(error, event);
      if (!this.options.onError) throw error;
    }
  }
}

export function createProjectMemoryLifecycleSink(
  store: ProjectMemoryStore,
  options: ProjectMemoryLifecycleRecorderOptions = {}
): ProjectMemoryLifecycleRecorder {
  return new ProjectMemoryLifecycleRecorder(store, options);
}
