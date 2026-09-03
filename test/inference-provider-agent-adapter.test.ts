import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentRuntime,
  InferenceProviderAgentAdapter,
  negotiateEffectiveCapabilities,
  type AgentSessionContext
} from '../src/agent-runtime/index.js';
import type { InferenceProvider, ProviderCapabilities } from '../src/providers/types.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

function session(): AgentSessionContext {
  return {
    sessionId: 'session-structured-decision',
    companyId: 'acme',
    project: { id: 'project-acme', companyId: 'acme' },
    connection: {
      id: 'api-structured',
      providerFamily: 'openai',
      authKind: 'api-key',
      companyId: 'acme'
    },
    modelId: 'model-test',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'inference-only' },
    roots: [],
    permissions: { default: 'denied', entries: {} },
    capabilities: negotiateEffectiveCapabilities({ offers: [] }),
    resources: []
  };
}

test('structured inference bridge can request a canonical decision even when no Axis tools are registered', async () => {
  let sawStructuredOutput = false;
  const provider: InferenceProvider = {
    id: 'openai',
    kind: 'cloud',
    capabilities,
    async listModels() {
      return [{ providerId: 'openai', id: 'model-test', displayName: 'Test model' }];
    },
    async health() {
      return { providerId: 'openai', ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 0 };
    },
    async invoke(request) {
      sawStructuredOutput = request.output?.type === 'json_schema';
      return {
        providerId: 'openai',
        model: request.model,
        content: JSON.stringify({
          complete: false,
          text: 'I need one choice.',
          reasoningSummary: 'The request is ambiguous between two valid targets.',
          toolCalls: [],
          decisionRequest: {
            id: 'choose-target',
            kind: 'clarification',
            prompt: 'Which target should I use?',
            options: [
              { id: 'a', label: 'Target A' },
              { id: 'b', label: 'Target B' }
            ]
          }
        }),
        latencyMs: 0,
        usage: {}
      };
    }
  };

  const adapter = new InferenceProviderAgentAdapter(provider, {
    connectionId: 'api-structured',
    providerFamily: 'openai',
    modelId: 'model-test',
    providerManagedToolExecution: 'disabled'
  });
  const result = await new AgentRuntime().run({
    context: session(),
    provider: adapter,
    userInput: 'Continue.'
  });

  assert.equal(sawStructuredOutput, true);
  assert.equal(result.status, 'paused');
  assert.equal(result.decisionRequest?.id, 'choose-target');
  assert.equal(result.messages.at(-1)?.reasoningSummary, 'The request is ambiguous between two valid targets.');
});
