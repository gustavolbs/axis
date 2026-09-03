import type {
  AgentPermissionStatus,
  AgentSessionContext,
  ToolActivity,
  ToolCall,
  ToolDefinition,
  ToolProgress,
  MutationStatus,
  RetryEligibility
} from './contracts.js';

export interface ToolExecutionOutput {
  readonly output?: unknown;
  /** Mutating tools must state what is known after execution. Omitted means unknown. */
  readonly mutationStatus?: MutationStatus;
  readonly retry?: RetryEligibility;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolExecutionContext {
  readonly session: AgentSessionContext;
  readonly call: ToolCall;
  readonly signal: AbortSignal;
  readonly reportProgress: (progress: ToolProgress) => void;
  readonly reportActivity: (activity: ToolActivity) => void;
}

/**
 * The only interface a native Axis tool needs to implement.
 * Tool code receives Axis session/execution context and never provider protocol.
 */
export interface AxisTool {
  readonly definition: ToolDefinition;
  execute(context: ToolExecutionContext): Promise<ToolExecutionOutput>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AxisTool>();

  constructor(tools: readonly AxisTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AxisTool): void {
    const name = tool.definition.name.trim();
    if (!name) throw new Error('Tool name must not be empty.');
    if (this.tools.has(name)) throw new Error(`Tool ${name} is already registered.`);
    this.tools.set(name, tool);
  }

  get(name: string): AxisTool | undefined {
    return this.tools.get(name);
  }

  list(): AxisTool[] {
    return [...this.tools.values()].sort((left, right) =>
      left.definition.name.localeCompare(right.definition.name)
    );
  }
}

export interface ToolPermissionRequest {
  readonly session: AgentSessionContext;
  readonly tool: ToolDefinition;
  readonly call: ToolCall;
}

export interface ToolPermissionDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  /** True means an interactive gate may approve it later; static policy has not. */
  readonly requiresApproval?: boolean;
}

/** Replaceable boundary for Company/Project/session policy and future approval UI. */
export interface ToolPermissionGate {
  authorize(request: ToolPermissionRequest): Promise<ToolPermissionDecision>;
}

function permissionStatus(
  session: AgentSessionContext,
  permission: string
): AgentPermissionStatus {
  return session.permissions.entries[permission] ?? session.permissions.default;
}

export class StaticToolPermissionGate implements ToolPermissionGate {
  async authorize(request: ToolPermissionRequest): Promise<ToolPermissionDecision> {
    for (const permission of request.tool.requiredPermissions) {
      const status = permissionStatus(request.session, permission);
      if (status === 'denied') {
        return { allowed: false, reason: `Permission ${permission} is denied for this session.` };
      }
      if (status === 'ask') {
        return {
          allowed: false,
          requiresApproval: true,
          reason: `Permission ${permission} requires approval.`
        };
      }
    }
    return { allowed: true };
  }
}

/**
 * Where a canonical tool call runs. The desktop target invokes the local tool;
 * a future Local Worker target may serialize the same definition/call instead.
 */
export interface AgentExecutionTarget {
  readonly id: string;
  execute(tool: AxisTool, context: ToolExecutionContext): Promise<ToolExecutionOutput>;
}

export class LocalAgentExecutionTarget implements AgentExecutionTarget {
  constructor(readonly id = 'desktop') {}

  async execute(tool: AxisTool, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    return await tool.execute(context);
  }
}

export class ExecutionTargetRegistry {
  private readonly targets = new Map<string, AgentExecutionTarget>();

  constructor(targets: readonly AgentExecutionTarget[] = []) {
    for (const target of targets) this.register(target);
  }

  register(target: AgentExecutionTarget): void {
    const id = target.id.trim();
    if (!id) throw new Error('Execution target id must not be empty.');
    if (this.targets.has(id)) throw new Error(`Execution target ${id} is already registered.`);
    this.targets.set(id, target);
  }

  resolve(id: string): AgentExecutionTarget {
    const target = this.targets.get(id);
    if (!target) {
      throw new Error(
        `Execution target ${id} is not registered. Axis will not silently fall back to another target.`
      );
    }
    return target;
  }
}
