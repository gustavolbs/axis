import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentRuntime,
  compactAgentTranscript,
  measureAgentContext,
  type AgentLifecycleEvent,
  type AgentMessage,
  type AgentProviderAdapter,
  type AgentProviderRequest,
  type AgentSessionContext
} from '../src/agent-runtime/index.js';

function context(): AgentSessionContext {
  return {
    sessionId: 'context-session', companyId: 'company-a',
    connection: { id: 'provider', providerFamily: 'test', authKind: 'local', companyId: null },
    modelId: 'model', executionTarget: { id: 'desktop', kind: 'desktop', mode: 'inference-only' },
    roots: [], permissions: { default: 'denied', entries: {} }, capabilities: { entries: {} }, resources: []
  };
}

test('compaction preserves current turn, decisions and errors while bounding older transcript detail', () => {
  const messages: AgentMessage[] = [
    { id: 'u1', role: 'user', content: `old request ${'x'.repeat(4_000)}` },
    { id: 'a1', role: 'assistant', content: `old response ${'y'.repeat(4_000)}` },
    { id: 'decision', role: 'assistant', content: 'approval', decisionRequest: { id: 'd1', kind: 'permission', prompt: 'Approve?' } },
    { id: 'resolution', role: 'user', content: 'approved', decisionResolution: { requestId: 'd1', optionId: 'approve' } },
    { id: 'u2', role: 'user', content: 'current request' },
    { id: 'tool', role: 'tool', content: 'current tool state', toolCallId: 'c1', toolName: 'read_file' }
  ];
  const result = compactAgentTranscript(messages, 2_000, true);
  assert.equal(result.compacted, true);
  assert.ok(result.after.bytes < result.before.bytes);
  assert.ok(result.messages.some((message) => message.id === 'decision'));
  assert.ok(result.messages.some((message) => message.id === 'resolution'));
  assert.ok(result.messages.some((message) => message.id === 'u2'));
  assert.ok(result.messages.some((message) => message.id === 'tool'));
  assert.match(result.messages[0]?.content ?? '', /Axis compacted/);
});

test('AgentRuntime automatically sends a compacted projection but retains the durable full transcript', async () => {
  const transcript: AgentMessage[] = Array.from({ length: 12 }, (_, index) => ({
    id: `old-${index}`, role: index % 2 ? 'assistant' : 'user', content: `${index}:${'z'.repeat(1_000)}`
  }));
  let providerBytes = 0;
  const provider: AgentProviderAdapter = {
    connectionId: 'provider', providerFamily: 'test', modelId: 'model',
    capabilities: { streaming: false, toolProtocol: 'none' },
    async invoke(request: AgentProviderRequest) {
      providerBytes = measureAgentContext(request.messages).bytes;
      return { text: 'done', toolCalls: [], stopReason: 'complete' };
    }
  };
  const events: AgentLifecycleEvent[] = [];
  const result = await new AgentRuntime({ lifecycle: [(event) => events.push(event)] }).run({
    context: context(), provider, transcript, userInput: 'latest', limits: { maxContextBytes: 3_000 }
  });
  assert.equal(result.status, 'completed');
  assert.ok(providerBytes <= 3_000);
  assert.equal(result.messages.length, transcript.length + 2, 'full transcript plus current user/assistant stays durable');
  assert.ok(events.some((event) => event.type === 'context.compacted'));
});
