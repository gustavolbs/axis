import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { AgentLifecycleEvent, AxisTool } from '../src/agent-runtime/index.js';
import { AgentProductExecutionBridge } from '../src/agent-product-execution.js';
import { AgentProductRuntime } from '../src/agent-product-runtime.js';
import type { CompanyContextSnapshot } from '../src/company-context.js';
import { ProjectMemoryStore } from '../src/project-memory/index.js';
import { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import type { ProjectEngineerInput } from '../src/project-engineer-backend.js';
import type { ProjectDefinition } from '../src/project-store.js';
import { ProviderConnectionRuntime } from '../src/provider-connections.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth
} from '../src/providers/types.js';

interface ScriptedEnvelope {
  readonly complete: boolean;
  readonly text?: string;
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }[];
}

class ScriptedProvider implements InferenceProvider {
  readonly id = 'ollama';
  readonly kind = 'local' as const;
  readonly capabilities: ProviderCapabilities = {
    modelDiscovery: true,
    streaming: false,
    structuredOutput: true,
    reasoning: false,
    promptCaching: false,
    toolUse: true
  };
  readonly requests: InferenceRequest[] = [];
  readonly models: ModelDefinition[] = [{
    providerId: this.id,
    id: 'model-a',
    displayName: 'Model A',
    capabilities: this.capabilities
  }];

  constructor(private readonly responses: ScriptedEnvelope[]) {}

  async listModels(): Promise<ModelDefinition[]> {
    return [...this.models];
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      modelsAvailable: this.models.length
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error(`No scripted provider response for call ${this.requests.length}.`);
    return {
      providerId: this.id,
      model: request.model,
      content: JSON.stringify(response),
      latencyMs: 1,
      usage: {}
    };
  }
}

function envelope(
  toolCalls: ScriptedEnvelope['toolCalls'] = [],
  text?: string
): ScriptedEnvelope {
  return { complete: toolCalls.length === 0, text, toolCalls };
}

function companySnapshot(projectId = 'project-a'): CompanyContextSnapshot {
  const now = new Date().toISOString();
  return {
    version: 1,
    generatedAt: now,
    companies: [{
      id: 'company-a',
      name: 'Company A',
      color: '#64748B',
      icon: 'building-2',
      order: 1,
      createdAt: now,
      updatedAt: now,
      kind: 'company',
      connectionIds: [],
      projectIds: [projectId],
      sessionIds: []
    }],
    sharedConnectionIds: ['ollama']
  };
}

function project(workspace: string, input: Partial<ProjectDefinition> = {}): ProjectDefinition {
  const now = new Date().toISOString();
  return {
    id: 'project-a',
    name: 'Project A',
    workspace,
    organizationId: 'company-a',
    defaultRoutingPolicy: 'auto',
    defaultModel: { mode: 'explicit', providerId: 'ollama', modelId: 'model-a' },
    privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] },
    credentialProfileIds: {},
    connectionPolicy: {
      chat: {
        defaultConnectionId: 'ollama',
        defaultModelId: 'model-a',
        allowedConnectionIds: ['ollama']
      },
      inference: {
        allowedConnectionIds: ['ollama'],
        preferredConnectionId: 'ollama'
      },
      workSourceIds: []
    },
    budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
    repoIntelligenceScope: 'project',
    concurrency: 1,
    createdAt: now,
    updatedAt: now,
    ...input
  };
}

function runtimeFor(
  provider: ScriptedProvider,
  workspace: string,
  options: { extraTools?: readonly AxisTool[]; memoryStore?: ProjectMemoryStore } = {}
): AgentProductRuntime {
  const currentProject = project(workspace);
  const connections = new ProviderConnectionRuntime({ localProvider: provider });
  const providers = new ProjectProviderRuntime({ localProvider: provider, connections });
  return new AgentProductRuntime({
    companyContext: () => companySnapshot(currentProject.id),
    projects: {
      getProject(id: string) {
        if (id !== currentProject.id) throw new Error(`Unknown Project ${id}`);
        return currentProject;
      }
    },
    connections,
    providers,
    memoryStore: options.memoryStore,
    browserBackend: false,
    executionTargetId: 'desktop',
    extraTools: options.extraTools
  });
}

function input(
  workspace: string,
  sessionId: string,
  mode: 'chat' | 'cowork' = 'cowork',
  goal = 'Complete the integration task.'
): ProjectEngineerInput {
  return {
    workspace,
    projectId: 'project-a',
    interactionMode: mode,
    goal,
    budgetJobId: sessionId,
    modelSelection: { mode: 'explicit', providerId: 'ollama', modelId: 'model-a' }
  };
}

function initializeRepository(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'BAD\n');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'axis-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Axis Test'], { cwd: root });
  execFileSync('git', ['add', 'src/value.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' });
}

function validationTool(): AxisTool {
  return {
    definition: {
      name: 'product_validation_probe',
      description: 'Validate the product-composition fixture.',
      inputSchema: { type: 'object', additionalProperties: false },
      requiredCapabilities: ['axis.test.validation'],
      requiredPermissions: ['validation.run'],
      effect: 'validation',
      mutationRisk: 'none',
      retryOnFailure: 'safe'
    },
    async execute(context) {
      const root = context.session.roots[0];
      if (!root) throw new Error('Missing test root.');
      const value = fs.readFileSync(path.join(root.path, 'src', 'value.txt'), 'utf8');
      if (value !== 'GOOD\n') throw new Error('fixture validation failed');
      return { output: { ok: true } };
    }
  };
}

test('Cowork composes a real AgentRuntime search -> edit -> failed validation -> repair -> Git diff loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-product-runtime-loop-'));
  initializeRepository(root);
  const rootId = 'project:project-a';
  const provider = new ScriptedProvider([
    envelope([{ id: 'search-1', name: 'search_text', arguments: { rootId, query: 'BAD', path: '.' } }]),
    envelope([{ id: 'edit-1', name: 'edit_file', arguments: { rootId, path: 'src/value.txt', oldText: 'BAD', newText: 'BROKEN' } }]),
    envelope([{ id: 'validate-1', name: 'product_validation_probe', arguments: {} }]),
    envelope([{ id: 'repair-1', name: 'edit_file', arguments: { rootId, path: 'src/value.txt', oldText: 'BROKEN', newText: 'GOOD' } }]),
    envelope([{ id: 'validate-2', name: 'product_validation_probe', arguments: {} }]),
    envelope([{ id: 'diff-1', name: 'git_diff', arguments: { rootId, scope: 'working' } }]),
    envelope([], 'Integrated through the canonical runtime.')
  ]);
  const runtime = runtimeFor(provider, root, { extraTools: [validationTool()] });
  const events: AgentLifecycleEvent[] = [];
  runtime.subscribeAgentLifecycle((event) => events.push(event));

  const result = await runtime.executeEngineer(input(root, 'loop-session'));

  assert.equal(result.status, 'success');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'value.txt'), 'utf8'), 'GOOD\n');
  assert.ok(result.changedFiles.includes('src/value.txt'));
  assert.match(result.diff, /BAD/);
  assert.match(result.diff, /GOOD/);
  const calls = events
    .filter((event): event is Extract<AgentLifecycleEvent, { type: 'tool.call' }> => event.type === 'tool.call')
    .map((event) => event.call.name);
  assert.deepEqual(calls, [
    'search_text',
    'edit_file',
    'product_validation_probe',
    'edit_file',
    'product_validation_probe',
    'git_diff'
  ]);
  assert.ok(events.some((event) => event.type === 'error' && event.error.message.includes('fixture validation failed')));
  assert.match(provider.requests[0]?.systemPrompt ?? '', /Company: company-a/);
  assert.match(provider.requests[0]?.systemPrompt ?? '', /Project: project-a/);
  assert.match(provider.requests[0]?.systemPrompt ?? '', /Connection: ollama/);
  assert.match(provider.requests[0]?.systemPrompt ?? '', /project:project-a:write:/);
});

test('Chat and Cowork share product composition while immutable authority narrows Chat tools and root access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-product-runtime-modes-'));
  fs.mkdirSync(root, { recursive: true });
  const provider = new ScriptedProvider([
    envelope([], 'chat done'),
    envelope([], 'cowork done')
  ]);
  const runtime = runtimeFor(provider, root);

  await runtime.executeEngineer(input(root, 'chat-session', 'chat'));
  await runtime.executeEngineer(input(root, 'cowork-session', 'cowork'));

  const chatPrompt = provider.requests[0]?.systemPrompt ?? '';
  const coworkPrompt = provider.requests[1]?.systemPrompt ?? '';
  assert.match(chatPrompt, /project:project-a:read:/);
  assert.match(coworkPrompt, /project:project-a:write:/);
  assert.match(chatPrompt, /"name":"search_text"/);
  assert.doesNotMatch(chatPrompt, /"name":"edit_file"/);
  assert.match(coworkPrompt, /"name":"search_text"/);
  assert.match(coworkPrompt, /"name":"edit_file"/);
});

test('product composition rejects a missing exact model and a mismatched Company without provider fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-product-runtime-exact-'));
  const provider = new ScriptedProvider([envelope([], 'must not run')]);
  const runtime = runtimeFor(provider, root);

  await assert.rejects(
    runtime.executeEngineer({
      ...input(root, 'missing-model'),
      modelSelection: { mode: 'explicit', providerId: 'ollama', modelId: 'missing-model' }
    }),
    /Model missing-model is not available through connection ollama/
  );
  assert.equal(provider.requests.length, 0);

  const wrongCompany = {
    ...input(root, 'wrong-company'),
    companyId: 'company-b'
  } as ProjectEngineerInput & { companyId: string };
  await assert.rejects(
    runtime.executeEngineer(wrongCompany),
    /does not match canonical Project project-a Company company-a/
  );
  assert.equal(provider.requests.length, 0);
});

test('product permission pause resumes one exact mutation after approval without duplicate execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-product-runtime-approval-'));
  let mutations = 0;
  const mutationTool: AxisTool = {
    definition: {
      name: 'product_external_mutation',
      description: 'Test a mutation that must be explicitly approved.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string' } }
      },
      requiredCapabilities: ['axis.test.external-mutation'],
      requiredPermissions: ['mcp.invoke.mutate'],
      effect: 'external',
      mutationRisk: 'definite',
      retryOnFailure: 'after-confirmation'
    },
    async execute() {
      mutations += 1;
      return { output: { mutations }, mutationStatus: 'committed' };
    }
  };
  const call = {
    id: 'mutation-1',
    name: mutationTool.definition.name,
    arguments: { value: 'once' }
  };
  const provider = new ScriptedProvider([
    envelope([call]),
    envelope([call]),
    envelope([], 'approved once')
  ]);
  const runtime = runtimeFor(provider, root, { extraTools: [mutationTool] });
  const bridge = new AgentProductExecutionBridge(runtime);
  const jobInput = input(root, 'approval-session');

  const paused = await bridge.executeEngineer(jobInput);
  assert.equal(paused.status, 'needs-guidance');
  assert.equal(mutations, 0);
  assert.ok(bridge.lifecycleEvents('approval-session').some((event) =>
    event.type === 'decision.requested' && event.request.id === 'permission-mutation-1'
  ));

  bridge.resolveAgentDecision('approval-session', {
    requestId: 'permission-mutation-1',
    optionId: 'approve'
  });
  const completed = await bridge.executeEngineer(jobInput);

  assert.equal(completed.status, 'success');
  assert.equal(mutations, 1);
  const lifecycle = bridge.lifecycleEvents('approval-session');
  assert.ok(lifecycle.some((event) =>
    event.type === 'decision.resolved' && event.resolution.requestId === 'permission-mutation-1'
  ));
  assert.equal(lifecycle.filter((event) =>
    event.type === 'tool.result' && event.result.toolName === mutationTool.definition.name && event.result.status === 'success'
  ).length, 1);
});

test('Project Memory from one canonical product session is injected into the next session for the same Company Project and root', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-product-runtime-memory-'));
  const root = path.join(directory, 'repo');
  fs.mkdirSync(root, { recursive: true });
  const memoryStore = new ProjectMemoryStore({ rootDirectory: path.join(directory, 'memory') });
  const provider = new ScriptedProvider([
    envelope([], 'first complete'),
    envelope([], 'second complete')
  ]);
  const runtime = runtimeFor(provider, root, { memoryStore });

  await runtime.executeEngineer(input(
    root,
    'memory-first',
    'chat',
    'Remember this integration decision for the next agent.'
  ));
  await runtime.executeEngineer(input(
    root,
    'memory-second',
    'chat',
    'Continue the integration decision.'
  ));

  const secondPrompt = provider.requests[1]?.systemPrompt ?? '';
  assert.match(secondPrompt, /# STRUCTURED PROJECT HANDOFF/);
  assert.match(secondPrompt, /Previous session: memory-first \(completed\)/);
  assert.match(secondPrompt, /Remember this integration decision for the next agent/);
  assert.match(secondPrompt, /Origin: ollama \/ ollama \/ model-a/);
});

test('projectless Chat stays Personal and requires an exact selected connection and model before composition', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-product-runtime-personal-'));
  const provider = new ScriptedProvider([envelope([], 'personal done')]);
  const connections = new ProviderConnectionRuntime({ localProvider: provider });
  const providers = new ProjectProviderRuntime({ localProvider: provider, connections });
  const now = new Date().toISOString();
  const runtime = new AgentProductRuntime({
    companyContext: () => ({
      version: 1,
      generatedAt: now,
      companies: [{
        id: 'personal', name: 'Personal', color: '#64748B', icon: 'building-2', order: 0,
        createdAt: now, updatedAt: now, kind: 'personal', connectionIds: [], projectIds: [], sessionIds: []
      }],
      sharedConnectionIds: ['ollama']
    }),
    projects: { getProject() { throw new Error('Personal Chat must not resolve a Project.'); } },
    connections,
    providers,
    browserBackend: false
  });

  await assert.rejects(
    runtime.executeEngineer({ workspace: '', goal: 'No implicit model.', interactionMode: 'chat', budgetJobId: 'personal-missing' }),
    /requires an exact selected Connection and model/
  );
  assert.equal(provider.requests.length, 0);

  const completed = await runtime.executeEngineer({
    workspace: '',
    goal: 'Use the exact local model.',
    interactionMode: 'chat',
    budgetJobId: 'personal-explicit',
    modelSelection: { mode: 'explicit', providerId: 'ollama', modelId: 'model-a' }
  });
  assert.equal(completed.status, 'success');
  assert.match(provider.requests[0]?.systemPrompt ?? '', /Company: personal/);
  assert.match(provider.requests[0]?.systemPrompt ?? '', /Project: \(none\)/);
});
