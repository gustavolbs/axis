import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentRuntime,
  negotiateEffectiveCapabilities,
  type AgentLifecycleEvent,
  type AgentProviderAdapter,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentSessionContext,
  type AxisTool,
  type ToolPermissionGate
} from '../src/agent-runtime/index.js';

function session(): AgentSessionContext {
  return {
    sessionId: 'session-decisions',
    companyId: 'acme',
    project: { id: 'project-acme', companyId: 'acme' },
    connection: {
      id: 'connection-test',
      providerFamily: 'test-provider',
      authKind: 'api-key',
      companyId: 'acme'
    },
    modelId: 'model-test',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [{
      id: 'workspace',
      path: '/workspace/acme',
      access: 'write',
      companyId: 'acme',
      projectId: 'project-acme'
    }],
    permissions: {
      default: 'ask',
      entries: { 'workspace.read': 'granted', 'workspace.write': 'ask' }
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{ source: 'axis-test', ids: ['axis.test.read', 'axis.test.write'] }]
    }),
    resources: []
  };
}

class ProviderDecisionAdapter implements AgentProviderAdapter {
  readonly connectionId = 'connection-test';
  readonly providerFamily = 'test-provider';
  readonly modelId = 'model-test';
  readonly capabilities = { streaming: true, toolProtocol: 'native' } as const;

  async invoke(_request: AgentProviderRequest): Promise<AgentProviderResponse> {
    return {
      text: 'I need a decision before continuing.',
      reasoningSummary: 'Two valid implementation paths remain.',
      attachments: [{
        id: 'reference-1',
        kind: 'reference',
        name: 'Architecture note',
        mediaType: 'text/markdown',
        ref: 'axis://architecture/note-1'
      }],
      toolCalls: [],
      decisionRequest: {
        id: 'decision-provider-1',
        kind: 'clarification',
        prompt: 'Which implementation path should be used?',
        options: [
          { id: 'a', label: 'Path A' },
          { id: 'b', label: 'Path B' }
        ]
      },
      stopReason: 'decision_required'
    };
  }
}

class ToolCallAdapter implements AgentProviderAdapter {
  readonly connectionId = 'connection-test';
  readonly providerFamily = 'test-provider';
  readonly modelId = 'model-test';
  readonly capabilities = { streaming: true, toolProtocol: 'native' } as const;

  async invoke(_request: AgentProviderRequest): Promise<AgentProviderResponse> {
    return {
      toolCalls: [{ id: 'write-1', name: 'write_probe', arguments: { value: 'new' } }],
      stopReason: 'tool_calls'
    };
  }
}

const writeTool: AxisTool = {
  definition: {
    name: 'write_probe',
    description: 'A test mutation that must not run before approval.',
    inputSchema: { type: 'object', additionalProperties: false },
    requiredCapabilities: ['axis.test.write'],
    requiredPermissions: ['workspace.write'],
    effect: 'mutation',
    mutationRisk: 'definite',
    retryOnFailure: 'after-confirmation'
  },
  async execute() {
    throw new Error('write_probe must not execute while permission approval is pending');
  }
};

const approvalGate: ToolPermissionGate = {
  async authorize() {
    return {
      allowed: false,
      requiresApproval: true,
      reason: 'workspace.write requires explicit approval.'
    };
  }
};

test('provider decision pauses the turn while preserving summary and attachment metadata', async () => {
  const events: AgentLifecycleEvent[] = [];
  const runtime = new AgentRuntime({ lifecycle: [(event) => events.push(event)] });
  const result = await runtime.run({
    context: session(),
    provider: new ProviderDecisionAdapter(),
    userInput: 'Choose the implementation.',
    attachments: [{
      id: 'input-1',
      kind: 'file',
      name: 'requirements.md',
      mediaType: 'text/markdown',
      ref: 'axis://input/requirements'
    }]
  });

  assert.equal(result.status, 'paused');
  assert.equal(result.turn.status, 'paused');
  assert.equal(result.decisionRequest?.id, 'decision-provider-1');
  assert.equal(result.finalText, 'I need a decision before continuing.');

  const user = result.messages.find((message) => message.role === 'user');
  const assistant = result.messages.find((message) => message.role === 'assistant');
  assert.equal(user?.attachments?.[0]?.name, 'requirements.md');
  assert.equal(assistant?.reasoningSummary, 'Two valid implementation paths remain.');
  assert.equal(assistant?.attachments?.[0]?.ref, 'axis://architecture/note-1');
  assert.equal(assistant?.decisionRequest?.id, 'decision-provider-1');

  assert.ok(events.some((event) => event.type === 'decision.requested' && event.request.id === 'decision-provider-1'));
  assert.ok(events.some((event) => event.type === 'turn.completed' && event.turn.status === 'paused'));
  assert.ok(events.some((event) => event.type === 'session.completed' && event.status === 'paused'));
});

test('permission requiring approval pauses before mutation and emits a canonical decision request', async () => {
  const events: AgentLifecycleEvent[] = [];
  const runtime = new AgentRuntime({
    tools: [writeTool],
    permissionGate: approvalGate,
    lifecycle: [(event) => events.push(event)]
  });

  const result = await runtime.run({
    context: session(),
    provider: new ToolCallAdapter(),
    userInput: 'Change the value.',
    requireToolUse: true
  });

  assert.equal(result.status, 'paused');
  assert.equal(result.toolResults.length, 0);
  assert.equal(result.decisionRequest?.kind, 'permission');
  assert.equal(result.decisionRequest?.metadata?.callId, 'write-1');
  assert.deepEqual(result.decisionRequest?.options?.map((option) => option.id), ['approve', 'deny']);

  assert.ok(events.some((event) => event.type === 'permission.requested' && event.call.id === 'write-1'));
  assert.ok(events.some((event) => event.type === 'decision.requested' && event.call?.id === 'write-1'));
  assert.equal(events.some((event) => event.type === 'tool.result'), false);
  assert.equal(events.some((event) => event.type === 'mutation'), false);
});

test('decision resolution is recorded canonically on the resumed turn input', async () => {
  const events: AgentLifecycleEvent[] = [];
  const runtime = new AgentRuntime({ lifecycle: [(event) => events.push(event)] });
  const resolution = {
    requestId: 'decision-provider-1',
    optionId: 'a',
    text: 'Use Path A.'
  } as const;

  const result = await runtime.run({
    context: session(),
    provider: new ProviderDecisionAdapter(),
    userInput: 'Continue with my choice.',
    decisionResolution: resolution
  });

  const user = result.messages.find((message) => message.role === 'user');
  assert.deepEqual(user?.decisionResolution, resolution);
  assert.ok(events.some((event) =>
    event.type === 'decision.resolved' && event.resolution.requestId === 'decision-provider-1'
  ));
}
