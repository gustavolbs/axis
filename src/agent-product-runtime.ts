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
import {
  PERSONAL_COMPANY_ID,
  type CompanyContextSnapshot
} from './company-context.js';
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
  readonly projects: { getProject(id: string): ProjectDefinition };
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

interface PendingPermission {
  readonly requestId: string;
  readonly toolName: string;
  readonly argumentFingerprint: string;
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

  remember(
    request: AgentDecisionRequest,
    call?: { name: string; arguments: Readonly<Record<string, unknown>> }
  ): void {
    if (!call) return;
    this.pending = {
      requestId: request.id,
      toolName: call.name,
      argumentFingerprint: argumentFingerprint(call.arguments)
    };
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
      this.pending &&
      this.resolution &&
      !this.consumed &&
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

function exactSelection(
  selection: ModelSelection | undefined,
  project?: ProjectDefinition
): ExactSelection | undefined {
  const candidate = selection ?? project?.defaultModel;
  if (!candidate || candidate.mode === 'auto') return undefined;
  if (candidate.mode === 'local-first') {
    return { connectionId: 'ollama', modelId: candidate.modelId };
  }
  return { connectionId: candidate.providerId, modelId: candidate.modelId };
}

function companyForProject(snapshot: CompanyContextSnapshot, projectId: string): string {
  const owners = snapshot.companies.filter((company) => company.projectIds.includes(projectId));
  if (owners.length !== 1) {
    throw new Error(
      `Project ${projectId} must belong to exactly one canonical Company before AgentRuntime composition.`
    );
  }
  return owners[0]!.id;
}

function canonicalCompanyId(
  snapshot: CompanyContextSnapshot,
  project: ProjectDefinition | undefined,
  requestedCompanyId: string | undefined
): string {
  const canonical = project
    ? companyForProject(snapshot, project.id)
    : PERSONAL_COMPANY_ID;
  const requested = requestedCompanyId?.trim();
  if (requested && requested !== canonical) {
    throw new Error(
      `Session Company ${requested} does not match canonical ${project ? `Project ${project.id}` : 'Personal'} Company ${canonical}.`
    );
  }
  return canonical;
}

function assertProjectConnection(
  project: ProjectDefinition,
  mode: AgentProductInteractionMode,
  connection: ProviderConnectionView
): void {
  const policy = effectiveProjectConnectionPolicy(project);
  const allowed = mode === 'chat'
    ? policy.chat.allowedConnectionIds
    : policy.inference.allowedConnectionIds;
  if (!allowed.includes(connection.id)) {
    throw new Error(
      `Connection ${connection.id} is not allowed for ${mode} in Project ${project.id}.`
    );
  }
  if (!project.privacy.allowedProviderIds.includes(connection.providerFamily)) {
    throw new Error(
      `Provider family ${connection.providerFamily} is not allowed by Project ${project.id}.`
    );
  }
  if (connection.providerFamily !== 'ollama' && !project.privacy.cloudAllowed) {
    throw new Error(
      `Project ${project.id} does not allow cloud provider ${connection.providerFamily}.`
    );
  }
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

function resourcesFor(
  companyId: string,
  project: ProjectDefinition | undefined,
  browser: boolean,
  mcpHost?: McpHost
): AgentResourceBinding[] {
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
  for (const server of mcpHost?.catalog.listConfigured() ?? []) {
    if (!server.enabled || server.companyId !== companyId) continue;
    if (server.projectId !== undefined && server.projectId !== project?.id) continue;
    resources.push({
      kind: 'mcp',
      id: server.id,
      scope,
      companyId,
      projectId: server.projectId
    });
  }
  return resources;
}

function browserTools(backend: BrowserBackend | false | undefined): readonly AxisTool[] {
  if (backend === false) return [];
  const selected = backend ?? new FetchBrowserBackend();
  const tools = createBrowserToolset({ backend: selected }).tools;
  if (selected.id !== 'fetch') return tools;
  return tools.filter((tool) => [
    'browser.navigate',
    'browser.read',
    'browser.state',
    'browser.inspect'
  ].includes(tool.definition.name));
}

function toolNeedsWorkspace(tool: AxisTool): boolean {
  return tool.definition.requiredCapabilities.some((capability) =>
    capability.startsWith('filesystem.') ||
    capability.startsWith('process.') ||
    capability.startsWith('git.')
  );
}

function baseTools(
  roots: readonly AgentRoot[],
  backend: BrowserBackend | false | undefined
): AxisTool[] {
  const tools = [
    ...createFilesystemP12Tools(),
    ...createProcessTools().tools,
    ...createGitTools().tools,
    ...browserTools(backend)
  ];
  return roots.length > 0 ? tools : tools.filter((tool) => !toolNeedsWorkspace(tool));
}

function chatToolAllowed(tool: AxisTool): boolean {
  return tool.definition.effect === 'read' || tool.definition.effect === 'validation';
}

function permissionFor(
  mode: AgentProductInteractionMode,
  tool: AxisTool
): 'granted' | 'ask' {
  const permissions = tool.definition.requiredPermissions;
  if (permissions.includes('mcp.invoke.mutate')) return 'ask';
  if (permissions.includes('mcp.invoke.read')) return 'granted';
  if (mode === 'chat') return 'granted';
  if (tool.definition.name.startsWith('browser.')) {
    return tool.definition.effect === 'read' ? 'granted' : 'ask';
  }
  return 'granted';
}

function permissionsFor(
  mode: AgentProductInteractionMode,
  tools: readonly AxisTool[]
): AgentPermissionSet {
  const entries: Record<string, 'granted' | 'ask'> = Object.create(null) as Record<string, 'granted' | 'ask'>;
  for (const tool of tools) {
    const status = permissionFor(mode, tool);
    for (const permission of tool.definition.requiredPermissions) {
      if (entries[permission] !== 'ask') entries[permission] = status;
    }
  }
  return Object.freeze({ default: 'denied', entries: Object.freeze(entries) });
}

function transcriptFromChatHistory(input: ProjectEngineerInput): AgentMessage[] {
  return (input.chatHistory ?? []).map((turn, index) => ({
    id: `history-${index}`,
    role: turn.role,
    content: turn.content
  }));
}

function runtimeSystemPrompt(
  input: ProjectEngineerInput,
  context: AgentSessionContext,
  project: ProjectDefinition | undefined,
  memory?: string
): string {
  return [
    [
      '# AXIS SESSION AUTHORITY',
      `Company: ${context.companyId}`,
      `Project: ${context.project?.id ?? '(none)'}`,
      `Connection: ${context.connection.id}`,
      `Provider family: ${context.connection.providerFamily}`,
      `Auth kind: ${context.connection.authKind}`,
      `Model: ${context.modelId}`,
      `Execution target: ${context.executionTarget.id}`,
      `Roots: ${context.roots.map((root) => `${root.id}:${root.access}:${root.path}`).join(', ') || '(none)'}`,
      'Use only tools advertised by Axis. Explore dynamically: search/read, edit when authorized, run validation, inspect failures, repair, and inspect Git diff.',
      'Never claim hidden provider-side filesystem, shell, MCP, browser, or mutation work.',
      'Never expose raw chain-of-thought; concise reasoning summaries are allowed.'
    ].join('\n'),
    project?.instructions?.trim()
      ? `# PROJECT INSTRUCTIONS\n${project.instructions.trim()}`
      : undefined,
    input.context?.trim()
      ? `# USER CONTEXT\n${input.context.trim()}`
      : undefined,
    input.constraints?.length
      ? `# CONSTRAINTS\n${input.constraints.map((item) => `- ${item}`).join('\n')}`
      : undefined,
    memory
  ].filter((item): item is string => Boolean(item)).join('\n\n');
}

function eventFiles(
  events: readonly AgentLifecycleEvent[],
  type: 'read' | 'mutation'
): string[] {
  const files = new Set<string>();
  for (const event of events) {
    if (event.type !== type || event.status !== 'success') continue;
    const value = event.metadata?.relativePath ?? event.metadata?.path;
    if (typeof value === 'string' && value.trim()) files.add(value.trim());
  }
  return [...files];
}

function lastDiff(
  toolResults: readonly { toolName: string; status: string; output?: unknown }[]
): string {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const result = toolResults[index];
    if (!result || result.status !== 'success' || !result.toolName.includes('diff')) continue;
    if (typeof result.output === 'string') return result.output;
    if (result.output && typeof result.output === 'object') {
      const record = result.output as Record<string, unknown>;
      const value = record.diff ?? record.stdout;
      if (typeof value === 'string') return value;
    }
  }
  return '';
}

function asEngineerResult(
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
      evidenceFiles: eventFiles(events, 'read'),
      researchRequests: []
    },
    repairRounds: 0,
    changedFiles: eventFiles(events, 'mutation'),
    diff: lastDiff(toolResults),
    validation: [],
    modelCalls: []
  };
}

/**
 * Canonical product-composition layer. Both Chat and Cowork execute the same
 * AgentRuntime. Their authority is expressed only by immutable roots,
 * resources, capabilities, permissions and interaction policy.
 */
export class AgentProductRuntime implements AgentProductLifecycleSource {
  private readonly listeners = new Set<(event: AgentLifecycleEvent) => void>();
  private readonly pending = new Map<string, PendingSession>();
  private readonly memoryStore: ProjectMemoryStore;
  private readonly memoryRecorder: ReturnType<typeof createProjectMemoryLifecycleSink>;
  private readonly claudeProfiles: ClaudeAccountProfileStore;
  private readonly targetId: string;

  constructor(private readonly options: AgentProductRuntimeOptions) {
    this.memoryStore = options.memoryStore ?? new ProjectMemoryStore();
    this.memoryRecorder = createProjectMemoryLifecycleSink(this.memoryStore, {
      onError: (error) => console.error(
        `Project Memory lifecycle persistence failed: ${error instanceof Error ? error.message : String(error)}`
      )
    });
    this.claudeProfiles = options.claudeProfiles ?? new ClaudeAccountProfileStore();
    this.targetId = options.executionTargetId?.trim() || 'desktop';
  }

  subscribeAgentLifecycle(listener: (event: AgentLifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resolveAgentDecision(
    sessionId: string,
    resolution: AgentDecisionResolution
  ): void {
    const pending = this.pending.get(sessionId);
    if (!pending) {
      throw new Error(`Agent session ${sessionId} is not waiting for a decision.`);
    }
    if (resolution.requestId !== pending.request.id) {
      throw new Error(
        `Decision ${resolution.requestId} does not match pending request ${pending.request.id}.`
      );
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
    requested?: ModelSelection
  ): Promise<ExactSelection> {
    const exact = exactSelection(requested, project);
    if (exact) return exact;
    if (!project) {
      throw new Error(
        'Personal AgentRuntime execution requires an exact selected connection and model.'
      );
    }
    const selected = await this.options.providers.projectChatSelection(project);
    if (selected.mode !== 'explicit') {
      throw new Error(`Project ${project.id} did not resolve an exact default model.`);
    }
    return { connectionId: selected.providerId, modelId: selected.modelId };
  }

  private async resolveTransport(
    project: ProjectDefinition | undefined,
    connection: ProviderConnectionView,
    modelId: string,
    companyId: string
  ): Promise<ResolvedTransport> {
    let provider: InferenceProvider;
    let model: ModelDefinition | undefined;
    if (project) {
      // Compatibility transport resolution happens only after canonical Company
      // graph authorization. Legacy organization metadata is not an identity source.
      const registry = this.options.providers.buildRegistry(project);
      if (!registry.has(connection.id)) {
        throw new Error(`Project connection is unavailable: ${connection.id}`);
      }
      provider = registry.get(connection.id);
      model = (await provider.listModels()).find((candidate) => candidate.id === modelId);
    } else {
      const resolved = await this.options.providers.personalModelDefinition(
        connection.id,
        modelId
      );
      provider = resolved.provider;
      model = resolved.model;
    }
    if (!model) {
      throw new Error(
        `Model ${modelId} is not available through connection ${connection.id}.`
      );
    }
    return {
      connection,
      provider,
      model,
      adapter: createAgentProviderAdapterForConnection({
        connection,
        modelId,
        companyId: connection.auth === 'local' ? null : companyId,
        provider,
        claudeProfiles: this.claudeProfiles
      })
    };
  }

  private async compose(
    input: ProjectEngineerInput,
    sessionId: string
  ): Promise<PendingSession> {
    const mode = input.interactionMode ?? 'cowork';
    const project = input.projectId
      ? this.options.projects.getProject(input.projectId)
      : undefined;
    const snapshot = this.options.companyContext();
    const companyId = canonicalCompanyId(snapshot, project, input.companyId);
    const selection = await this.resolveSelection(project, input.modelSelection);
    const connection = this.options.connections.view(selection.connectionId);
    if (!connection) {
      throw new Error(`Unknown provider connection: ${selection.connectionId}`);
    }
    if (project) assertProjectConnection(project, mode, connection);

    const roots = rootsFor(companyId, project, input.workspace, mode);
    const resources = resourcesFor(
      companyId,
      project,
      this.options.browserBackend !== false,
      this.options.mcpHost
    );

    // Fail closed on mixed Company/Project/Connection/root authority before any
    // credential secret or account transport is invoked.
    buildAgentSessionContext({
      companyContext: snapshot,
      sessionId,
      companyId,
      project: project ? { id: project.id } : undefined,
      connection,
      modelId: selection.modelId,
      executionTarget: {
        id: this.targetId,
        kind: 'desktop',
        mode: roots.length ? 'workspace' : 'inference-only'
      },
      roots,
      permissions: { default: 'denied', entries: {} },
      capabilities: { entries: {} },
      resources
    });

    const transport = await this.resolveTransport(
      project,
      connection,
      selection.modelId,
      companyId
    );

    let tools = baseTools(roots, this.options.browserBackend);
    if (mode === 'chat') tools = tools.filter(chatToolAllowed);

    let permissions = permissionsFor(mode, tools);
    let capabilities = negotiateEffectiveCapabilities({
      offers: [
        providerModelCapabilityOffer(
          `connection:${connection.id}/model:${selection.modelId}`,
          transport.provider.capabilities,
          transport.model
        ),
        {
          source: `execution-target:${this.targetId}`,
          ids: [...new Set(tools.flatMap((tool) => tool.definition.requiredCapabilities))]
        }
      ]
    });

    let context = buildAgentSessionContext({
      companyContext: snapshot,
      sessionId,
      companyId,
      project: project ? { id: project.id } : undefined,
      connection,
      modelId: selection.modelId,
      executionTarget: {
        id: this.targetId,
        kind: 'desktop',
        mode: roots.length ? 'workspace' : 'inference-only'
      },
      roots,
      permissions,
      capabilities,
      resources
    });

    if (this.options.mcpHost) {
      const signal = currentCancellationSignal() ?? new AbortController().signal;
      const discovered = await this.options.mcpHost.toolsForSession(context, signal);
      const allowedMcp = mode === 'chat'
        ? discovered.filter(chatToolAllowed)
        : discovered;
      if (allowedMcp.length) {
        tools = [...tools, ...allowedMcp];
        permissions = permissionsFor(mode, tools);
        capabilities = negotiateEffectiveCapabilities({
          offers: [
            providerModelCapabilityOffer(
              `connection:${connection.id}/model:${selection.modelId}`,
              transport.provider.capabilities,
              transport.model
            ),
            {
              source: `execution-target:${this.targetId}`,
              ids: [...new Set(tools.flatMap((tool) => tool.definition.requiredCapabilities))]
            }
          ]
        });
        context = buildAgentSessionContext({
          companyContext: snapshot,
          sessionId,
          companyId,
          project: project ? { id: project.id } : undefined,
          connection,
          modelId: selection.modelId,
          executionTarget: {
            id: this.targetId,
            kind: 'desktop',
            mode: roots.length ? 'workspace' : 'inference-only'
          },
          roots,
          permissions,
          capabilities,
          resources
        });
      }
    }

    const memory = await loadProjectMemoryContext({
      store: this.memoryStore,
      session: context,
      task: input.goal
    });
    const permissionGate = new ProductPermissionGate();
    const runtime = new AgentRuntime({
      tools: new ToolRegistry(tools),
      executionTargets: [new LocalAgentExecutionTarget(this.targetId)],
      permissionGate,
      lifecycle: (event) => {
        if (
          event.type === 'decision.requested' &&
          event.request.kind === 'permission' &&
          event.call
        ) {
          permissionGate.remember(event.request, event.call);
        }
        this.emit(event);
      }
    });

    return {
      context,
      provider: transport.adapter,
      runtime,
      permissionGate,
      systemPrompt: runtimeSystemPrompt(input, context, project, memory?.capsule),
      transcript: transcriptFromChatHistory(input),
      turnIndex: input.chatHistory?.filter((turn) => turn.role === 'user').length ?? 0,
      request: { id: '', kind: 'confirmation', prompt: '' }
    };
  }

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    const sessionId = input.budgetJobId?.trim();
    if (!sessionId) {
      throw new Error('AgentRuntime product execution requires budgetJobId/sessionId.');
    }

    let session = this.pending.get(sessionId);
    if (!session) session = await this.compose(input, sessionId);

    const events: AgentLifecycleEvent[] = [];
    const unsubscribe = this.subscribeAgentLifecycle((event) => {
      if (event.sessionId === sessionId) events.push(event);
    });
    try {
      const resolution = session.resolution;
      const result = await session.runtime.run({
        context: session.context,
        provider: session.provider,
        userInput: resolution
          ? `Resume after decision ${resolution.requestId}. Apply that resolution exactly once.`
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
        this.pending.set(sessionId, session);
        return asEngineerResult(
          input,
          'needs-guidance',
          result.finalText ?? result.decisionRequest.prompt,
          events,
          result.toolResults
        );
      }

      this.pending.delete(sessionId);
      if (result.status === 'cancelled') {
        throw new Error(result.error?.message ?? 'AgentRuntime session cancelled.');
      }
      if (result.status === 'failed') {
        throw new Error(result.error?.message ?? 'AgentRuntime session failed.');
      }
      return asEngineerResult(
        input,
        'success',
        result.finalText?.trim() || 'Completed.',
        events,
        result.toolResults
      );
    } finally {
      unsubscribe();
    }
  }
}
