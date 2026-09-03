import { createHash } from 'node:crypto';

import {
  AgentRuntime,
  LocalAgentExecutionTarget,
  StaticToolPermissionGate,
  ToolRegistry,
  buildAgentSessionContext,
  negotiateEffectiveCapabilities,
  providerModelCapabilityOffer,
  type AgentDecisionRequest,
  type AgentDecisionResolution,
  type AgentLifecycleEvent,
  type AgentMessage,
  type AgentPermissionSet,
  type AgentProviderAdapter,
  type AgentResourceBinding,
  type AgentRoot,
  type AgentSessionContext,
  type AxisTool,
  type ToolPermissionDecision,
  type ToolPermissionGate,
  type ToolPermissionRequest
} from './agent-runtime/index.js';
import { createAgentProviderAdapterForConnection } from './agent-provider-adapters/index.js';
import { createFilesystemP12Tools } from './agent-tools/filesystem/index.js';
import { createGitTools } from './agent-tools/git/index.js';
import { createProcessTools } from './agent-tools/process/index.js';
import {
  FetchBrowserBackend,
  createBrowserToolset,
  type BrowserBackend
} from './agent-tools/browser/index.js';
import type { McpHost } from './agent-tools/mcp/index.js';
import { currentCancellationSignal } from './cancellation.js';
import { ClaudeAccountProfileStore } from './claude-account-profiles.js';
import type { CompanyContextSnapshot } from './company-context.js';
import type { LocalEngineerResult } from './local-engineer.js';
import {
  createProjectMemoryLifecycleSink,
  loadProjectMemoryContext,
  ProjectMemoryStore
} from './project-memory/index.js';
import type { ProjectEngineerInput } from './project-engineer-backend.js';
import { ProjectProviderRuntime } from './project-provider-runtime.js';
import {
  effectiveProjectConnectionPolicy,
  type ModelSelection,
  type ProjectDefinition
} from './project-store.js';
import {
  ProviderConnectionRuntime,
  type ProviderConnectionView
} from './provider-connections.js';
import type { InferenceProvider, ModelDefinition } from './providers/types.js';

export type AgentProductInteractionMode = 'chat' | 'cowork';

export interface AgentProductLifecycleSource {
  subscribeAgentLifecycle(listener: (event: AgentLifecycleEvent) => void): () => void;
  resolveAgentDecision(sessionId: string, resolution: AgentDecisionResolution): void;
}

export interface AgentProductRuntimeOptions {
  readonly companyContext: () => CompanyContextSnapshot;
  readonly projects: {
    getProject(id: string): ProjectDefinition;
  };
  readonly connections: ProviderConnectionRuntime;
  readonly providers: ProjectProviderRuntime;
  readonly claudeProfiles?: ClaudeAccountProfileStore;
  readonly memoryStore?: ProjectMemoryStore;
  readonly browserBackend?: BrowserBackend | false;
  readonly mcpHost?: McpHost;
  readonly executionTargetId?: string;
}

interface ExactSelection {
  readonly connectionId: string;
  readonly modelId: string;
}

interface ResolvedTransport {
  readonly connection: ProviderConnectionView;
  readonly provider: InferenceProvider;
  readonly model: ModelDefinition;
  readonly adapter: AgentProviderAdapter;
}

interface PendingSession {
  readonly context: AgentSessionContext;
  readonly provider: AgentProviderAdapter;
  readonly runtime: AgentRuntime;
  readonly permissionGate: ProductPermissionGate;
  readonly systemPrompt: string;
  transcript: readonly AgentMessage[];
  turnIndex: number;
  request: AgentDecisionRequest;
  resolution?: AgentDecisionResolution;
}

interface PendingPermission {
  readonly requestId: string;
  readonly toolName: string;
  readonly argumentFingerprint: string;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function argumentFingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(stableValue(value)).digest('hex');
}

class ProductPermissionGate implements ToolPermissionGate {
  private readonly base = new StaticToolPermissionGate();
  private pending?: PendingPermission;
  private resolution?: AgentDecisionResolution;
  private consumed = false;

  setPending(request: AgentDecisionRequest): void {
    const metadata = request.metadata;
    const toolName = typeof metadata?.toolName === 'string' ? metadata.toolName : undefined;
    const fingerprint = typeof metadata?.argumentFingerprint === 'string'
      ? metadata.argumentFingerprint
      : undefined;
    if (!toolName || !fingerprint) return;
    this.pending = { requestId: request.id, toolName, argumentFingerprint: fingerprint };
    this.resolution = undefined;
    this.consumed = false;
  }

  resolve(resolution: AgentDecisionResolution): void {
    if (!this.pending || resolution.requestId !== this.pending.requestId) return;
    this.resolution = resolution;
    this.consumed = false;
  }

  async authorize(request: ToolPermissionRequest): Promise<ToolPermissionDecision> {
    if (
      this.pending && this.resolution && !this.consumed &&
      request.tool.name === this.pending.toolName &&
      argumentFingerprint(request.call.arguments) === this.pending.argumentFingerprint
    ) {
      this.consumed = true;
      const approved = this.resolution.optionId === 'approve' ||
        this.resolution.text?.trim().toLocaleLowerCase() === 'approve';
      return approved
        ? { allowed: true, reason: `Approved by decision ${this.resolution.requestId}.` }
        : { allowed: false, reason: `Denied by decision ${this.resolution.requestId}.` };
    }
    return await this.base.authorize(request);
  }
}

function toolIsAvailableForRoots(tool: AxisTool, roots: readonly AgentRoot[]): boolean {
  if (roots.length > 0) return true;
  const capabilities = tool.definition.requiredCapabilities;
  return !capabilities.some((capability) =>
    capability.startsWith('filesystem.') || capability.startsWith('process.') || capability.startsWith('git.')
  );
}

function permissionStatusForTool(mode: AgentProductInteractionMode, tool: AxisTool): 'granted' | 'ask' {
  if (mode === 'chat') {
    return tool.definition.effect === 'read' || tool.definition.effect === 'validation'
      ? 'granted'
      : 'ask';
  }
  if (tool.definition.name.startsWith('browser.') || tool.definition.name.startsWith('mcp.')) {
    return tool.definition.effect === 'read' ? 'granted' : 'ask';
  }
  return 'granted';
}

function permissionsFor(mode: AgentProductInteractionMode, tools: readonly AxisTool[]): AgentPermissionSet {
  const entries: Record<string, 'granted' | 'ask'> = Object.create(null) as Record<string, 'granted' | 'ask'>;
  for (const tool of tools) {
    const status = permissionStatusForTool(mode, tool);
    for (const permission of tool.definition.requiredPermissions) {
      const current = entries[permission];
      if (current !== 'ask') entries[permission] = status;
    }
  }
  return Object.freeze({ default: 'denied', entries: Object.freeze(entries) });
}

function filterDeniedTools(tools: readonly AxisTool[], permissions: AgentPermissionSet): AxisTool[] {
  return tools.filter((tool) => tool.definition.requiredPermissions.every((permission) =>
    (permissions.entries[permission] ?? permissions.default) !== 'denied'
  ));
}

function rootsFor(
  companyId: string,
  project: ProjectDefinition | undefined,
  workspace: string,
  mode: AgentProductInteractionMode
): AgentRoot[] {
  const rootPath = project?.workspace.trim() || workspace.trim();
  if (!rootPath) return [];
  return [{
    id: project ? `project:${project.id}` : 'workspace:personal',
    path: rootPath,
    access: mode === 'cowork' ? 'write' : 'read',
    companyId,
    projectId: project?.id
  }];
}

function resourcesFor(companyId: string, project: ProjectDefinition | undefined, browser: boolean): AgentResourceBinding[] {
  const scope = project ? 'project' as const : 'personal' as const;
  const resources: AgentResourceBinding[] = [];
  if (project) {
    resources.push({
      kind: 'memory',
      id: 'project-memory',
      scope,
      companyId,
      projectId: project.id
    });
  }
  if (browser) {
    resources.push({
      kind: 'browser',
      id: 'fetch',
      scope,
      companyId,
      projectId: project?.id
    });
  }
  return resources;
}

function browserTools(backend: BrowserBackend | false | undefined): readonly AxisTool[] {
  if (backend === false) return [];
  const toolset = createBrowserToolset({ backend: backend ?? new FetchBrowserBackend() });
  if ((backend ?? undefined) && (backend as BrowserBackend).id !== 'fetch') return toolset.tools;
  return toolset.tools.filter((tool) => [
    'browser.navigate',
    'browser.read',
    'browser.state',
    'browser.inspect'
  ].includes(tool.definition.name));
}

function baseTools(roots: readonly AgentRoot[], backend: BrowserBackend | false | undefined): AxisTool[] {
  const filesystem = createFilesystemP12Tools();
  const process = createProcessTools().tools;
  const git = createGitTools().tools;
  return [...filesystem, ...process, ...git, ...browserTools(backend)]
    .filter((tool) => toolIsAvailableForRoots(tool, roots));
}

function exactSelection(selection: ModelSelection | undefined, project: ProjectDefinition | undefined): ExactSelection | undefined {
  const candidate = selection ?? project?.defaultModel;
  if (!candidate || candidate.mode === 'auto') return undefined;
  if (candidate.mode === 'local-first') return { connectionId: 'ollama', modelId: candidate.modelId };
  return { connectionId: candidate.providerId, modelId: candidate.modelId };
}

function assertProjectConnection(project: ProjectDefinition, mode: AgentProductInteractionMode, connection: ProviderConnectionView): void {
  const policy = effectiveProjectConnectionPolicy(project);
  const allowed = mode === 'chat'
    ? policy.chat.allowedConnectionIds
    : policy.inference.allowedConnectionIds;
  if (!allowed.includes(connection.id)) {
    throw new Error(`Connection ${connection.id} is not allowed for ${mode} in Project ${project.id}.`);
  }
  if (!project.privacy.allowedProviderIds.includes(connection.providerFamily)) {
    throw new Error(`Provider family ${connection.providerFamily} is not allowed by Project ${project.id}.`);
  }
  if (connection.providerFamily !== 'ollama' && !project.privacy.cloudAllowed) {
    throw new Error(`Project ${project.id} does not allow cloud provider ${connection.providerFamily}.`);
  }
}

function runtimeSystemPrompt(
  input: ProjectEngineerInput,
  context: AgentSessionContext,
  project: ProjectDefinition | undefined,
  memoryCapsule: string | undefined
): string {
  const authority = [
    '# AXIS SESSION AUTHORITY',
    `Company: ${context.companyId}`,
    `Project: ${context.project?.id ?? '(none)'}`,
    `Connection: ${context.connection.id}`,
    `Provider family: ${context.connection.providerFamily}`,
    `Auth kind: ${context.connection.authKind}`,
    `Model: ${context.modelId}`,
    `Execution target: ${context.executionTarget.id}`,
    `Roots: ${context.roots.map((root) => `${root.id}:${root.access}:${root.path}`).join(', ') || '(none)'}`,
    'Use only the Axis tools advertised for this session. Explore dynamically: search/read before editing, inspect failures, repair, validate, and inspect Git diff when repository work is requested.',
    'Never claim a mutation, command, validation, or read that is not visible in the Axis lifecycle.',
    'Do not emit raw chain-of-thought; concise reasoning summaries are allowed.'
  ].join('\n');
  return [
    authority,
    project?.instructions?.trim() ? `# PROJECT INSTRUCTIONS\n${project.instructions.trim()}` : undefined,
    input.context?.trim() ? `# USER CONTEXT\n${input.context.trim()}` : undefined,
    input.constraints?.length ? `# CONSTRAINTS\n${input.constraints.map((item) => `- ${item}`).join('\n')}` : undefined,
    memoryCapsule
  ].filter((section): section is string => Boolean(section)).join('\n\n');
}

function transcriptFromChatHistory(input: ProjectEngineerInput): AgentMessage[] {
  return (input.chatHistory ?? []).map((turn, index) => ({
    id: `history-${index}`,
    role: turn.role,
    content: turn.content
  }));
}

function changedFiles(events: readonly AgentLifecycleEvent[]): string[] {
  const files = new Set<string>();
  for (const event of events) {
    if (event.type !== 'mutation' || event.status !== 'success' || event.mutationStatus !== 'committed') continue;
    const value = event.metadata?.relativePath ?? event.metadata?.path;
    if (typeof value === 'string' && value.trim()) files.add(value.trim());
  }
  return [...files];
}

function diffFromResult(toolResults: readonly { toolName: string; status: string; output?: unknown }[]): string {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index];
    if (!result || result.status !== 'success' || !result.toolName.includes('diff')) continue;
    if (typeof result.output === 'string') return result.output;
    if (result.output && typeof result.output === 'object') {
      const record = result.output as Record<string, unknown>;
      if (typeof record.diff === 'string') return record.diff;
      if (typeof record.stdout === 'string') return record.stdout;
    }
  }
  return '';
}

function engineerResult(
  input: ProjectEngineerInput,
  status: 'success' | 'needs-guidance',
  summary: string,
  events: readonly AgentLifecycleEvent[],
  toolResults: readonly { toolName: string; status: string; output?: unknown }[]
): LocalEngineerResult {
  return {
    status,
    phase: status === 'success' ? 'complete' : 'execution',
    workspace: input.workspace,
    goal: input.goal,
    summary,
    investigation: {
      searchQueries: [],
      evidenceFiles: events
        .filter((event) => event.type === 'read')
        .map((event) => event.metadata?.relativePath ?? event.metadata?.path)
        .filter((value): value is string => typeof value === 'string'),
      researchRequests: []
    },
    repairRounds: 0,
    changedFiles: changedFiles(events),
    diff: diffFromResult(toolResults),
    validation: [],
    modelCalls: []
  };
}

/**
 * Sequential product-composition layer. Chat and Cowork enter the same
 * AgentRuntime; their authority differs only through immutable roots,
 * capabilities, resources and permissions.
 */
export class AgentProductRuntime implements AgentProductLifecycleSource {
  private readonly listeners = new Set<(event: AgentLifecycleEvent) => void>();
  private readonly pending = new Map<string, PendingSession>();
  private readonly memoryStore: ProjectMemoryStore;
  private readonly memoryRecorder: ReturnType<typeof createProjectMemoryLifecycleSink>;
  private readonly claudeProfiles: ClaudeAccountProfileStore;
  private readonly executionTargetId: string;

  constructor(private readonly options: AgentProductRuntimeOptions) {
    this.memoryStore = options.memoryStore ?? new ProjectMemoryStore();
    this.memoryRecorder = createProjectMemoryLifecycleSink(this.memoryStore, {
      onError: (error) => console.error(`Project Memory lifecycle persistence failed: ${error instanceof Error ? error.message : String(error)}`)
    });
    this.claudeProfiles = options.claudeProfiles ?? new ClaudeAccountProfileStore();
    this.executionTargetId = options.executionTargetId?.trim() || 'desktop';
  }

  subscribeAgentLifecycle(listener: (event: AgentLifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resolveAgentDecision(sessionId: string, resolution: AgentDecisionResolution): void {
    const pending = this.pending.get(sessionId);
    if (!pending) throw new Error(`Agent session ${sessionId} is not waiting for a decision.`);
    if (pending.request.id !== resolution.requestId) {
      throw new Error(`Decision ${resolution.requestId} does not match pending request ${pending.request.id}.`);
    }
    pending.resolution = resolution;
    pending.permissionGate.resolve(resolution);
  }

  private emit(event: AgentLifecycleEvent): void {
    this.memoryRecorder.observe(event);
    for (const listener of this.listeners) listener(event);
  }

  private async resolveSelection(
    project: ProjectDefinition | undefined,
    selection: ModelSelection | undefined
  ): Promise<ExactSelection> {
    const exact = exactSelection(selection, project);
    if (exact) return exact;
    if (!project) {
      throw new Error('Personal AgentRuntime execution requires an exact selected connection and model.');
    }
    const resolved = await this.options.providers.projectChatSelection(project);
    if (resolved.mode !== 'explicit') {
      throw new Error(`Project ${project.id} did not resolve an exact default connection/model.`);
    }
    return { connectionId: resolved.providerId, modelId: resolved.modelId };
  }

  private async resolveTransport(
    companyId: string,
    project: ProjectDefinition | undefined,
    selection: ExactSelection
  ): Promise<ResolvedTransport> {
    const connection = this.options.connections.view(selection.connectionId);
    if (!connection) throw new Error(`Unknown provider connection: ${selection.connectionId}`);
    if (project) assertProjectConnection(project, 'cowork', connection);
    const resolved = await this.options.connections.resolveSelected(selection.connectionId, selection.modelId);
    const adapter = createAgentProviderAdapterForConnection({
      connection,
      modelId: selection.modelId,
      companyId: connection.auth === 'local' ? null : companyId,
      provider: resolved.provider,
      claudeProfiles: this.claudeProfiles
    });
    return { connection, provider: resolved.provider, model: resolved.model, adapter };
  }

  private async compose(input: ProjectEngineerInput, sessionId: string): Promise<PendingSession> {
    const mode = input.interactionMode ?? 'cowork';
    const companyId = input.companyId?.trim();
    if (!companyId) throw new Error('AgentRuntime product execution requires canonical companyId.');
    const project = input.projectId ? this.options.projects.getProject(input.projectId) : undefined;
    const snapshot = this.options.companyContext();
    const selection = await this.resolveSelection(project, input.modelSelection);
    const connection = this.options.connections.view(selection.connectionId);
    if (!connection) throw new Error(`Unknown provider connection: ${selection.connectionId}`);
    if (project) assertProjectConnection(project, mode, connection);

    const roots = rootsFor(companyId, project, input.workspace, mode);
    const resources = resourcesFor(companyId, project, this.options.browserBackend !== false);

    // Validate canonical Company/Project/Connection/root ownership before any
    // credential secret is resolved or provider transport is invoked.
    buildAgentSessionContext({
      companyContext: snapshot,
      sessionId,
      companyId,
      project: project ? { id: project.id } : undefined,
      connection,
      modelId: selection.modelId,
      executionTarget: { id: this.executionTargetId, kind: 'desktop', mode: roots.length ? 'workspace' : 'inference-only' },
      roots,
      permissions: { default: 'denied', entries: {} },
      capabilities: { entries: {} },
      resources
    });

    const resolved = await this.options.connections.resolveSelected(selection.connectionId, selection.modelId);
    const provider = createAgentProviderAdapterForConnection({
      connection,
      modelId: selection.modelId,
      companyId: connection.auth === 'local' ? null : companyId,
      provider: resolved.provider,
      claudeProfiles: this.claudeProfiles
    });

    let tools = baseTools(roots, this.options.browserBackend);
    const preliminaryPermissions = permissionsFor(mode, tools);
    tools = filterDeniedTools(tools, preliminaryPermissions);

    const toolCapabilities = [...new Set(tools.flatMap((tool) => tool.definition.requiredCapabilities))];
    const capabilities = negotiateEffectiveCapabilities({
      offers: [
        providerModelCapabilityOffer(`connection:${connection.id}/model:${selection.modelId}`, resolved.provider.capabilities, resolved.model),
        { source: `execution-target:${this.executionTargetId}`, ids: toolCapabilities }
      ]
    });
    const permissions = permissionsFor(mode, tools);
    let context = buildAgentSessionContext({
      companyContext: snapshot,
      sessionId,
      companyId,
      project: project ? { id: project.id } : undefined,
      connection,
      modelId: selection.modelId,
      executionTarget: { id: this.executionTargetId, kind: 'desktop', mode: roots.length ? 'workspace' : 'inference-only' },
      roots,
      permissions,
      capabilities,
      resources
    });

    if (this.options.mcpHost) {
      const mcpTools = await this.options.mcpHost.toolsForSession(context, currentCancellationSignal());
      if (mcpTools.length > 0) {
        tools = [...tools, ...mcpTools];
        const mergedPermissions = permissionsFor(mode, tools);
        const mergedCapabilities = negotiateEffectiveCapabilities({
          offers: [
            providerModelCapabilityOffer(`connection:${connection.id}/model:${selection.modelId}`, resolved.provider.capabilities, resolved.model),
            { source: `execution-target:${this.executionTargetId}`, ids: [...new Set(tools.flatMap((tool) => tool.definition.requiredCapabilities))] }
          ]
        });
        context = buildAgentSessionContext({
          companyContext: snapshot,
          sessionId,
          companyId,
          project: project ? { id: project.id } : undefined,
          connection,
          modelId: selection.modelId,
          executionTarget: { id: this.executionTargetId, kind: 'desktop', mode: roots.length ? 'workspace' : 'inference-only' },
          roots,
          permissions: mergedPermissions,
          capabilities: mergedCapabilities,
          resources
        });
      }
    }

    const memory = await loadProjectMemoryContext({
      store: this.memoryStore,
      session: context,
      task: input.goal
    });
    const systemPrompt = runtimeSystemPrompt(input, context, project, memory?.capsule);
    const permissionGate = new ProductPermissionGate();
    const runtime = new AgentRuntime({
      tools: new ToolRegistry(tools),
      executionTargets: [new LocalAgentExecutionTarget(this.executionTargetId)],
      permissionGate,
      lifecycle: (event) => {
        if (event.type === 'decision.requested' && event.request.kind === 'permission' && event.call) {
          const augmented: AgentLifecycleEvent = {
            ...event,
            request: {
              ...event.request,
              metadata: {
                ...(event.request.metadata ?? {}),
                argumentFingerprint: argumentFingerprint(event.call.arguments)
              }
            }
          };
          permissionGate.setPending(augmented.request);
          this.emit(augmented);
          return;
        }
        this.emit(event);
      }
    });
    return {
      context,
      provider,
      runtime,
      permissionGate,
      systemPrompt,
      transcript: transcriptFromChatHistory(input),
      turnIndex: input.chatHistory?.filter((turn) => turn.role === 'user').length ?? 0,
      request: { id: '', kind: 'confirmation', prompt: '' }
    };
  }

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    const sessionId = input.budgetJobId?.trim();
    if (!sessionId) throw new Error('AgentRuntime product execution requires budgetJobId/sessionId.');
    let session = this.pending.get(sessionId);
    if (!session) session = await this.compose(input, sessionId);

    const events: AgentLifecycleEvent[] = [];
    const capture = (event: AgentLifecycleEvent) => {
      if (event.sessionId === sessionId) events.push(event);
    };
    const unsubscribe = this.subscribeAgentLifecycle(capture);
    try {
      const resolution = session.resolution;
      const result = await session.runtime.run({
        context: session.context,
        provider: session.provider,
        userInput: resolution
          ? `Resume after decision ${resolution.requestId}. Apply the resolution exactly once.`
          : input.goal,
        decisionResolution: resolution,
        systemPrompt: session.systemPrompt,
        transcript: session.transcript,
        turnIndex: session.turnIndex,
        requireToolUse: (input.interactionMode ?? 'cowork') === 'cowork',
        signal: currentCancellationSignal()
      });
      if (result.status === 'paused' && result.decisionRequest) {
        session.transcript = result.messages;
        session.turnIndex += 1;
        session.request = result.decisionRequest;
        session.resolution = undefined;
        session.permissionGate.setPending(result.decisionRequest);
        this.pending.set(sessionId, session);
        return engineerResult(input, 'needs-guidance', result.finalText ?? result.decisionRequest.prompt, events, result.toolResults);
      }
      this.pending.delete(sessionId);
      if (result.status === 'cancelled') {
        throw new Error(result.error?.message ?? 'AgentRuntime session cancelled.');
      }
      if (result.status === 'failed') {
        throw new Error(result.error?.message ?? 'AgentRuntime session failed.');
      }
      return engineerResult(input, 'success', result.finalText?.trim() || 'Completed.', events, result.toolResults);
    } finally {
      unsubscribe();
    }
  }
}
