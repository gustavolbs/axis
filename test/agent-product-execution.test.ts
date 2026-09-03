import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  AgentDecisionResolution,
  AgentLifecycleEvent
} from '../src/agent-runtime/index.js';
import { AgentProductExecutionBridge } from '../src/agent-product-execution.js';
import type { AgentProductRuntime } from '../src/agent-product-runtime.js';
import type { LocalEngineerResult } from '../src/local-engineer.js';
import type { ProjectEngineerInput } from '../src/project-engineer-backend.js';

class FakeProductRuntime {
  private listener?: (event: AgentLifecycleEvent) => void;
  readonly resolutions: AgentDecisionResolution[] = [];

  subscribeAgentLifecycle(listener: (event: AgentLifecycleEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  emit(event: AgentLifecycleEvent): void {
    this.listener?.(event);
  }

  resolveAgentDecision(_sessionId: string, resolution: AgentDecisionResolution): void {
    this.resolutions.push(resolution);
  }

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    return {
      status: 'success',
      phase: 'complete',
      workspace: input.workspace,
      goal: input.goal,
      summary: 'done',
      investigation: { searchQueries: [], evidenceFiles: [], researchRequests: [] },
      repairRounds: 0,
      changedFiles: [],
      diff: '',
      validation: [],
      modelCalls: []
    };
  }
}

function decisionEvent(options: readonly { id: string; label: string }[]): AgentLifecycleEvent {
  return {
    id: 'event-1',
    sequence: 1,
    timestamp: '2026-09-03T18:00:00.000Z',
    sessionId: 'session-1',
    turnId: 'turn-1',
    type: 'decision.requested',
    request: {
      id: 'decision-1',
      kind: 'clarification',
      prompt: 'Choose or answer directly.',
      options
    }
  };
}

function input(userGuidance: string): ProjectEngineerInput {
  return {
    workspace: '/tmp/project',
    goal: 'Continue.',
    budgetJobId: 'session-1',
    userGuidance
  };
}

test('product bridge preserves a known decision option as optionId', async () => {
  const runtime = new FakeProductRuntime();
  const bridge = new AgentProductExecutionBridge(runtime as unknown as AgentProductRuntime);
  runtime.emit(decisionEvent([{ id: 'approve', label: 'Approve' }]));

  await bridge.executeEngineer(input('- decision-1: approve'));

  assert.deepEqual(runtime.resolutions, [{ requestId: 'decision-1', optionId: 'approve' }]);
});

test('product bridge preserves a multi-word free-text decision as text', async () => {
  const runtime = new FakeProductRuntime();
  const bridge = new AgentProductExecutionBridge(runtime as unknown as AgentProductRuntime);
  runtime.emit(decisionEvent([{ id: 'option-a', label: 'Option A' }]));

  await bridge.executeEngineer(input('- decision-1: Use the safer migration path'));

  assert.deepEqual(runtime.resolutions, [{
    requestId: 'decision-1',
    text: 'Use the safer migration path'
  }]);
});
