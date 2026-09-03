import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  AgentRuntime,
  PROVIDER_CAPABILITY_IDS,
  negotiateEffectiveCapabilities,
  type AgentRunInput,
  type AgentSessionContext,
  type AxisTool
} from '../src/agent-runtime/index.js';
import {
  CODEX_ACCOUNT_AGENT_BLOCKER,
  ClaudeAccountAgentAdapter,
  createChatGptAccountAgentAdapter,
  createOllamaAgentAdapter,
  createOpenAiApiKeyAgentAdapter,
  providerCapabilityOffer,
  type AgentProviderBinding
} from '../src/agent-provider-adapters/index.js';
import { ClaudeAccountProfileStore } from '../src/claude-account-profiles.js';
import type {
  InferenceProvider,
  ProviderCapabilities
} from '../src/providers/types.js';

const fullProviderCapabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: true,
  toolUse: true
};

const fixture = path.join(process.cwd(), 'test', 'fixtures', 'fake-claude-agent.mjs');

function binding(input: Partial<AgentProviderBinding> = {}): AgentProviderBinding {
  return {
    connectionId: input.connectionId ?? 'openai-api-primary',
    providerFamily: input.providerFamily ?? 'openai',
    modelId: input.modelId ?? 'model-test',
    companyId: input.companyId === undefined ? 'acme' : input.companyId
  };
}

function context(input: {
  companyId?: string;
  connectionId?: string;
  connectionCompanyId?: string | null;
  providerFamily?: string;
  authKind?: AgentSessionContext['connection']['authKind'];
  modelId?: string;
  providerCapabilities?: ProviderCapabilities;
} = {}): AgentSessionContext {
  const companyId = input.companyId ?? 'acme';
  const connectionId = input.connectionId ?? 'openai-api-primary';
  const providerFamily = input.providerFamily ?? 'openai';
  const modelId = input.modelId ?? 'model-test';
  const connectionCompanyId = input.connectionCompanyId === undefined
    ? companyId
    : input.connectionCompanyId;
  const providerOffer = providerCapabilityOffer({
    connectionId,
    providerFamily,
    modelId,
    companyId: connectionCompanyId
  }, input.providerCapabilities ?? fullProviderCapabilities);
  return {
    sessionId: `session-${companyId}-${connectionId}`,
    companyId,
    project: { id: `project-${companyId}`, companyId },
    connection: {
      id: connectionId,
      providerFamily,
      authKind: input.authKind ?? 'api-key',
      companyId: connectionCompanyId
    },
    modelId,
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [{
      id: 'workspace',
      path: `/workspace/${companyId}`,
      access: 'write',
      companyId,
      projectId: `project-${companyId}`
    }],
    permissions: {
      default: 'denied',
      entries: { 'workspace.read': 'granted' }
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [
        { source: 'axis-test', ids: ['axis.test.read'] },
        providerOffer
      ]
    }),
    resources: []
  };
}

const probeTool: AxisTool = {
  definition: {
    name: 'probe_context',
    description: 'Return the exact canonical session context seen by the tool.',
    inputSchema: { type: 'object', additionalProperties: true },
    requiredCapabilities: ['axis.test.read'],
    requiredPermissions: ['workspace.read'],
    effect: 'read',
    mutationRisk: 'none',
    retryOnFailure: 'safe'
  },
  async execute(execution) {
    return {
      output: {
        companyId: execution.session.companyId,
        connectionId: execution.session.connection.id,
        authKind: execution.session.connection.authKind,
        arguments: execution.call.arguments
      }
    };
  }
};

function fakeOpenAiProvider(mode: 'normal' | 'hidden-tool' = 'normal'): InferenceProvider {
  return {
    id: 'openai',
    kind: 'cloud',
    capabilities: fullProviderCapabilities,
    async listModels() {
      return [{ providerId: 'openai', id: 'model-test', displayName: 'Test model' }];
    },
    async health() {
      return { providerId: 'openai', ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 0 };
    },
    async invoke(request) {
      const hasToolResult = request.userPrompt.includes('"role":"tool"');
      const content = mode === 'hidden-tool'
        ? { complete: false, toolCalls: [{ id: 'hidden-1', name: 'provider.hidden', arguments: {} }] }
        : hasToolResult
          ? { complete: true, text: 'openai:done', toolCalls: [] }
          : { complete: false, toolCalls: [{ id: 'openai-probe', name: 'probe_context', arguments: { provider: 'openai' } }] };
      request.onProgress?.({
        providerId: 'openai',
        model: request.model,
        state: 'generating',
        timestamp: new Date(0).toISOString(),
        eventCount: 1,
        outputChars: JSON.stringify(content).length
      });
      return {
        providerId: 'openai',
        model: request.model,
        content: JSON.stringify(content),
        stopReason: hasToolResult ? 'complete' : 'tool_calls',
        latencyMs: 0,
        usage: {}
      };
    }
  };
}

function claudeHarness(companyId = 'acme'): {
  root: string;
  adapter: ClaudeAccountAgentAdapter;
  session: AgentSessionContext;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-native-adapter-test-'));
  const profiles = new ClaudeAccountProfileStore(root);
  profiles.create({ id: 'team', name: 'Team Claude', organizationLabel: companyId });
  const claudeBinding = binding({
    connectionId: 'claude-account-team',
    providerFamily: 'anthropic',
    modelId: 'sonnet',
    companyId
  });
  return {
    root,
    adapter: new ClaudeAccountAgentAdapter({
      profiles,
      profileId: 'team',
      binding: claudeBinding,
      claudeBinary: process.execPath,
      commandPrefixArgs: [fixture],
      baseEnv: process.env
    }),
    session: context({
      companyId,
      connectionId: claudeBinding.connectionId,
      providerFamily: 'anthropic',
      authKind: 'claude-account',
      modelId: 'sonnet'
    })
  };
}

function runInput(
  session: AgentSessionContext,
  provider: AgentRunInput['provider'],
  userInput = 'Inspect the canonical project context.'
): AgentRunInput {
  return {
    context: session,
    provider,
    userInput,
    systemPrompt: 'Follow the Axis runtime protocol.',
    requireToolUse: true
  };
}

test('OpenAI API Key and Claude Account use the same AgentRuntime tool contract across real provider families', async () => {
  const runtime = new AgentRuntime({ tools: [probeTool] });
  const openaiBinding = binding();
  const openai = createOpenAiApiKeyAgentAdapter(fakeOpenAiProvider(), openaiBinding);
  const openaiSession = context({
    connectionId: openaiBinding.connectionId,
    providerFamily: 'openai',
    authKind: 'api-key',
    modelId: openaiBinding.modelId
  });
  const claude = claudeHarness();

  try {
    const apiResult = await runtime.run(runInput(openaiSession, openai));
    const accountResult = await runtime.run(runInput(claude.session, claude.adapter));

    assert.equal(apiResult.status, 'completed');
    assert.equal(accountResult.status, 'completed');
    assert.equal(apiResult.finalText, 'openai:done');
    assert.equal(accountResult.finalText, 'claude:done');
    assert.equal(apiResult.toolResults[0]?.toolName, 'probe_context');
    assert.equal(accountResult.toolResults[0]?.toolName, 'probe_context');
    assert.equal((apiResult.toolResults[0]?.output as { authKind: string }).authKind, 'api-key');
    assert.equal((accountResult.toolResults[0]?.output as { authKind: string }).authKind, 'claude-account');
    assert.equal((accountResult.toolResults[0]?.output as { companyId: string }).companyId, 'acme');
  } finally {
    fs.rmSync(claude.root, { recursive: true, force: true });
  }
});

test('provider capability negotiation uses only frozen taxonomy and honors model overrides', () => {
  const offered = providerCapabilityOffer(binding(), fullProviderCapabilities, {
    capabilities: { promptCaching: false, toolUse: false }
  });
  assert.deepEqual(offered.ids, [
    PROVIDER_CAPABILITY_IDS.modelDiscovery,
    PROVIDER_CAPABILITY_IDS.streaming,
    PROVIDER_CAPABILITY_IDS.structuredOutput,
    PROVIDER_CAPABILITY_IDS.reasoning
  ]);
});

test('direct adapter refuses hidden tool calls before Axis dispatch', async () => {
  const runtime = new AgentRuntime({ tools: [probeTool] });
  const adapter = createOpenAiApiKeyAgentAdapter(fakeOpenAiProvider('hidden-tool'), binding());
  const result = await runtime.run(runInput(context(), adapter));

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.kind, 'protocol');
  assert.match(result.error?.message ?? '', /hidden or unavailable Axis tool provider\.hidden/);
  assert.equal(result.toolResults.length, 0);
});

test('Claude Account refuses hidden tool calls and provider model fallback', async () => {
  const runtime = new AgentRuntime({ tools: [probeTool] });
  const claude = claudeHarness();
  try {
    const hidden = await runtime.run(runInput(claude.session, claude.adapter, 'SCENARIO_HIDDEN_TOOL'));
    assert.equal(hidden.status, 'failed');
    assert.equal(hidden.error?.kind, 'protocol');
    assert.match(hidden.error?.message ?? '', /hidden or unavailable Axis tool provider\.hidden/);

    const wrongModel = await runtime.run(runInput(claude.session, claude.adapter, 'SCENARIO_WRONG_MODEL'));
    assert.equal(wrongModel.status, 'failed');
    assert.equal(wrongModel.error?.kind, 'protocol');
    assert.match(wrongModel.error?.message ?? '', /will not accept provider fallback/);
  } finally {
    fs.rmSync(claude.root, { recursive: true, force: true });
  }
});

test('Claude Account propagates cancellation and provider errors through canonical runtime failures', async () => {
  const runtime = new AgentRuntime({ tools: [probeTool] });
  const claude = claudeHarness();
  try {
    const abort = new AbortController();
    const pending = runtime.run({
      ...runInput(claude.session, claude.adapter, 'SCENARIO_CANCEL'),
      signal: abort.signal
    });
    setTimeout(() => abort.abort(), 50);
    const cancelled = await pending;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.error?.kind, 'cancelled');

    const failed = await runtime.run(runInput(claude.session, claude.adapter, 'SCENARIO_PROVIDER_ERROR'));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.kind, 'provider');
    assert.equal(failed.error?.code, 'claude_account_error');
    assert.match(failed.error?.message ?? '', /fixture provider failure/);
  } finally {
    fs.rmSync(claude.root, { recursive: true, force: true });
  }
});

test('adapter preserves exact Company ownership even when runtime identity fields otherwise match', async () => {
  const runtime = new AgentRuntime({ tools: [probeTool] });
  const adapter = createOpenAiApiKeyAgentAdapter(fakeOpenAiProvider(), binding({ companyId: 'acme' }));
  const otherCompany = context({ companyId: 'other' });

  const result = await runtime.run(runInput(otherCompany, adapter));
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.kind, 'protocol');
  assert.match(result.error?.message ?? '', /belongs to Company acme/);
});

test('Ollama direct adapter stays Company-shared and never invents provider tool-use capability', () => {
  const ollamaCapabilities: ProviderCapabilities = {
    ...fullProviderCapabilities,
    promptCaching: false,
    toolUse: false
  };
  const provider: InferenceProvider = {
    ...fakeOpenAiProvider(),
    id: 'ollama',
    kind: 'local',
    capabilities: ollamaCapabilities
  };
  const ollamaBinding = binding({
    connectionId: 'ollama-local',
    providerFamily: 'ollama',
    modelId: 'qwen3',
    companyId: null
  });
  const adapter = createOllamaAgentAdapter(provider, ollamaBinding);
  const offer = providerCapabilityOffer(ollamaBinding, ollamaCapabilities);

  assert.equal(adapter.connectionId, 'ollama-local');
  assert.equal(adapter.providerFamily, 'ollama');
  assert.ok(!offer.ids.includes(PROVIDER_CAPABILITY_IDS.toolUse));
  assert.throws(
    () => createOllamaAgentAdapter(provider, { ...ollamaBinding, companyId: 'acme' }),
    /shared local connection/
  );
});

test('ChatGPT/Codex Account remains fail-closed until every provider-managed core tool can be intercepted', () => {
  assert.throws(
    () => createChatGptAccountAgentAdapter(),
    (error) => error instanceof Error && error.message === CODEX_ACCOUNT_AGENT_BLOCKER
  );
  assert.match(CODEX_ACCOUNT_AGENT_BLOCKER, /apply_patch/);
  assert.match(CODEX_ACCOUNT_AGENT_BLOCKER, /intercept tool calls before execution/);
});
