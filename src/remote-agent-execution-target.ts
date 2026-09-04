import { randomUUID } from 'node:crypto';

import type {
  AgentExecutionTarget,
  AxisTool,
  ToolExecutionContext,
  ToolExecutionOutput
} from './agent-runtime/index.js';
import { RemoteWorkerClient } from './remote-worker-client.js';

export class RemoteWorkerAgentExecutionTarget implements AgentExecutionTarget {
  private readonly supported: ReadonlySet<string>;

  constructor(
    readonly id: string,
    private readonly client: RemoteWorkerClient,
    supportedToolNames: readonly string[]
  ) {
    if (!id.trim()) throw new Error('Remote Worker execution target id must not be empty.');
    this.supported = new Set(supportedToolNames);
  }

  supports(toolName: string): boolean {
    return this.supported.has(toolName);
  }

  async execute(tool: AxisTool, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    if (!this.supports(tool.definition.name)) {
      throw new Error(`AxisTool ${tool.definition.name} is not supported by execution target ${this.id}.`);
    }
    if (context.session.executionTarget.id !== this.id || context.session.executionTarget.kind !== 'worker') {
      throw new Error('Remote Worker target/session identity mismatch.');
    }
    if (context.session.roots.length !== 1) {
      throw new Error('Remote Worker tool execution requires exactly one authorized workspace root.');
    }
    const executionId = randomUUID();
    const timeoutMs = tool.definition.timeoutMs ?? 120_000;
    const response = await this.client.executeAxisTool(context.session.roots[0]!.path, {
      requestId: context.call.id,
      executionId,
      cancellationId: executionId,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
      attempt: 1,
      session: context.session,
      tool: tool.definition,
      call: context.call,
      authorization: {
        grantedByCanonicalRuntime: true,
        permissions: tool.definition.requiredPermissions,
        capabilities: tool.definition.requiredCapabilities
      }
    });
    for (const event of response.lifecycle) {
      if (event.type === 'progress') context.reportProgress(event.progress);
      if (event.type === 'activity') context.reportActivity(event.activity);
    }
    return response.output;
  }
}
