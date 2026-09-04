import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InferenceProviderAgentAdapter,
  type AgentProviderRequest
} from '../src/agent-runtime/index.js';
import {
  AXIS_AGENT_TURN_SCHEMA,
  parseStructuredAgentResponse
} from '../src/agent-provider-adapters/structured-protocol.js';
import type {
  InferenceProvider,
  InferenceRequest,
  ProviderCapabilities
} from '../src/providers/types.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: true
};

function assertStrictObjectSchemas(value: unknown, path = '$'): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  const type = schema.type;
  const objectType = type === 'object' || (Array.isArray(type) && type.includes('object'));
  if (objectType) {
    const properties = schema.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      const propertyNames = Object.keys(properties as Record<string, unknown>).sort();
      assert.deepEqual(
        Array.isArray(schema.required) ? [...schema.required].sort() : schema.required,
        propertyNames,
        `${path} must require every declared property`
      );
      assert.equal(schema.additionalProperties, false, `${path} must be closed`);
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
        assertStrictObjectSchemas(child, `${path}.properties.${name}`);
      }
    }
  }
  if (schema.items) assertStrictObjectSchemas(schema.items, `${path}.items`);
}

function request(): AgentProviderRequest {
  return {
    context: {
      sessionId: 'schema-test',
      companyId: 'personal',
      connection: {
        id: 'openai-test',
        providerFamily: 'openai',
        authKind: 'api-key',
        companyId: 'personal'
      },
      modelId: 'gpt-test',
      executionTarget: { id: 'desktop', kind: 'desktop', mode: 'inference-only' },
      roots: [],
      permissions: { default: 'denied', entries: {} },
      capabilities: { entries: {} },
      resources: []
    },
    turnId: 'turn-1',
    systemPrompt: 'Follow the Axis runtime protocol.',
    messages: [{ id: 'user-1', role: 'user', content: 'Use the probe tool.' }],
    tools: [{
      name: 'probe',
      description: 'Probe the strict wire format.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string' } }
      },
      requiredCapabilities: [],
      requiredPermissions: [],
      effect: 'read',
      mutationRisk: 'none',
      retryOnFailure: 'safe'
    }],
    timeoutMs: 5_000
  };
}

test('native Account strict schema requires every property and closes every object', () => {
  assertStrictObjectSchemas(AXIS_AGENT_TURN_SCHEMA);
});

test('direct provider strict schema is OpenAI-compatible and decodes JSON tool arguments', async () => {
  let captured: InferenceRequest | undefined;
  const provider: InferenceProvider = {
    id: 'openai',
    kind: 'cloud',
    capabilities,
    async listModels() {
      return [{ providerId: 'openai', id: 'gpt-test', displayName: 'GPT Test' }];
    },
    async health() {
      return { providerId: 'openai', ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 0 };
    },
    async invoke(input) {
      captured = input;
      return {
        providerId: 'openai',
        model: input.model,
        content: JSON.stringify({
          complete: false,
          text: null,
          reasoningSummary: null,
          decisionRequest: null,
          toolCalls: [{ id: null, name: 'probe', arguments: JSON.stringify({ value: 'ok' }) }]
        }),
        stopReason: 'tool_calls',
        latencyMs: 0,
        usage: {}
      };
    }
  };
  const adapter = new InferenceProviderAgentAdapter(provider, {
    connectionId: 'openai-test',
    providerFamily: 'openai',
    modelId: 'gpt-test',
    providerManagedToolExecution: 'disabled'
  });

  const response = await adapter.invoke(request(), {
    signal: new AbortController().signal,
    reportProgress() {}
  });

  assert.equal(captured?.output?.type, 'json_schema');
  if (captured?.output?.type !== 'json_schema') throw new Error('Expected strict JSON schema output.');
  assertStrictObjectSchemas(captured.output.schema);
  assert.deepEqual(response.toolCalls[0]?.arguments, { value: 'ok' });
});

test('native Account parser accepts the same nullable envelope and JSON tool argument wire format', () => {
  const parsed = parseStructuredAgentResponse(
    request(),
    JSON.stringify({
      complete: false,
      text: null,
      reasoningSummary: null,
      decisionRequest: null,
      toolCalls: [{ id: null, name: 'probe', arguments: JSON.stringify({ value: 'account' }) }]
    })
  );

  assert.deepEqual(parsed.toolCalls[0]?.arguments, { value: 'account' });
  assert.equal(parsed.decisionRequest, undefined);
});
