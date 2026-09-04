import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  type AgentLifecycleEvent,
  type AxisTool
} from '../src/agent-runtime/index.js';
import { AgentProductRuntime } from '../src/agent-product-runtime.js';
import type { StandaloneJobManager } from '../src/standalone-job-manager.js';
import { withCancellationSignal, OperationCancelledError, currentCancellationSignal } from '../src/cancellation.js';
import {
  LOCAL_ORGANIZATION_ID
} from '../src/connection-identity.js';
import type { CompanyContextSnapshot } from '../src/company-context.js';
import {
  loadProjectMemoryContext,
  ProjectMemoryStore
} from '../src/project-memory/index.js';
import type { ProjectEngineerInput } from '../src/project-engineer-backend.js';
import type { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import type { ProjectDefinition } from '../src/project-store.js';
import type {
  ProviderConnectionRuntime,
  ProviderConnectionView
} from '../src/provider-connections.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth
} from '../src/providers/types.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

const now = '2026-09-03T12:00:00.000Z';

function temp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `axis-product-${name}-`));
}

function connection(input: {
  id: string;
  providerFamily: 'openai' | 'anthropic' | 'ollama';
  companyId: string;
  auth?: ProviderConnectionView['auth'];
}): ProviderConnectionView {
  const auth = input.auth ?? (input.providerFamily === 'ollama' ? 'local' : 'api-key');
  return {
    id: input.id,
    providerFamily: input.providerFamily,
    label: input.id,
    auth,
    billing: auth === 'local' ? 'local' : auth === 'api-key' ? 'api' : 'subscription',
    organizationId: auth === 'local' ? LOCAL_ORGANIZATION_ID : input.companyId,
    available: true,
    supportsMcpSources: auth === 'claude-account' || auth === 'chatgpt-account'
  };
}

function project(input: {
  id: string;
  companyId: string;
  workspace: string;
  connectionId: string;
  providerFamily: 'openai' | 'anthropic' | 'ollama';
  modelId: string;
}): ProjectDefinition {
  return {
    id: input.id,
    name: input.id,
    workspace: input.workspace,
    organizationId: input.companyId,
    defaultRoutingPolicy: 'balanced',
    defaultModel: input.providerFamily === 'ollama'
      ? { mode: 'local-first', modelId: input.modelId }
      : { mode: 'explicit', providerId: input.connectionId, modelId: input.modelId },
    privacy: {
      cloudAllowed: input.providerFamily !== 'ollama',
      allowedProviderIds: [input.providerFamily]
    },
    credentialProfileIds: {},
    connectionPolicy: {
      chat: {
        defaultConnectionId: input.connectionId,
        defaultModelId: input.modelId,
        allowedConnectionIds: [input.connectionId]
      },
      inference: {
        allowedConnectionIds: [input.connectionId],
        preferredConnectionId: input.connectionId
      },
      workSourceIds: []
    },
    budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
    repoIntelligenceScope: 'project',
    concurrency: 2,
    createdAt: now,
    updatedAt: now
  };
}

function snapshot(input: {
  projects: ProjectDefinition[];
  connections: ProviderConnectionView[];
  sharedConnectionIds?: string[];
}): CompanyContextSnapshot {
  const companies = new Map<string, {
    connectionIds: string[];
    projectIds: string[];
  }>();
  for (const project of input.projects) {
    companies.set(project.organizationId, companies.get(project.organizationId) ?? {
      connectionIds: [], projectIds: []
    });
    companies.get(project.organizationId)!.projectIds.push(project.id);
  }
  for (const item of input.connections) {
    if (item.auth === 'local') continue;
    const companyId = item.organizationId;
    companies.set(companyId, companies.get(companyId) ?? { connectionIds: [], projectIds: [] });
    companies.get(companyId)!.connectionIds.push(item.id);
  }
  return {
    version: 1,
    generatedAt: now,
    companies: [...companies.entries()].map(([companyId, owned], index) => ({
      id: companyId,
      name: companyId,
      color: '#64748B',
      icon: 'building-2' as const,
      order: index,
      createdAt: now,
      updatedAt: now,
      kind: 'company' as const,
      connectionIds: [...new Set(owned.connectionIds)],
      projectIds: [...new Set(owned.projectIds)],
      sessionIds: []
    })),
    sharedConnectionIds: input.sharedConnectionIds ?? []
  };
}

class ScriptedProvider implements InferenceProvider {
  readonly kind = 'cloud' as const;
  readonly capabilities = capabilities;
  readonly requests: InferenceRequest[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    readonly id: string,
    readonly modelId: string,
    private readonly respond: (request: InferenceRequest, invocation: number) => Promise<Record<string, unknown>> | Record<string, unknown>,
    private readonly delayMs = 0
  ) {}

  async listModels(): Promise<ModelDefinition[]> {
    return [{
      providerId: this.id,
      id: this.modelId,
      displayName: this.modelId,
      capabilities
    }];
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      ok: true,
      checkedAt: now,
      latencyMs: 0,
      modelsAvailable: 1
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    this.requests.push(request);
    const invocation = this.requests.length;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      const content = await this.respond(request, invocation);
      return {
        providerId: this.id,
        model: request.model,
        content: JSON.stringify(content),
        stopReason: 'complete',
        latencyMs: this.delayMs,
        usage: {}
      };
    } finally {
      this.active -= 1;
    }
  }
}

function complete(text = 'done'): Record<string, unknown> {
  return { complete: true, text, toolCalls: [] };
}

function call(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    complete: false,
    toolCalls: [{ id, name, arguments: args }]
  };
}

function product(input: {
  projects: ProjectDefinition[];
  connections: ProviderConnectionView[];
  providers: Map<string, InferenceProvider>;
  memoryStore?: ProjectMemoryStore;
  extraTools?: readonly AxisTool[];
  sharedConnectionIds?: string[];
  jobManager?: StandaloneJobManager;
}): AgentProductRuntime {
  const projects = new Map(input.projects.map((item) => [item.id, item]));
  const connections = new Map(input.connections.map((item) => [item.id, item]));
  const providers = {
    buildRegistry(selected: ProjectDefinition) {
      const selection = selected.defaultModel;
      const connectionId = selection.mode === 'explicit'
        ? selection.providerId
        : selection.mode === 'local-first'
          ? 'ollama'
          : selected.connectionPolicy?.inference.preferredConnectionId;
      const provider = connectionId ? input.providers.get(connectionId) : undefined;
      return new ProviderRegistry(provider ? [provider] : []);
    },
    async personalModelDefinition(connectionId: string, modelId: string) {
      const provider = input.providers.get(connectionId);
      if (!provider) throw new Error(`No provider ${connectionId}`);
      const model = (await provider.listModels()).find((item) => item.id === modelId);
      if (!model) throw new Error(`No model ${modelId}`);
      return { provider, model };
    },
  projectConnectionIds(selected: ProjectDefinition, mode?: 'chat' | 'cowork') {
    const policy = selected.connectionPolicy;
    if (!policy) return [];
    return mode === 'chat'
      ? [...policy.chat.allowedConnectionIds]
      : [...policy.inference.allowedConnectionIds];
  },
  } as unknown as ProjectProviderRuntime;

  return new AgentProductRuntime({
    companyContext: () => snapshot({
      projects: input.projects,
      connections: input.connections,
      sharedConnectionIds: input.sharedConnectionIds
    }),
    projects: {
      getProject(id: string) {
        const selected = projects.get(id);
        if (!selected) throw new Error(`Unknown project ${id}`);
        return selected;
      }
    },
    connections: {
      view(id: string) { return connections.get(id); }
    } as ProviderConnectionRuntime,
    providers,
    memoryStore: input.memoryStore,
    browserBackend: false,
    extraTools: input.extraTools,
    executionTargetId: 'desktop',
    jobManager: input.jobManager
  });
}

function engineerInput(input: {
  project: ProjectDefinition;
  sessionId: string;
  mode?: 'chat' | 'cowork';
  companyId?: string;
  modelSelection?: ProjectEngineerInput['modelSelection'];
  goal?: string;
  workspace?: string;
}): ProjectEngineerInput {
  return {
    projectId: input.project.id,
    workspace: input.workspace ?? input.project.workspace,
    goal: input.goal ?? 'Fix the repository and verify it.',
    interactionMode: input.mode ?? 'cowork',
    budgetJobId: input.sessionId,
    modelSelection: input.modelSelection ?? input.project.defaultModel,
    ...(input.companyId ? { companyId: input.companyId } : {})
  } as ProjectEngineerInput;
}

function initializeRepo(root: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'axis@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Axis Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
}

test('Cowork product path dynamically searches, reads, edits, repairs a failed test, validates and reads Git diff through AgentRuntime', async () => {
  const directory = temp('cowork-flow');
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'value.txt'), 'broken\n');
  fs.writeFileSync(
    path.join(repo, 'test.js'),
    "const fs=require('node:fs'); process.exit(fs.readFileSync('src/value.txt','utf8').trim()==='fixed'?0:1);\n"
  );
  initializeRepo(repo);

  const selected = project({
    id: 'project-a', companyId: 'company-a', workspace: repo,
    connectionId: 'openai-a', providerFamily: 'openai', modelId: 'gpt-test'
  });
  const selectedConnection = connection({
    id: 'openai-a', providerFamily: 'openai', companyId: 'company-a'
  });
  const rootId = `project:${selected.id}`;
  const steps = [
    call('search', 'search_text', { rootId, query: 'broken', globs: ['src/**/*'] }),
    call('read', 'read_file', { rootId, path: 'src/value.txt' }),
    call('edit-1', 'edit_file', { rootId, path: 'src/value.txt', oldText: 'broken', newText: 'almost' }),
    call('test-1', 'process_exec', { command: 'node', args: ['test.js'], rootId, cwd: '.', mutation: 'workspace' }),
    call('edit-2', 'edit_file', { rootId, path: 'src/value.txt', oldText: 'almost', newText: 'fixed' }),
    call('test-2', 'process_exec', { command: 'node', args: ['test.js'], rootId, cwd: '.', mutation: 'workspace' }),
    call('diff', 'git_diff', { rootId, scope: 'working' }),
    complete('Fixed after inspecting the failed validation and confirmed the working diff.')
  ];
  const provider = new ScriptedProvider('openai-a', 'gpt-test', (_request, invocation) => steps[invocation - 1] ?? complete());
  const memoryStore = new ProjectMemoryStore({ rootDirectory: path.join(directory, 'memory') });
  const runtime = product({
    projects: [selected], connections: [selectedConnection],
    providers: new Map([['openai-a', provider]]), memoryStore
  });
  const events: AgentLifecycleEvent[] = [];
  runtime.subscribeAgentLifecycle((event) => events.push(event));

  try {
    const result = await runtime.executeEngineer(engineerInput({ project: selected, sessionId: 'cowork-flow' }));
    assert.equal(result.status, 'success');
    assert.equal(fs.readFileSync(path.join(repo, 'src', 'value.txt'), 'utf8'), 'fixed\n');
    assert.match(result.diff, /-broken/);
    assert.match(result.diff, /\+fixed/);
    assert.deepEqual(
      events.filter((event) => event.type === 'tool.call').map((event) => event.call.name),
      ['search_text', 'read_file', 'edit_file', 'process_exec', 'edit_file', 'process_exec', 'git_diff']
    );

    const processResults = events
      .filter((event) => event.type === 'tool.result' && event.result.toolName === 'process_exec')
      .map((event) => event.result.output as { exitCode?: number });
    assert.deepEqual(processResults.map((item) => item.exitCode), [1, 0]);
    assert.ok(events.some((event) => event.type === 'mutation' && event.status === 'success'));
    assert.ok(events.some((event) => event.type === 'command' && event.status === 'success'));

    const started = events.find((event) => event.type === 'session.started');
    assert.ok(started && started.type === 'session.started');
    if (!started || started.type !== 'session.started') throw new Error('Missing session context.');
    const memory = await loadProjectMemoryContext({
      store: memoryStore,
      session: { ...started.context, sessionId: 'memory-reader' },
      task: 'continue repository repair'
    });
    assert.equal(memory?.entries[0]?.handoff?.sessionId, 'cowork-flow');
    assert.ok(memory?.entries[0]?.handoff?.changedFiles.includes('src/value.txt'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('permission decisions pause before mutation; deny never executes and approve executes one matching call exactly once', async () => {
  const directory = temp('permission');
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  initializeRepo(repo);
  const selected = project({
    id: 'permission-project', companyId: 'company-a', workspace: repo,
    connectionId: 'openai-a', providerFamily: 'openai', modelId: 'gpt-test'
  });
  const selectedConnection = connection({ id: 'openai-a', providerFamily: 'openai', companyId: 'company-a' });
  let executions = 0;
  const mutation: AxisTool = {
    definition: {
      name: 'axis_browser_test_mutation',
      description: 'Product composition permission test mutation.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } },
      requiredCapabilities: [],
      requiredPermissions: ['browser.interact'],
      effect: 'mutation',
      mutationRisk: 'definite',
      retryOnFailure: 'after-confirmation',
      timeoutMs: 5_000
    },
    async execute() {
      executions += 1;
      return { output: { executions }, mutationStatus: 'committed', retry: 'after-confirmation' };
    }
  };

  async function runDecision(sessionId: string, optionId: 'approve' | 'deny'): Promise<void> {
    let invocation = 0;
    const provider = new ScriptedProvider('openai-a', 'gpt-test', () => {
      invocation += 1;
      if (invocation <= 2) {
        return call(`mutation-${invocation}`, 'axis_browser_test_mutation', { value: sessionId });
      }
      return complete(`${optionId} completed`);
    });
    const runtime = product({
      projects: [selected], connections: [selectedConnection],
      providers: new Map([['openai-a', provider]]), extraTools: [mutation]
    });
    const events: AgentLifecycleEvent[] = [];
    runtime.subscribeAgentLifecycle((event) => events.push(event));
    const input = engineerInput({ project: selected, sessionId });
    const paused = await runtime.executeEngineer(input);
    assert.equal(paused.status, 'needs-guidance');
    assert.equal(executions, optionId === 'approve' ? 0 : executions);
    const requested = events.find((event) => event.type === 'decision.requested');
    assert.ok(requested && requested.type === 'decision.requested');
    if (!requested || requested.type !== 'decision.requested') throw new Error('Expected decision request.');
    assert.ok(events.some((event) => event.type === 'permission.requested'));
    runtime.resolveAgentDecision(sessionId, { requestId: requested.request.id, optionId });
    const resumed = await runtime.executeEngineer(input);
    assert.equal(resumed.status, 'success');
  }

  try {
    const beforeDeny = executions;
    await runDecision('deny-session', 'deny');
    assert.equal(executions, beforeDeny);
    const beforeApprove = executions;
    await runDecision('approve-session', 'approve');
    assert.equal(executions, beforeApprove + 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Chat and Cowork use the same product AgentRuntime while authority comes from scoped tool catalogs', async () => {
  const directory = temp('chat-cowork');
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'readme.txt'), 'hello\n');
  initializeRepo(repo);
  const selected = project({
    id: 'project-a', companyId: 'company-a', workspace: repo,
    connectionId: 'openai-a', providerFamily: 'openai', modelId: 'gpt-exact'
  });
  const selectedConnection = connection({ id: 'openai-a', providerFamily: 'openai', companyId: 'company-a' });
  const prompts: string[] = [];
  const provider = new ScriptedProvider('openai-a', 'gpt-exact', (request, invocation) => {
    prompts.push(request.systemPrompt);
    const cowork = request.systemPrompt.includes('"name":"edit_file"');
    if (cowork && invocation === 1) {
      return call('read-first', 'read_file', { rootId: 'project:project-a', path: 'readme.txt' });
    }
    return complete('same runtime, different authority');
  });
  const runtime = product({ projects: [selected], connections: [selectedConnection], providers: new Map([['openai-a', provider]]) });
  const contexts: Array<{ mode: string; context: Extract<AgentLifecycleEvent, { type: 'session.started' }>['context'] }> = [];
  runtime.subscribeAgentLifecycle((event) => {
    if (event.type === 'session.started') contexts.push({ mode: event.context.roots[0]?.access ?? 'none', context: event.context });
  });

  try {
    const chat = await runtime.executeEngineer(engineerInput({ project: selected, sessionId: 'chat', mode: 'chat' }));
    assert.equal(chat.status, 'success');
    const cowork = await runtime.executeEngineer(engineerInput({ project: selected, sessionId: 'cowork', mode: 'cowork' }));
    assert.equal(cowork.status, 'success');
    assert.equal(provider.requests.every((request) => request.model === 'gpt-exact'), true);
    assert.ok(prompts[0]?.includes('"name":"search_text"'));
    assert.equal(prompts[0]?.includes('"name":"edit_file"'), false);
    assert.equal(prompts[0]?.includes('"name":"process_exec"'), false);
    assert.ok(prompts.some((prompt) => prompt.includes('"name":"edit_file"')));
    assert.ok(prompts.some((prompt) => prompt.includes('"name":"process_exec"')));
    assert.deepEqual(contexts.map((item) => item.mode), ['read', 'write']);
    assert.ok(contexts.every((item) => item.context.executionTarget.id === 'desktop'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('two Companies and two real provider families execute concurrently through the same composition without cross-scope access', async () => {
  const directory = temp('companies');
  const repoA = path.join(directory, 'a');
  const repoB = path.join(directory, 'b');
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  fs.writeFileSync(path.join(repoA, 'a.txt'), 'a');
  fs.writeFileSync(path.join(repoB, 'b.txt'), 'b');
  initializeRepo(repoA);
  initializeRepo(repoB);
  const projectA = project({ id: 'project-a', companyId: 'company-a', workspace: repoA, connectionId: 'openai-a', providerFamily: 'openai', modelId: 'gpt-a' });
  const projectB = project({ id: 'project-b', companyId: 'company-b', workspace: repoB, connectionId: 'anthropic-b', providerFamily: 'anthropic', modelId: 'claude-b' });
  const connectionA = connection({ id: 'openai-a', providerFamily: 'openai', companyId: 'company-a' });
  const connectionB = connection({ id: 'anthropic-b', providerFamily: 'anthropic', companyId: 'company-b' });
  let active = 0;
  let maxActive = 0;
  function concurrentProvider(id: string, modelId: string): ScriptedProvider {
    return new ScriptedProvider(id, modelId, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return complete(id);
    });
  }
  const providerA = concurrentProvider('openai-a', 'gpt-a');
  const providerB = concurrentProvider('anthropic-b', 'claude-b');
  const runtime = product({
    projects: [projectA, projectB], connections: [connectionA, connectionB],
    providers: new Map([['openai-a', providerA], ['anthropic-b', providerB]])
  });
  const contexts: Extract<AgentLifecycleEvent, { type: 'session.started' }>[] = [];
  runtime.subscribeAgentLifecycle((event) => { if (event.type === 'session.started') contexts.push(event); });

  try {
    const [a, b] = await Promise.all([
      runtime.executeEngineer(engineerInput({ project: projectA, sessionId: 'company-a-chat', mode: 'chat' })),
      runtime.executeEngineer(engineerInput({ project: projectB, sessionId: 'company-b-chat', mode: 'chat' }))
    ]);
    assert.equal(a.status, 'success');
    assert.equal(b.status, 'success');
    assert.equal(maxActive, 2);
    assert.deepEqual(new Set(contexts.map((event) => event.context.companyId)), new Set(['company-a', 'company-b']));
    assert.equal(contexts.find((event) => event.context.companyId === 'company-a')?.context.connection.id, 'openai-a');
    assert.equal(contexts.find((event) => event.context.companyId === 'company-b')?.context.connection.id, 'anthropic-b');
    assert.equal(providerA.requests[0]?.model, 'gpt-a');
    assert.equal(providerB.requests[0]?.model, 'claude-b');

    await assert.rejects(
      runtime.executeEngineer(engineerInput({
        project: projectA,
        sessionId: 'cross-connection',
        mode: 'chat',
        modelSelection: { mode: 'explicit', providerId: 'anthropic-b', modelId: 'claude-b' }
      })),
      /not visible to chat in Project project-a/
    );
    await assert.rejects(
      runtime.executeEngineer(engineerInput({ project: projectA, sessionId: 'cross-company', mode: 'chat', companyId: 'company-b' })),
      /does not match canonical Project project-a Company company-a/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('shared Ollama Connection stays Company-neutral while the product session remains Company-scoped', async () => {
  const directory = temp('shared-local');
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  initializeRepo(repo);
  const selected = project({
    id: 'local-project', companyId: 'company-a', workspace: repo,
    connectionId: 'ollama', providerFamily: 'ollama', modelId: 'local-model'
  });
  const localConnection = connection({ id: 'ollama', providerFamily: 'ollama', companyId: 'company-a', auth: 'local' });
  const provider = new ScriptedProvider('ollama', 'local-model', () => complete('local')) as InferenceProvider;
  Object.defineProperty(provider, 'kind', { value: 'local' });
  const runtime = product({
    projects: [selected], connections: [localConnection], providers: new Map([['ollama', provider]]), sharedConnectionIds: ['ollama']
  });
  let context: Extract<AgentLifecycleEvent, { type: 'session.started' }>['context'] | undefined;
  runtime.subscribeAgentLifecycle((event) => { if (event.type === 'session.started') context = event.context; });

  try {
    const result = await runtime.executeEngineer(engineerInput({ project: selected, sessionId: 'local-chat', mode: 'chat' }));
    assert.equal(result.status, 'success');
    assert.equal(context?.companyId, 'company-a');
    assert.equal(context?.connection.id, 'ollama');
    assert.equal(context?.connection.companyId, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('product cancellation reaches provider and generic tool; process cancellation remains the shared process-runtime contract', async () => {
  const directory = temp('cancel');
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  initializeRepo(repo);
  const selected = project({ id: 'cancel-project', companyId: 'company-a', workspace: repo, connectionId: 'openai-a', providerFamily: 'openai', modelId: 'gpt-test' });
  const selectedConnection = connection({ id: 'openai-a', providerFamily: 'openai', companyId: 'company-a' });

  const blockingProvider: InferenceProvider = {
    id: 'openai-a', kind: 'cloud', capabilities,
    async listModels() { return [{ providerId: 'openai-a', id: 'gpt-test', displayName: 'test', capabilities }]; },
    async health() { return { providerId: 'openai-a', ok: true, checkedAt: now, latencyMs: 0 }; },
    async invoke() {
      const signal = currentCancellationSignal();
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new OperationCancelledError());
        signal?.addEventListener('abort', () => reject(new OperationCancelledError()), { once: true });
        setTimeout(resolve, 5_000);
      });
      return { providerId: 'openai-a', model: 'gpt-test', content: JSON.stringify(complete()), latencyMs: 0, usage: {} };
    }
  };
  const providerRuntime = product({ projects: [selected], connections: [selectedConnection], providers: new Map([['openai-a', blockingProvider]]) });
  const providerController = new AbortController();
  setTimeout(() => providerController.abort(), 25);
  await assert.rejects(
    withCancellationSignal(providerController.signal, () => providerRuntime.executeEngineer(engineerInput({ project: selected, sessionId: 'provider-cancel', mode: 'chat' })))
  );

  let toolStarted = false;
  const blockingTool: AxisTool = {
    definition: {
      name: 'blocking_read', description: 'Wait until cancelled.', inputSchema: { type: 'object', additionalProperties: false },
      requiredCapabilities: [], requiredPermissions: [], effect: 'read', mutationRisk: 'none', retryOnFailure: 'safe', timeoutMs: 10_000
    },
    async execute(context) {
      toolStarted = true;
      await new Promise<void>((resolve, reject) => {
        if (context.signal.aborted) return reject(new OperationCancelledError());
        context.signal.addEventListener('abort', () => reject(new OperationCancelledError()), { once: true });
        setTimeout(resolve, 5_000);
      });
      return { output: 'unexpected', mutationStatus: 'not-applicable', retry: 'safe' };
    }
  };
  const toolProvider = new ScriptedProvider('openai-a', 'gpt-test', (_request, invocation) =>
    invocation === 1 ? call('blocking', 'blocking_read', {}) : complete()
  );
  const toolRuntime = product({
    projects: [selected], connections: [selectedConnection], providers: new Map([['openai-a', toolProvider]]), extraTools: [blockingTool]
  });
  const toolController = new AbortController();
  setTimeout(() => toolController.abort(), 40);
  await assert.rejects(
    withCancellationSignal(toolController.signal, () => toolRuntime.executeEngineer(engineerInput({ project: selected, sessionId: 'tool-cancel' })))
  );
  assert.equal(toolStarted, true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('product composition uses the common connection adapter factory, preserving API Key/Account architecture and Codex fail-closed policy', () => {
  const source = fs.readFileSync('src/agent-product-runtime.ts', 'utf8');
  const adapterComposition = fs.readFileSync('src/agent-provider-adapters/resolved-connection.ts', 'utf8');
  const codexBlocker = fs.readFileSync('src/agent-provider-adapters/chatgpt-account.ts', 'utf8');
  assert.match(source, /createAgentProviderAdapterForConnection\(\{/);
  assert.doesNotMatch(source, /authKind\s*===/);
  assert.match(adapterComposition, /input\.connection\.auth === 'api-key'/);
  assert.match(adapterComposition, /input\.connection\.auth === 'claude-account'/);
  assert.match(adapterComposition, /input\.connection\.auth === 'chatgpt-account'/);
  assert.match(codexBlocker, /no proven all-tools-disabled mode/);
});


test('P1 gate: product catalog does not advertise managed worktrees before an exact task worktree root is composed', async () => {
  const directory = temp('p1-worktree-catalog');
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'readme.txt'), 'hello\n');
  initializeRepo(repo);

  const selected = project({
    id: 'p1-worktree-project', companyId: 'company-a', workspace: repo,
    connectionId: 'openai-a', providerFamily: 'openai', modelId: 'gpt-test'
  });
  const selectedConnection = connection({
    id: 'openai-a', providerFamily: 'openai', companyId: 'company-a'
  });
  const prompts: string[] = [];
  const provider = new ScriptedProvider('openai-a', 'gpt-test', (request, invocation) => {
    prompts.push(request.systemPrompt);
    if (invocation === 1) {
      return call('read', 'read_file', {
        rootId: 'project:p1-worktree-project', path: 'readme.txt'
      });
    }
    return complete('Catalog stayed fail-closed.');
  });
  const runtime = product({
    projects: [selected], connections: [selectedConnection],
    providers: new Map([['openai-a', provider]])
  });

  try {
    const result = await runtime.executeEngineer(engineerInput({
      project: selected, sessionId: 'p1-worktree-catalog'
    }));
    assert.equal(result.status, 'success');
    const prompt = prompts[0] ?? '';
    assert.ok(prompt.includes('\"name\":\"git_status\"'));
    assert.equal(prompt.includes('\"name\":\"git_worktree_list\"'), false);
    assert.equal(prompt.includes('\"name\":\"git_worktree_create\"'), false);
    assert.equal(prompt.includes('\"name\":\"git_worktree_remove\"'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('durable checkpoint persists paused decision sessions and restores them on restart', async () => {
  const directory = temp('checkpoint');
  const stateDir = path.join(directory, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  initializeRepo(repo);
  const selected = project({
    id: 'checkpoint-project', companyId: 'company-a', workspace: repo,
    connectionId: 'openai-a', providerFamily: 'openai', modelId: 'gpt-test'
  });
  const selectedConnection = connection({ id: 'openai-a', providerFamily: 'openai', companyId: 'company-a' });
  const sessionId = 'checkpoint-session';

  // First session: pause on decision.
  let invocation = 0;
  const pausingProvider = new ScriptedProvider('openai-a', 'gpt-test', () => {
    invocation += 1;
    if (invocation === 1) {
      return call('mutation-1', 'axis_browser_test_mutation', {});
    }
    return complete('never reached');
  });

  const mutation: AxisTool = {
    definition: {
      name: 'axis_browser_test_mutation',
      description: 'Checkpoint test mutation.',
      inputSchema: { type: 'object', additionalProperties: false },
      requiredCapabilities: [],
      requiredPermissions: ['browser.interact'],
      effect: 'mutation',
      mutationRisk: 'definite',
      retryOnFailure: 'after-confirmation',
      timeoutMs: 5_000
    },
    async execute() {
      return { output: { executed: true }, mutationStatus: 'committed', retry: 'after-confirmation' };
    }
  };

  try {
    // Create job manager and runtime with checkpoint support.
    const { StandaloneJobManager: JobMgr1 } = await import('../src/standalone-job-manager.js');
    const placeholderExecution1 = {
      executeEngineer: async () => { throw new Error('not used'); },
      prepareEscalation: async () => { throw new Error('not used'); },
      consultEscalation: async () => { throw new Error('not used'); }
    };
    const jobs1 = new JobMgr1(placeholderExecution1, stateDir);
    const runtime1 = product({
      projects: [selected],
      connections: [selectedConnection],
      providers: new Map([['openai-a', pausingProvider]]),
      extraTools: [mutation],
      jobManager: jobs1
    });

    const events1: AgentLifecycleEvent[] = [];
    runtime1.subscribeAgentLifecycle((event) => events1.push(event));

    // Add a job entry to the job manager so setPendingCheckpoint has something to attach to.
    const jobInput = {
      goal: 'Test checkpoint',
      workspace: repo,
      interactionMode: 'cowork' as const,
      projectId: 'checkpoint-project',
      budgetJobId: sessionId
    };
    (jobs1 as unknown as { jobs: Map<string, unknown> }).jobs.set(sessionId, {
      id: sessionId,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      input: jobInput,
      turns: [],
      rounds: 0,
      events: []
    });

    const input1 = engineerInput({ project: selected, sessionId, goal: 'Test checkpoint', workspace: repo });
    const paused = await runtime1.executeEngineer(input1);

    // Session should pause for decision.
    assert.equal(paused.status, 'needs-guidance', 'Session should pause for decision');

    // Checkpoint should be persisted.
    const checkpoint1 = jobs1.getPendingCheckpoint(sessionId);
    assert.ok(checkpoint1, 'Checkpoint should be persisted');
    assert.equal(checkpoint1!.sessionId, sessionId, 'Checkpoint has correct sessionId');
    assert.equal(checkpoint1!.companyId, 'company-a', 'Checkpoint has correct companyId');
    assert.ok(checkpoint1!.decisionRequest, 'Checkpoint has a decisionRequest');
    assert.equal(checkpoint1!.decisionRequest!.kind, 'permission', 'Decision is a permission request');
    assert.ok(Array.isArray(checkpoint1!.transcript), 'Checkpoint has transcript');

    runtime1.resolveAgentDecision(sessionId, {
      requestId: checkpoint1!.decisionRequest!.id,
      optionId: 'approve'
    });
    await jobs1.setPendingCheckpoint(sessionId, jobs1.getPendingCheckpoint(sessionId));

    // Simulate restart: new manager + new runtime from same state.
    const { StandaloneJobManager: JobMgr2 } = await import('../src/standalone-job-manager.js');
    const placeholderExecution2 = {
      executeEngineer: async () => { throw new Error('not used'); },
      prepareEscalation: async () => { throw new Error('not used'); },
      consultEscalation: async () => { throw new Error('not used'); }
    };
    const jobs2 = new JobMgr2(placeholderExecution2, stateDir);
    await (jobs2 as unknown as { restore: () => Promise<void> }).restore();

    const runtime2 = product({
      projects: [selected],
      connections: [selectedConnection],
      providers: new Map([['openai-a', pausingProvider]]),
      extraTools: [mutation],
      jobManager: jobs2
    });

    // Resume the session from checkpoint.
    const restoredCheckpoint = jobs2.getPendingCheckpoint(sessionId);
    assert.ok(restoredCheckpoint, 'Checkpoint should be restored from disk');
    assert.equal(restoredCheckpoint!.sessionId, sessionId, 'Restored checkpoint has correct sessionId');
    assert.equal(restoredCheckpoint!.companyId, 'company-a', 'Restored checkpoint has correct company');

    // Running executeEngineer should restore the paused session.
    const input2 = engineerInput({ project: selected, sessionId, goal: 'Test checkpoint', workspace: repo });
    const resumed = await runtime2.executeEngineer(input2);

    // After resuming with the previous decision, should complete.
    assert.equal(resumed.status, 'success', 'Session should complete after decision is resolved');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('mutation ledger tracks committed and started-unknown mutations persistently', async () => {
  const directory = temp('mutation-ledger');
  const stateDir = path.join(directory, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  initializeRepo(repo);
  const selected = project({
    id: 'ledger-project', companyId: 'company-a', workspace: repo,
    connectionId: 'openai-a', providerFamily: 'openai', modelId: 'gpt-test'
  });
  const selectedConnection = connection({ id: 'openai-a', providerFamily: 'openai', companyId: 'company-a' });

  let mutationCalls = 0;
  const mutation: AxisTool = {
    definition: {
      name: 'axis_ledger_mutation',
      description: 'Ledger test mutation.',
      inputSchema: { type: 'object', additionalProperties: false },
      requiredCapabilities: [],
      requiredPermissions: ['browser.interact'],
      effect: 'mutation',
      mutationRisk: 'definite',
      retryOnFailure: 'safe',
      timeoutMs: 5_000
    },
    async execute() {
      mutationCalls += 1;
      return { output: { calls: mutationCalls }, mutationStatus: 'committed', retry: 'safe' };
    }
  };

  try {
    const { StandaloneJobManager: JobMgr } = await import('../src/standalone-job-manager.js');
    const placeholderExecution = {
      executeEngineer: async () => { throw new Error('not used'); },
      prepareEscalation: async () => { throw new Error('not used'); },
      consultEscalation: async () => { throw new Error('not used'); }
    };
    const jobs = new JobMgr(placeholderExecution, stateDir);
    const runtime = product({
      projects: [selected],
      connections: [selectedConnection],
      providers: new Map([['openai-a', new ScriptedProvider('openai-a', 'gpt-test', () => {
        return mutationCalls === 0
          ? call('call-1', 'axis_ledger_mutation', {})
          : complete('done');
      })]]),
      extraTools: [mutation],
      jobManager: jobs
    });

    const sessionId = 'ledger-session';
    (jobs as unknown as { jobs: Map<string, unknown> }).jobs.set(sessionId, {
      id: sessionId,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      input: { goal: 'Ledger test', workspace: repo, interactionMode: 'cowork' as const },
      turns: [],
      rounds: 0,
      events: []
    });

    const input = engineerInput({ project: selected, sessionId, goal: 'Ledger test', workspace: repo });
    await runtime.executeEngineer(input);

    const ledger = jobs.getMutationLedger(sessionId);
    assert.ok(ledger.length > 0, 'Mutation ledger should have entries');

    // Committed mutations should have resolvedAt set.
    const committed = ledger.filter((e) => e.mutationStatus === 'committed');
    assert.ok(committed.length > 0, 'Should have committed entries');
    for (const entry of committed) {
      assert.ok(entry.resolvedAt, 'Committed entry should have resolvedAt');
      assert.equal(entry.resolvedBy, 'agent', 'Committed entry resolvedBy should be agent');
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('pendingCheckpoint and mutationLedger are cleared on terminal state (success/cancelled/failed)', async () => {
  const directory = temp('checkpoint-clear');
  const stateDir = path.join(directory, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  initializeRepo(repo);
  const selected = project({
    id: 'clear-project', companyId: 'company-a', workspace: repo,
    connectionId: 'openai-a', providerFamily: 'openai', modelId: 'gpt-test'
  });
  const selectedConnection = connection({ id: 'openai-a', providerFamily: 'openai', companyId: 'company-a' });

  try {
    const { StandaloneJobManager: JobMgr } = await import('../src/standalone-job-manager.js');
    const placeholderExecution = {
      executeEngineer: async () => { throw new Error('not used'); },
      prepareEscalation: async () => { throw new Error('not used'); },
      consultEscalation: async () => { throw new Error('not used'); }
    };
    const jobs = new JobMgr(placeholderExecution, stateDir);
    const runtime = product({
      projects: [selected],
      connections: [selectedConnection],
      providers: new Map([['openai-a', new ScriptedProvider('openai-a', 'gpt-test', () => complete('done'))]]),
      jobManager: jobs
    });

    const sessionId = 'clear-session';
    (jobs as unknown as { jobs: Map<string, unknown> }).jobs.set(sessionId, {
      id: sessionId,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      input: { goal: 'Clear test', workspace: repo, interactionMode: 'cowork' as const },
      turns: [],
      rounds: 0,
      events: []
    });

    // Manually set a checkpoint to simulate paused state.
    jobs.setPendingCheckpoint(sessionId, {
      sessionId,
      companyId: 'company-a',
      connectionId: 'openai-a',
      modelId: 'gpt-test',
      sessionContext: {} as never,
      transcript: [],
      turnIndex: 0,
      mutationLedger: [],
      checkpointAt: new Date().toISOString()
    });

    const input = engineerInput({ project: selected, sessionId, goal: 'Clear test', workspace: repo });
    await runtime.executeEngineer(input);

    const cleared = jobs.getPendingCheckpoint(sessionId);
    assert.equal(cleared, undefined, 'Checkpoint should be cleared after success');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
