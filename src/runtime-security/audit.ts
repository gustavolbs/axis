import type {
  AgentLifecycleEvent,
  AgentLifecycleSink,
  AgentSessionContext,
  ToolPermissionRequest
} from '../agent-runtime/index.js';
import {
  RuntimePolicyEngine,
  type RuntimePolicyDecision,
  type RuntimePolicyStore,
  type RuntimeSessionPolicyOverride
} from './policy.js';
import { redactRuntimeText, redactRuntimeValue } from './redaction.js';

export type RuntimeSecurityAuditKind =
  | 'permission.requested'
  | 'permission.allowed'
  | 'permission.denied'
  | 'policy.decision'
  | 'decision.requested'
  | 'decision.resolved'
  | 'tool.mutation'
  | 'external.action'
  | 'runtime.error';

export interface RuntimeSecurityAuthoritySnapshot {
  readonly sessionId: string;
  readonly companyId: string;
  readonly projectId?: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly executionTargetId: string;
}

export interface RuntimeSecurityAuditEvent extends RuntimeSecurityAuthoritySnapshot {
  readonly timestamp: string;
  readonly kind: RuntimeSecurityAuditKind;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type RuntimeSecurityAuditSink = (event: RuntimeSecurityAuditEvent) => void;

export class InMemoryRuntimeSecurityAudit {
  readonly events: RuntimeSecurityAuditEvent[] = [];
  readonly sink: RuntimeSecurityAuditSink = (event) => { this.events.push(Object.freeze(event)); };
}

export function runtimeAuthoritySnapshot(session: AgentSessionContext): RuntimeSecurityAuthoritySnapshot {
  return Object.freeze({
    sessionId: session.sessionId,
    companyId: session.companyId,
    ...(session.project ? { projectId: session.project.id } : {}),
    connectionId: session.connection.id,
    modelId: session.modelId,
    executionTargetId: session.executionTarget.id
  });
}

function emit(
  sink: RuntimeSecurityAuditSink,
  session: AgentSessionContext,
  kind: RuntimeSecurityAuditKind,
  detail?: Readonly<Record<string, unknown>>,
  timestamp = new Date().toISOString()
): void {
  sink(Object.freeze({
    ...runtimeAuthoritySnapshot(session),
    timestamp,
    kind,
    ...(detail ? { detail: redactRuntimeValue(detail) as Readonly<Record<string, unknown>> } : {})
  }));
}

/** Policy-engine decorator that audits the exact decision used by the permission gate. */
export class AuditedRuntimePolicyEngine extends RuntimePolicyEngine {
  constructor(store: RuntimePolicyStore, private readonly auditSink: RuntimeSecurityAuditSink) {
    super(store);
  }

  override evaluate(request: ToolPermissionRequest, sessionOverride?: RuntimeSessionPolicyOverride): RuntimePolicyDecision {
    const decision = super.evaluate(request, sessionOverride);
    emit(this.auditSink, request.session, 'policy.decision', {
      toolName: request.tool.name,
      callId: request.call.id,
      effect: decision.effect,
      mode: decision.mode,
      domain: decision.subject.domain,
      descriptor: decision.subject.descriptor,
      destructive: decision.subject.destructive,
      external: decision.subject.external,
      matchedRuleIds: decision.matchedRuleIds,
      reason: decision.reason
    });
    return decision;
  }
}

/**
 * Redacts the complete lifecycle object before any UI/log/memory/audit consumer
 * receives it. This is the preferred boundary for product fan-out.
 */
export function redactAgentLifecycleEvent(event: AgentLifecycleEvent): AgentLifecycleEvent {
  return redactRuntimeValue(event) as AgentLifecycleEvent;
}

export function redactingLifecycleSink(sink: AgentLifecycleSink): AgentLifecycleSink {
  return (event) => sink(redactAgentLifecycleEvent(event));
}

/** Audits security-relevant lifecycle transitions without retaining raw tool arguments. */
export function createRuntimeSecurityLifecycleAuditSink(
  sink: RuntimeSecurityAuditSink
): AgentLifecycleSink {
  const sessions = new Map<string, AgentSessionContext>();
  const effects = new Map<string, 'read' | 'mutation' | 'command' | 'validation' | 'external'>();

  return (rawEvent) => {
    const event = redactAgentLifecycleEvent(rawEvent);
    if (event.type === 'session.started') sessions.set(event.sessionId, event.context);
    const session = sessions.get(event.sessionId);
    if (!session) return;

    switch (event.type) {
      case 'permission.requested':
        emit(sink, session, 'permission.requested', { callId: event.call.id, toolName: event.call.name, permissions: event.permissions }, event.timestamp);
        break;
      case 'permission.resolved':
        emit(sink, session, event.allowed ? 'permission.allowed' : 'permission.denied', { callId: event.callId, reason: event.reason }, event.timestamp);
        break;
      case 'decision.requested':
        emit(sink, session, 'decision.requested', { requestId: event.request.id, kind: event.request.kind, prompt: event.request.prompt }, event.timestamp);
        break;
      case 'decision.resolved':
        emit(sink, session, 'decision.resolved', { requestId: event.resolution.requestId, optionId: event.resolution.optionId, text: event.resolution.text }, event.timestamp);
        break;
      case 'tool.call':
        if (event.definition) effects.set(event.call.id, event.definition.effect);
        if (event.definition?.effect === 'mutation' || event.definition?.effect === 'command') {
          emit(sink, session, 'tool.mutation', { callId: event.call.id, toolName: event.call.name, phase: 'started' }, event.timestamp);
        } else if (event.definition?.effect === 'external') {
          emit(sink, session, 'external.action', { callId: event.call.id, toolName: event.call.name, phase: 'started' }, event.timestamp);
        }
        break;
      case 'tool.result': {
        const effect = effects.get(event.result.callId);
        if (effect === 'mutation' || effect === 'command') {
          emit(sink, session, 'tool.mutation', { callId: event.result.callId, toolName: event.result.toolName, phase: 'completed', status: event.result.status, mutationStatus: event.result.mutationStatus }, event.timestamp);
        } else if (effect === 'external') {
          emit(sink, session, 'external.action', { callId: event.result.callId, toolName: event.result.toolName, phase: 'completed', status: event.result.status }, event.timestamp);
        }
        effects.delete(event.result.callId);
        break;
      }
      case 'error':
        emit(sink, session, 'runtime.error', { code: event.error.code, message: redactRuntimeText(event.error.message), toolName: event.toolName, callId: event.callId }, event.timestamp);
        break;
      case 'session.completed':
        sessions.delete(event.sessionId);
        break;
      default:
        break;
    }
  };
}
