import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAnthropicApiKeyAgentAdapter,
  type AgentProviderBinding
} from '../src/agent-provider-adapters/index.js';
import type {
  AgentProviderRequest,
  AgentSessionContext,
  ToolDefinition
} from '../src/agent-runtime/index.js';
import type {
  InferenceProvider,
  ProviderCapabilities
} from '../src/providers/types.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: true,
  toolUse: true
};

const binding: AgentProviderBinding = {
  connectionId: 'anthropic-api-primary',
  providerFamily: 'anthropic',
  modelId: 'claude-haiku-4-5-20251001',
  companyId: 'acme'
};

const context: AgentSessionContext = {
  sessionId: 'session-anthropic-api',
  companyId: 'acme',
  project: { id: 'project-acme', companyId: 'acme' },
  connection: {
    id: binding.connectionId,
    providerFamily: 'anthropic',
    authKind: 'api-key',
    companyId: 'acme'
  },
  modelId: binding.modelId,
  executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
  roots: [],
  permissions: { default: 'denied', entries: {} },
  capabilities: { entries: {} },
  resources: []
};

const probeTool: ToolDefinition = {
  name: 'probe_context',
  description: 'Return a test payload.',
  inputSchema: { type: 'object', additionalProperties: true },
  requiredCapabilities: [],
  requiredPermissions: [],
  effect: 'read',
  mutationRisk: 'none',
  retryOnFailure: 'safe'
};

function assertAnthropicObjectsClosed(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) assertAnthropicObjectsClosed(child);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (record.type === 'object') {
    assert.equal(
      record.additionalProperties,
      false,
      'Anthropic structured-output object schemas must set additionalProperties=false'
    );
  }
  for (const child of Object.values(record)) assertAnthropicObjectsClosed(child);
}

test('Anthropic API-key adapter closes the Axis agent schema without losing tool arguments', async () => {
  let sentSchema: Record<string, unknown> | undefined;
  let sentSystemPrompt = '';
  const provider: InferenceProvider = {
    id: 'anthropic',
    kind: 'cloud',
    capabilities,
    async listModels() {
      return [{
        providerId: 'anthropic',
        id: binding.modelId,
        displayName: 'Claude Haiku 4.5'
      }];
    },
    async health() {
      return {
        providerId: 'anthropic',
        ok: true,
        checkedAt: new Date(0).toISOString(),
        latencyMs: 0
      };
    },
    async invoke(request) {
      assert.equal(request.output?.type, 'json_schema');
      if (request.output?.type === 'json_schema') sentSchema = request.output.schema;
      sentSystemPrompt = request.systemPrompt;
      return {
        providerId: 'anthropic',
        model: request.model,
        content: JSON.stringify({
          complete: false,
          toolCalls: [{
            id: 'probe-1',
            name: 'probe_context',
            arguments: JSON.stringify({ provider: 'anthropic', nested: { ok: true } })
          }]
        }),
        stopReason: 'tool_calls',
        latencyMs: 0,
        usage: {}
      };
    }
  };

  const adapter = createAnthropicApiKeyAgentAdapter(provider, binding);
  const request: AgentProviderRequest = {
    context,
    turnId: 'turn-1',
    systemPrompt: 'Follow the Axis runtime protocol.',
    messages: [{ id: 'message-1', role: 'user', content: 'Inspect the context.' }],
    tools: [probeTool],
    timeoutMs: 5_000
  };
  const abort = new AbortController();
  const response = await adapter.invoke(request, {
    signal: abort.signal,
    reportProgress: () => undefined
  });

  assert.ok(sentSchema);
  assertAnthropicObjectsClosed(sentSchema);
  const schemaProperties = sentSchema.properties as Record<string, unknown>;
  const toolCallsSchema = schemaProperties.toolCalls as Record<string, unknown>;
  const itemSchema = toolCallsSchema.items as Record<string, unknown>;
  const itemProperties = itemSchema.properties as Record<string, unknown>;
  assert.deepEqual(itemProperties.arguments, {
    type: 'string',
    description: 'JSON-encoded object containing the exact arguments for the selected Axis tool.'
  });
  assert.match(sentSystemPrompt, /encode toolCalls\[\]\.arguments as a JSON object serialized into a string/);

  assert.equal(response.stopReason, 'tool_calls');
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.name, 'probe_context');
  assert.deepEqual(response.toolCalls[0]?.arguments, {
    provider: 'anthropic',
    nested: { ok: true }
  });
});
