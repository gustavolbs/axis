import type {
  AgentDecisionRequest,
  AgentDecisionResolution,
  AgentLifecycleEvent
} from './agent-runtime/index.js';
import {
  AgentProductRuntime,
  type AgentProductLifecycleSource
} from './agent-product-runtime.js';
import type { EngineeringProgress } from './engineering-progress.js';
import type { LocalEngineerResult } from './local-engineer.js';
import type {
  PremiumDecisionRequest,
  PremiumEngineerResult
} from './premium-agent.js';
import type { ProjectEngineerInput } from './project-engineer-backend.js';
import { reportProgress } from './progress-context.js';

const MAX_UI_LIFECYCLE_EVENTS = 240;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolutionFromGuidance(
  request: AgentDecisionRequest,
  guidance: string | undefined
): AgentDecisionResolution | undefined {
  if (!guidance?.trim()) return undefined;
  const match = new RegExp(
    `^-\\s+${escapeRegExp(request.id)}:\\s+(.+)$`,
    'm'
  ).exec(guidance);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  const knownOption = request.options?.some((option) => option.id === value) ?? false;
  return knownOption
    ? { requestId: request.id, optionId: value }
    : { requestId: request.id, text: value };
}

function legacyDecision(request: AgentDecisionRequest): PremiumDecisionRequest {
  const options = request.options?.length
    ? request.options
    : [
        {
          id: 'continue',
          label: 'Continue',
          description: 'Continue with the requested action.'
        },
        {
          id: 'deny',
          label: 'Deny',
          description: 'Do not perform the requested action.'
        }
      ];
  return {
    message: request.prompt,
    questions: [{
      id: request.id,
      question: request.prompt,
      rationale: request.kind === 'permission'
        ? 'Axis paused before executing the tool because this session requires approval.'
        : 'Axis paused the canonical agent turn until this decision is resolved.',
      options: options.map((option) => ({
        id: option.id,
        label: option.label,
        tradeoff: option.description ?? (
          option.id === 'approve'
            ? 'Executes the pending action exactly once.'
            : option.id === 'deny'
              ? 'The pending action is not executed.'
              : 'Resume using this decision.'
        )
      })),
      recommendedOptionId: request.kind === 'permission'
        ? undefined
        : options[0]?.id,
      blocking: true
    }]
  };
}

function progressFor(
  event: AgentLifecycleEvent
): Partial<EngineeringProgress> | undefined {
  switch (event.type) {
    case 'provider.started':
      return {
        action: 'Provider running',
        detail: `${event.connectionId} · ${event.modelId}`,
        activityKind: 'connecting',
        providerId: event.connectionId,
        model: event.modelId
      };
    case 'provider.progress':
      return {
        action: event.progress.message || 'Provider progress',
        detail: event.progress.state,
        activityKind: event.progress.state === 'reasoning' ? 'thinking' : 'working'
      };
    case 'tool.call':
      return {
        action: event.definition?.effect === 'read'
          ? 'Reading'
          : event.definition?.effect === 'mutation'
            ? 'Editing'
            : event.definition?.effect === 'command'
              ? 'Running command'
              : event.definition?.effect === 'validation'
                ? 'Validating'
                : 'Using tool',
        detail: event.call.name,
        activityKind: event.definition?.effect === 'read'
          ? 'reading'
          : event.definition?.effect === 'validation'
            ? 'validating'
            : 'tool'
      };
    case 'tool.progress':
      return {
        action: event.progress.message || 'Tool progress',
        detail: event.toolName,
        activityKind: 'tool'
      };
    case 'read':
      return {
        action: event.status === 'success' ? 'Read completed' : 'Read failed',
        detail: event.detail || event.toolName,
        activityKind: 'reading'
      };
    case 'mutation':
      return {
        action: event.status === 'success' ? 'Mutation completed' : 'Mutation failed',
        detail: event.detail || event.toolName,
        activityKind: 'tool'
      };
    case 'command':
      return {
        action: event.status === 'success' ? 'Command completed' : 'Command failed',
        detail: event.detail || event.toolName,
        activityKind: 'tool'
      };
    case 'validation':
      return {
        action: event.status === 'success' ? 'Validation passed' : 'Validation failed',
        detail: event.detail || event.toolName,
        activityKind: 'validating'
      };
    case 'permission.requested':
      return {
        action: 'Approval required',
        detail: event.call.name,
        activityKind: 'tool'
      };
    case 'decision.requested':
      return {
        action: 'Decision required',
        detail: event.request.prompt,
        activityKind: 'working'
      };
    case 'cancelled':
      return {
        action: 'Cancelled',
        detail: event.source,
        activityKind: 'working'
      };
    case 'error':
      return {
        action: 'Runtime error',
        detail: event.error.message,
        activityKind: 'working'
      };
    case 'session.completed':
      return {
        action: event.status === 'completed'
          ? 'Completed'
          : event.status === 'paused'
            ? 'Paused'
            : `Session ${event.status}`,
        activityKind: 'working'
      };
    default:
      return undefined;
  }
}

/**
 * Compatibility shell for persisted conversation state. Every provider/tool
 * cycle remains inside AgentRuntime; this bridge only projects canonical
 * lifecycle/decisions into the existing product API while migration completes.
 */
export class AgentProductExecutionBridge implements AgentProductLifecycleSource {
  private readonly pending = new Map<string, AgentDecisionRequest>();
  private readonly events = new Map<string, AgentLifecycleEvent[]>();

  constructor(readonly runtime: AgentProductRuntime) {
    this.runtime.subscribeAgentLifecycle((event) => {
      const history = [...(this.events.get(event.sessionId) ?? []), event]
        .slice(-MAX_UI_LIFECYCLE_EVENTS);
      this.events.set(event.sessionId, history);

      if (event.type === 'decision.requested') {
        this.pending.set(event.sessionId, event.request);
      }
      if (
        event.type === 'decision.resolved' ||
        (event.type === 'session.completed' && event.status !== 'paused')
      ) {
        this.pending.delete(event.sessionId);
      }

      const progress = progressFor(event);
      if (progress) reportProgress(progress);
    });
  }

  lifecycleEvents(sessionId: string): readonly AgentLifecycleEvent[] {
    return Object.freeze([...(this.events.get(sessionId) ?? [])]);
  }

  clearSession(sessionId: string): void {
    this.pending.delete(sessionId);
    this.events.delete(sessionId);
  }

  subscribeAgentLifecycle(
    listener: (event: AgentLifecycleEvent) => void
  ): () => void {
    return this.runtime.subscribeAgentLifecycle(listener);
  }

  resolveAgentDecision(
    sessionId: string,
    resolution: AgentDecisionResolution
  ): void {
    this.runtime.resolveAgentDecision(sessionId, resolution);
  }

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    const sessionId = input.budgetJobId?.trim();
    if (!sessionId) {
      throw new Error('AgentRuntime product execution requires budgetJobId/sessionId.');
    }

    const pending = this.pending.get(sessionId);
    if (pending) {
      const resolution = resolutionFromGuidance(pending, input.userGuidance);
      if (resolution) this.runtime.resolveAgentDecision(sessionId, resolution);
    }

    const result = await this.runtime.executeEngineer(input);
    const decision = this.pending.get(sessionId);
    if (result.status === 'needs-guidance' && decision) {
      return {
        ...result,
        decisionRequest: legacyDecision(decision)
      } as PremiumEngineerResult;
    }
    return result;
  }
}
