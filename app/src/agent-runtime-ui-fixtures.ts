import type {
  AgentLifecycleEvent,
  AgentTurn,
  ToolCall,
  ToolDefinition
} from '../../src/agent-runtime/contracts.js';

const sessionId = 'runtime-ui-fixture-session';
const turnId = 'runtime-ui-fixture-turn';
const startedAt = '2026-09-03T18:00:00.000Z';

function lifecycleBase(sequence: number) {
  return {
    id: `runtime-ui-${sequence}`,
    sequence,
    timestamp: `2026-09-03T18:00:${String(sequence).padStart(2, '0')}.000Z`,
    sessionId,
    turnId
  } as const;
}

const runningTurn: AgentTurn = {
  id: turnId,
  index: 0,
  startedAt,
  status: 'running',
  toolCallCount: 3
};

const readCall: ToolCall = {
  id: 'call-read',
  name: 'axis.filesystem.read',
  arguments: { path: 'src/agent-runtime/index.ts' }
};

const readDefinition: ToolDefinition = {
  name: readCall.name,
  description: 'Read a file inside the scoped project root.',
  inputSchema: {},
  requiredCapabilities: ['axis.filesystem.read'],
  requiredPermissions: ['filesystem.read'],
  effect: 'read',
  mutationRisk: 'none',
  retryOnFailure: 'safe'
};

const commandCall: ToolCall = {
  id: 'call-command',
  name: 'axis.process.exec',
  arguments: { argv: ['npm', 'test'], cwd: '/project' }
};

const mutationCall: ToolCall = {
  id: 'call-mutation',
  name: 'axis.filesystem.write',
  arguments: { path: 'app/src/example.tsx' }
};

export const runtimeUiActiveEvents = [
  {
    ...lifecycleBase(1),
    type: 'turn.started',
    turn: runningTurn
  },
  {
    ...lifecycleBase(2),
    type: 'user.input',
    message: {
      id: 'message-with-attachments',
      role: 'user',
      content: 'Inspect the runtime and prepare the UI.',
      attachments: [
        {
          id: 'attachment-1',
          kind: 'file',
          name: 'runtime-notes.md',
          mediaType: 'text/markdown',
          sizeBytes: 18432,
          ref: 'fixture://runtime-notes.md',
          metadata: { source: 'fixture' }
        },
        {
          id: 'attachment-2',
          kind: 'image',
          name: 'reference.png',
          mediaType: 'image/png',
          sizeBytes: 483120,
          ref: 'fixture://reference.png'
        }
      ]
    }
  },
  {
    ...lifecycleBase(3),
    type: 'provider.started',
    connectionId: 'connection-account-2',
    modelId: 'model-code-large'
  },
  {
    ...lifecycleBase(4),
    type: 'provider.progress',
    progress: {
      phase: 'provider',
      state: 'reasoning',
      message: 'Planning the implementation',
      completed: 2,
      total: 4,
      metadata: { elapsedMs: 830 }
    }
  },
  {
    ...lifecycleBase(5),
    type: 'tool.call',
    call: readCall,
    definition: readDefinition
  },
  {
    ...lifecycleBase(6),
    type: 'tool.progress',
    callId: readCall.id,
    toolName: readCall.name,
    progress: {
      message: 'Reading scoped source',
      completed: 8,
      total: 12,
      metadata: { rootId: 'project-root' }
    }
  },
  {
    ...lifecycleBase(7),
    type: 'read',
    callId: readCall.id,
    toolName: readCall.name,
    status: 'success',
    detail: 'src/agent-runtime/index.ts · 142 lines',
    metadata: { path: 'src/agent-runtime/index.ts' }
  },
  {
    ...lifecycleBase(8),
    type: 'permission.requested',
    call: commandCall,
    permissions: ['process.execute', 'workspace.read']
  },
  {
    ...lifecycleBase(9),
    type: 'decision.requested',
    request: {
      id: 'decision-runtime-ui',
      kind: 'confirmation',
      prompt: 'Apply the proposed changes to the project files?',
      options: [
        { id: 'apply', label: 'Apply changes', description: 'Write the prepared edits in the scoped project.' },
        { id: 'review', label: 'Review first', description: 'Keep the turn paused and show the planned edits.' }
      ],
      metadata: { scope: 'project' }
    },
    call: mutationCall
  }
] satisfies readonly AgentLifecycleEvent[];

export const runtimeUiOutcomeEvents = [
  {
    ...lifecycleBase(10),
    type: 'permission.resolved',
    callId: commandCall.id,
    allowed: true,
    reason: 'Approved for this turn'
  },
  {
    ...lifecycleBase(11),
    type: 'decision.resolved',
    resolution: {
      requestId: 'decision-runtime-ui',
      optionId: 'apply'
    }
  },
  {
    ...lifecycleBase(12),
    type: 'mutation',
    callId: mutationCall.id,
    toolName: mutationCall.name,
    status: 'success',
    mutationStatus: 'committed',
    detail: 'app/src/example.tsx updated',
    metadata: { path: 'app/src/example.tsx', bytesWritten: 912 }
  },
  {
    ...lifecycleBase(13),
    type: 'command',
    callId: commandCall.id,
    toolName: commandCall.name,
    status: 'success',
    mutationStatus: 'not-applicable',
    detail: 'npm test · exit 0',
    metadata: { exitCode: 0, durationMs: 1820 }
  },
  {
    ...lifecycleBase(14),
    type: 'validation',
    callId: 'call-validation',
    toolName: 'axis.process.exec',
    status: 'success',
    detail: 'Typecheck and tests passed',
    metadata: { checks: ['typecheck', 'tests'] }
  },
  {
    ...lifecycleBase(15),
    type: 'provider.completed',
    stopReason: 'end_turn',
    toolCallCount: 3
  },
  {
    ...lifecycleBase(16),
    type: 'turn.completed',
    turn: {
      ...runningTurn,
      completedAt: '2026-09-03T18:00:16.000Z',
      status: 'completed',
      finalText: 'Runtime UI prepared.'
    }
  },
  {
    ...lifecycleBase(17),
    type: 'session.completed',
    status: 'completed'
  }
] satisfies readonly AgentLifecycleEvent[];

export const runtimeUiFailureEvents = [
  {
    ...lifecycleBase(18),
    type: 'error',
    callId: 'call-browser',
    toolName: 'axis.browser.read',
    error: {
      kind: 'timeout',
      code: 'browser_timeout',
      message: 'The browser operation exceeded the configured timeout while preserving the current session.',
      retry: 'safe',
      details: { timeoutMs: 15000 }
    }
  },
  {
    ...lifecycleBase(19),
    type: 'cancelled',
    source: 'caller',
    callId: 'call-process-cancelled',
    toolName: 'axis.process.exec'
  },
  {
    ...lifecycleBase(20),
    type: 'turn.completed',
    turn: {
      ...runningTurn,
      completedAt: '2026-09-03T18:00:20.000Z',
      status: 'paused',
      decisionRequest: {
        id: 'decision-paused',
        kind: 'clarification',
        prompt: 'Choose the target before continuing.'
      }
    }
  },
  {
    ...lifecycleBase(21),
    type: 'session.completed',
    status: 'paused'
  }
] satisfies readonly AgentLifecycleEvent[];

export const runtimeUiAllEvents: readonly AgentLifecycleEvent[] = [
  ...runtimeUiActiveEvents,
  ...runtimeUiOutcomeEvents,
  ...runtimeUiFailureEvents
];
