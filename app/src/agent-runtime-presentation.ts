import type {
  AgentAttachment,
  AgentDecisionRequest,
  AgentDecisionResolution,
  AgentLifecycleEvent,
  AgentProgress,
  MutationStatus,
  ToolCall,
  ToolEffect,
  ToolProgress,
  ToolResult
} from '../../src/agent-runtime/contracts.js';

export type RuntimeActivityKind =
  | 'runtime'
  | 'provider'
  | 'tool'
  | 'read'
  | 'mutation'
  | 'command'
  | 'validation'
  | 'permission'
  | 'decision'
  | 'attachment'
  | 'error'
  | 'cancelled'
  | 'paused'
  | 'completed';

export type RuntimeActivityState =
  | 'running'
  | 'progress'
  | 'waiting'
  | 'allowed'
  | 'denied'
  | 'success'
  | 'error'
  | 'cancelled'
  | 'paused'
  | 'completed'
  | 'info';

export interface RuntimeProgressView {
  readonly message?: string;
  readonly completed?: number;
  readonly total?: number;
  readonly percent?: number;
}

export interface RuntimeCallView {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly effect?: ToolEffect;
}

export interface RuntimeActivityItem {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: RuntimeActivityKind;
  readonly state: RuntimeActivityState;
  readonly title: string;
  readonly detail?: string;
  readonly call?: RuntimeCallView;
  readonly progress?: RuntimeProgressView;
  readonly provider?: {
    readonly connectionId?: string;
    readonly modelId?: string;
  };
  readonly permissions?: readonly string[];
  readonly decisionRequest?: AgentDecisionRequest;
  readonly decisionResolution?: AgentDecisionResolution;
  readonly attachments?: readonly AgentAttachment[];
  readonly mutationStatus?: MutationStatus;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function progressView(progress: AgentProgress | ToolProgress): RuntimeProgressView {
  const percent = progress.completed !== undefined && progress.total !== undefined && progress.total > 0
    ? Math.max(0, Math.min(100, Math.round((progress.completed / progress.total) * 100)))
    : undefined;
  return {
    message: progress.message,
    completed: progress.completed,
    total: progress.total,
    percent
  };
}

function statusState(status: ToolResult['status']): RuntimeActivityState {
  if (status === 'success') return 'success';
  if (status === 'cancelled') return 'cancelled';
  return 'error';
}

function turnState(status: 'running' | 'completed' | 'paused' | 'failed' | 'cancelled'): RuntimeActivityState {
  if (status === 'running') return 'running';
  if (status === 'paused') return 'paused';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'error';
  return 'completed';
}

function sessionKind(status: 'completed' | 'paused' | 'failed' | 'cancelled'): RuntimeActivityKind {
  if (status === 'paused') return 'paused';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'error';
  return 'completed';
}

function callView(call: ToolCall, effect?: ToolEffect): RuntimeCallView {
  return { id: call.id, name: call.name, arguments: call.arguments, effect };
}

function activityKind(effect?: ToolEffect): RuntimeActivityKind {
  if (effect === 'read') return 'read';
  if (effect === 'mutation') return 'mutation';
  if (effect === 'command') return 'command';
  if (effect === 'validation') return 'validation';
  return 'tool';
}

function base(event: AgentLifecycleEvent) {
  return {
    id: event.id,
    sequence: event.sequence,
    timestamp: event.timestamp
  } as const;
}

/**
 * UI-only projection of the frozen Unified Agent Runtime lifecycle. It keeps
 * provider/model identifiers as metadata and derives UX semantics exclusively
 * from canonical lifecycle event types and tool effects.
 */
export function presentAgentLifecycleEvent(event: AgentLifecycleEvent): RuntimeActivityItem | undefined {
  const common = base(event);

  switch (event.type) {
    case 'session.started':
      return {
        ...common,
        kind: 'runtime',
        state: 'running',
        title: 'Session started',
        detail: event.context.project?.id ? `Project ${event.context.project.id}` : undefined,
        provider: { connectionId: event.context.connection.id, modelId: event.context.modelId }
      };
    case 'turn.started':
      return {
        ...common,
        kind: 'runtime',
        state: 'running',
        title: 'Running',
        detail: `Turn ${event.turn.index + 1}`
      };
    case 'user.input': {
      const attachments = event.message.attachments ?? [];
      if (attachments.length === 0) return undefined;
      return {
        ...common,
        kind: 'attachment',
        state: 'info',
        title: attachments.length === 1 ? 'Attachment added' : `${attachments.length} attachments added`,
        attachments
      };
    }
    case 'provider.started':
      return {
        ...common,
        kind: 'provider',
        state: 'running',
        title: 'Provider running',
        provider: { connectionId: event.connectionId, modelId: event.modelId }
      };
    case 'provider.progress':
      return {
        ...common,
        kind: 'provider',
        state: 'progress',
        title: event.progress.message || event.progress.state || 'Provider progress',
        detail: event.progress.message ? event.progress.state : undefined,
        progress: progressView(event.progress),
        metadata: event.progress.metadata
      };
    case 'provider.completed':
      return {
        ...common,
        kind: 'provider',
        state: 'success',
        title: 'Provider completed',
        detail: `${event.stopReason}${event.toolCallCount ? ` · ${event.toolCallCount} tool call${event.toolCallCount === 1 ? '' : 's'}` : ''}`
      };
    case 'permission.requested':
      return {
        ...common,
        kind: 'permission',
        state: 'waiting',
        title: 'Approval required',
        detail: event.call.name,
        call: callView(event.call),
        permissions: event.permissions
      };
    case 'permission.resolved':
      return {
        ...common,
        kind: 'permission',
        state: event.allowed ? 'allowed' : 'denied',
        title: event.allowed ? 'Permission allowed' : 'Permission denied',
        detail: event.reason,
        call: { id: event.callId, name: '', arguments: {} }
      };
    case 'decision.requested':
      return {
        ...common,
        kind: 'decision',
        state: 'waiting',
        title: event.request.kind === 'confirmation' || event.request.kind === 'permission'
          ? 'Confirmation required'
          : 'Decision required',
        detail: event.call?.name,
        call: event.call ? callView(event.call) : undefined,
        decisionRequest: event.request,
        metadata: event.request.metadata
      };
    case 'decision.resolved':
      return {
        ...common,
        kind: 'decision',
        state: 'completed',
        title: 'Decision resolved',
        detail: event.resolution.text || event.resolution.optionId,
        decisionResolution: event.resolution,
        metadata: event.resolution.metadata
      };
    case 'tool.call':
      return {
        ...common,
        kind: activityKind(event.definition?.effect),
        state: 'running',
        title: event.definition?.effect === 'read' ? 'Reading'
          : event.definition?.effect === 'mutation' ? 'Mutation started'
          : event.definition?.effect === 'command' ? 'Command started'
          : event.definition?.effect === 'validation' ? 'Validation started'
          : 'Tool call',
        detail: event.call.name,
        call: callView(event.call, event.definition?.effect)
      };
    case 'tool.progress':
      return {
        ...common,
        kind: 'tool',
        state: 'progress',
        title: event.progress.message || 'Tool progress',
        detail: event.toolName,
        call: { id: event.callId, name: event.toolName, arguments: {} },
        progress: progressView(event.progress),
        metadata: event.progress.metadata
      };
    case 'tool.result':
      return {
        ...common,
        kind: 'tool',
        state: statusState(event.result.status),
        title: event.result.status === 'success' ? 'Tool completed'
          : event.result.status === 'cancelled' ? 'Tool cancelled'
          : 'Tool failed',
        detail: event.result.error?.message || event.result.toolName,
        call: { id: event.result.callId, name: event.result.toolName, arguments: {} },
        mutationStatus: event.result.mutationStatus,
        metadata: event.result.metadata
      };
    case 'read':
      return {
        ...common,
        kind: 'read',
        state: statusState(event.status),
        title: event.status === 'success' ? 'Read completed' : event.status === 'cancelled' ? 'Read cancelled' : 'Read failed',
        detail: event.detail || event.toolName,
        call: { id: event.callId, name: event.toolName, arguments: {} },
        metadata: event.metadata
      };
    case 'mutation':
      return {
        ...common,
        kind: 'mutation',
        state: statusState(event.status),
        title: event.status === 'success' ? 'Mutation completed' : event.status === 'cancelled' ? 'Mutation cancelled' : 'Mutation failed',
        detail: event.detail || event.toolName,
        call: { id: event.callId, name: event.toolName, arguments: {} },
        mutationStatus: event.mutationStatus,
        metadata: event.metadata
      };
    case 'command':
      return {
        ...common,
        kind: 'command',
        state: statusState(event.status),
        title: event.status === 'success' ? 'Command completed' : event.status === 'cancelled' ? 'Command cancelled' : 'Command failed',
        detail: event.detail || event.toolName,
        call: { id: event.callId, name: event.toolName, arguments: {} },
        mutationStatus: event.mutationStatus,
        metadata: event.metadata
      };
    case 'validation':
      return {
        ...common,
        kind: 'validation',
        state: statusState(event.status),
        title: event.status === 'success' ? 'Validation passed' : event.status === 'cancelled' ? 'Validation cancelled' : 'Validation failed',
        detail: event.detail || event.toolName,
        call: { id: event.callId, name: event.toolName, arguments: {} },
        metadata: event.metadata
      };
    case 'error':
      return {
        ...common,
        kind: 'error',
        state: 'error',
        title: event.error.code || 'Runtime error',
        detail: event.error.message,
        call: event.callId ? { id: event.callId, name: event.toolName ?? '', arguments: {} } : undefined,
        metadata: event.error.details
      };
    case 'cancelled':
      return {
        ...common,
        kind: 'cancelled',
        state: 'cancelled',
        title: 'Cancelled',
        detail: event.toolName ? `${event.source} · ${event.toolName}` : event.source,
        call: event.callId ? { id: event.callId, name: event.toolName ?? '', arguments: {} } : undefined
      };
    case 'turn.completed':
      return {
        ...common,
        kind: event.turn.status === 'paused' ? 'paused'
          : event.turn.status === 'cancelled' ? 'cancelled'
          : event.turn.status === 'failed' ? 'error'
          : event.turn.status === 'completed' ? 'completed'
          : 'runtime',
        state: turnState(event.turn.status),
        title: event.turn.status === 'paused' ? 'Paused'
          : event.turn.status === 'cancelled' ? 'Turn cancelled'
          : event.turn.status === 'failed' ? 'Turn failed'
          : event.turn.status === 'completed' ? 'Turn completed'
          : 'Running',
        detail: event.turn.decisionRequest?.prompt
      };
    case 'session.completed':
      return {
        ...common,
        kind: sessionKind(event.status),
        state: event.status === 'failed' ? 'error' : event.status,
        title: event.status === 'completed' ? 'Completed'
          : event.status === 'paused' ? 'Paused'
          : event.status === 'cancelled' ? 'Cancelled'
          : 'Session failed',
        detail: event.error?.message,
        metadata: event.error?.details
      };
  }
}

export function presentAgentLifecycle(events: readonly AgentLifecycleEvent[]): RuntimeActivityItem[] {
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map(presentAgentLifecycleEvent)
    .filter((item): item is RuntimeActivityItem => Boolean(item));
}

export function formatAttachmentSize(sizeBytes?: number): string | undefined {
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes) || sizeBytes < 0) return undefined;
  if (sizeBytes < 1024) return `${Math.round(sizeBytes)} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatRuntimeMetadata(value: unknown, maxLength = 280): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
