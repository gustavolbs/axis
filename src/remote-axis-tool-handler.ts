import { randomUUID } from 'node:crypto';

import {
  ToolRegistry,
  assertAgentSessionContext,
  type AgentSessionContext,
  type AxisTool,
  type ToolDefinition
} from './agent-runtime/index.js';
import { createFilesystemP12Tools } from './agent-tools/filesystem/index.js';
import {
  GIT_BRANCH_INFO_TOOL_NAME,
  GIT_COMMIT_METADATA_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_STATUS_TOOL_NAME,
  createGitTools
} from './agent-tools/git/index.js';
import {
  PROCESS_EXEC_TOOL_NAME,
  PROCESS_WHICH_TOOL_NAME,
  createProcessTools
} from './agent-tools/process/index.js';
import { throwIfCancelled } from './cancellation.js';
import type { LocalCoderConfig } from './config.js';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  assertProtocolVersion,
  type RemoteAxisToolLifecycleEvent,
  type RemoteAxisToolRequest,
  type RemoteAxisToolResponse
} from './remote-protocol.js';
import { withWorkerToolWorkspace } from './worker-workspace.js';

const REMOTE_GIT_READ_TOOLS = new Set([
  GIT_STATUS_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_BRANCH_INFO_TOOL_NAME,
  GIT_COMMIT_METADATA_TOOL_NAME
]);
const REMOTE_PROCESS_TOOLS = new Set([PROCESS_EXEC_TOOL_NAME, PROCESS_WHICH_TOOL_NAME]);
const REMOTE_FILESYSTEM_TOOLS = new Set([
  'read_file', 'list_directory', 'stat_file', 'search_files', 'search_text',
  'create_file', 'write_file', 'edit_file', 'patch_file'
]);

/** Tools whose durable effects can be transported back as bounded file content.
 * Background processes, worktree operations and Git index/ref mutations are
 * intentionally unavailable until their state has a lossless transport. */
export function createRemoteAxisToolRegistry(): ToolRegistry {
  const tools: AxisTool[] = [
    ...createFilesystemP12Tools().filter((tool) => REMOTE_FILESYSTEM_TOOLS.has(tool.definition.name)),
    ...createProcessTools().tools.filter((tool) => REMOTE_PROCESS_TOOLS.has(tool.definition.name)),
    ...createGitTools().tools.filter((tool) => REMOTE_GIT_READ_TOOLS.has(tool.definition.name))
  ];
  return new ToolRegistry(tools);
}

export function remoteAxisToolNames(): readonly string[] {
  return createRemoteAxisToolRegistry().list().map((tool) => tool.definition.name);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function assertDefinitionMatches(expected: ToolDefinition, received: ToolDefinition): void {
  if (JSON.stringify(stable(expected)) !== JSON.stringify(stable(received))) {
    throw new Error(`Remote tool definition mismatch for ${received.name}.`);
  }
}

function workerSession(session: AgentSessionContext, workspace: string): AgentSessionContext {
  if (session.executionTarget.kind !== 'worker' || session.executionTarget.mode !== 'workspace') {
    throw new Error('Remote AxisTool requests require an explicit workspace Worker execution target.');
  }
  if (session.roots.length !== 1) {
    throw new Error('Remote AxisTool transport currently requires exactly one authorized workspace root.');
  }
  const mapped: AgentSessionContext = {
    ...session,
    roots: [{ ...session.roots[0]!, path: workspace }]
  };
  assertAgentSessionContext(mapped);
  return mapped;
}

export async function executeRemoteAxisTool(
  input: RemoteAxisToolRequest,
  config: LocalCoderConfig,
  signal: AbortSignal,
  registry = createRemoteAxisToolRegistry()
): Promise<RemoteAxisToolResponse> {
  assertProtocolVersion(input.protocolVersion);
  if (!input.requestId?.trim() || !input.executionId?.trim() || !input.cancellationId?.trim()) {
    throw new Error('Remote AxisTool request identities must not be empty.');
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new Error('Remote AxisTool attempt must be a positive integer.');
  }
  const deadline = Date.parse(input.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) {
    throw new Error('Remote AxisTool deadline has expired or is invalid.');
  }
  assertAgentSessionContext(input.session);
  const tool = registry.get(input.call.name);
  if (!tool) {
    throw new Error(`AxisTool ${input.call.name} is not supported by this Worker.`);
  }
  if (input.call.name !== input.tool.name) throw new Error('Remote AxisTool call/definition name mismatch.');
  assertDefinitionMatches(tool.definition, input.tool);
  if (input.authorization.grantedByCanonicalRuntime !== true) {
    throw new Error('Remote AxisTool request lacks canonical runtime authorization.');
  }
  for (const permission of tool.definition.requiredPermissions) {
    if (!input.authorization.permissions.includes(permission)) {
      throw new Error(`Remote AxisTool authorization is missing permission ${permission}.`);
    }
  }
  for (const capability of tool.definition.requiredCapabilities) {
    if (!input.authorization.capabilities.includes(capability)) {
      throw new Error(`Remote AxisTool authorization is missing capability ${capability}.`);
    }
    if (!input.session.capabilities.entries[capability]?.available) {
      throw new Error(`Remote AxisTool session does not grant capability ${capability}.`);
    }
  }

  const lifecycle: RemoteAxisToolLifecycleEvent[] = [{ type: 'started', at: new Date().toISOString() }];
  const output = await withWorkerToolWorkspace(input.workspace, config, async (workspace) => {
    throwIfCancelled(signal);
    const session = workerSession(input.session, workspace);
    return await tool.execute({
      session,
      call: input.call,
      signal,
      reportProgress: (progress) => lifecycle.push({ type: 'progress', progress, at: new Date().toISOString() }),
      reportActivity: (activity) => lifecycle.push({ type: 'activity', activity, at: new Date().toISOString() })
    });
  });
  lifecycle.push({ type: 'completed', at: new Date().toISOString() });
  return {
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    requestId: input.requestId,
    executionId: input.executionId,
    state: output.changes.length > 0 ? 'completed-mutated' : 'completed-no-mutation',
    output: output.result,
    changes: output.changes,
    lifecycle
  };
}

export function newRemoteExecutionId(): string {
  return randomUUID();
}
