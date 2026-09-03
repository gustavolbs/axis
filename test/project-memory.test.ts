import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { AgentLifecycleEvent, AgentSessionContext } from '../src/agent-runtime/index.js';
import {
  createProjectMemoryLifecycleSink,
  loadProjectMemoryContext,
  projectMemoryRootBindings,
  ProjectMemoryStore
} from '../src/project-memory/index.js';

function session(input: {
  sessionId: string;
  root: string;
  companyId?: string;
  projectId?: string;
  connectionId?: string;
  providerFamily?: string;
  authKind?: AgentSessionContext['connection']['authKind'];
  modelId?: string;
}): AgentSessionContext {
  const companyId = input.companyId ?? 'company-a';
  const projectId = input.projectId ?? 'project-a';
  return {
    sessionId: input.sessionId,
    companyId,
    project: { id: projectId, companyId },
    connection: {
      id: input.connectionId ?? 'connection-a',
      providerFamily: input.providerFamily ?? 'openai',
      authKind: input.authKind ?? 'api-key',
      companyId
    },
    modelId: input.modelId ?? 'model-a',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [{ id: 'workspace', path: input.root, access: 'write', companyId, projectId }],
    permissions: { default: 'denied', entries: {} },
    capabilities: { entries: {} },
    resources: []
  };
}

type LifecyclePayload = AgentLifecycleEvent extends infer Event
  ? Event extends AgentLifecycleEvent
    ? Omit<Event, 'id' | 'sequence' | 'timestamp' | 'sessionId'>
    : never
  : never;

function emitter(recorder: ReturnType<typeof createProjectMemoryLifecycleSink>, context: AgentSessionContext) {
  let sequence = 0;
  const at = (offset: number) => new Date(Date.UTC(2026, 8, 3, 12, 0, offset)).toISOString();
  return (payload: LifecyclePayload) => {
    recorder.observe({
      ...payload,
      id: `${context.sessionId}-${++sequence}`,
      sequence,
      timestamp: at(sequence),
      sessionId: context.sessionId
    } as AgentLifecycleEvent);
  };
}

function start(
  recorder: ReturnType<typeof createProjectMemoryLifecycleSink>,
  context: AgentSessionContext
) {
  const emit = emitter(recorder, context);
  emit({ type: 'session.started', context });
  return emit;
}

test('different providers and sessions share one Project Memory scope', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-memory-provider-'));
  const root = path.join(directory, 'repo');
  fs.mkdirSync(root);
  const store = new ProjectMemoryStore({ rootDirectory: path.join(directory, 'memory') });
  const recorder = createProjectMemoryLifecycleSink(store);
  const first = session({
    sessionId: 'openai-session', root, connectionId: 'openai-api', providerFamily: 'openai', authKind: 'api-key'
  });
  const emit = start(recorder, first);
  emit({
    type: 'user.input',
    message: { id: 'user-1', role: 'user', content: 'Implement the project memory lifecycle handoff.' }
  });
  emit({
    type: 'read', callId: 'read-1', toolName: 'read_file', status: 'success', detail: 'Read memory architecture.',
    metadata: { rootId: 'workspace', relativePath: 'docs/PROJECT_MEMORY.md' }
  });
  emit({
    type: 'session.completed', status: 'completed'
  });

  const second = session({
    sessionId: 'claude-session', root, connectionId: 'claude-account', providerFamily: 'anthropic', authKind: 'claude-account', modelId: 'claude-test'
  });
  const context = await loadProjectMemoryContext({
    store,
    session: second,
    task: 'Continue the project memory lifecycle handoff.'
  });

  assert.ok(context);
  if (!context) throw new Error('Expected Project Memory context.');
  assert.equal(context.entries.length, 1);
  assert.equal(context.entries[0]?.handoff?.sessionId, 'openai-session');
  assert.equal(context.entries[0]?.handoff?.origin.providerFamily, 'openai');
  assert.match(context.capsule, /Implement the project memory lifecycle handoff/);
  assert.doesNotMatch(context.capsule, /claude-account.*memory ownership/i);
});

test('same physical root is isolated across Companies and Projects', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-memory-isolation-'));
  const root = path.join(directory, 'repo');
  fs.mkdirSync(root);
  const store = new ProjectMemoryStore({ rootDirectory: path.join(directory, 'memory') });
  const recorder = createProjectMemoryLifecycleSink(store);
  const source = session({ sessionId: 'source', root, companyId: 'company-a', projectId: 'project-a' });
  const emit = start(recorder, source);
  emit({ type: 'user.input', message: { id: 'u', role: 'user', content: 'Company A Project A private handoff.' } });
  emit({ type: 'session.completed', status: 'completed' });

  const companyB = await loadProjectMemoryContext({
    store,
    session: session({ sessionId: 'company-b-session', root, companyId: 'company-b', projectId: 'project-a' }),
    task: 'private handoff'
  });
  const projectB = await loadProjectMemoryContext({
    store,
    session: session({ sessionId: 'project-b-session', root, companyId: 'company-a', projectId: 'project-b' }),
    task: 'private handoff'
  });

  assert.equal(companyB?.entries[0]?.handoff, undefined);
  assert.equal(projectB?.entries[0]?.handoff, undefined);
  assert.doesNotMatch(companyB?.capsule ?? '', /Company A Project A private handoff/);
  assert.doesNotMatch(projectB?.capsule ?? '', /Company A Project A private handoff/);
});

test('multi-root sessions keep root-scoped repository activity separated', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-memory-roots-'));
  const rootA = path.join(directory, 'repo-a');
  const rootB = path.join(directory, 'repo-b');
  fs.mkdirSync(rootA);
  fs.mkdirSync(rootB);
  const companyId = 'company-a';
  const projectId = 'project-a';
  const current: AgentSessionContext = {
    ...session({ sessionId: 'multi-root-session', root: rootA, companyId, projectId }),
    roots: [
      { id: 'root-a', path: rootA, access: 'write', companyId, projectId },
      { id: 'root-b', path: rootB, access: 'write', companyId, projectId }
    ]
  };
  const store = new ProjectMemoryStore({ rootDirectory: path.join(directory, 'memory') });
  const recorder = createProjectMemoryLifecycleSink(store);
  const emit = start(recorder, current);
  emit({ type: 'user.input', message: { id: 'u', role: 'user', content: 'Inspect both roots, but change only root A.' } });
  emit({ type: 'tool.call', call: { id: 'm-a', name: 'write_file', arguments: { rootId: 'root-a' } } });
  emit({
    type: 'mutation', callId: 'm-a', toolName: 'write_file', status: 'success', mutationStatus: 'committed',
    metadata: { rootId: 'root-a', relativePath: 'src/a.ts' }
  });
  emit({ type: 'session.completed', status: 'completed' });

  const reader: AgentSessionContext = { ...current, sessionId: 'reader' };
  const contextA = await loadProjectMemoryContext({ store, session: reader, task: 'change root A', rootId: 'root-a' });
  const contextB = await loadProjectMemoryContext({ store, session: reader, task: 'change root A', rootId: 'root-b' });

  assert.deepEqual(contextA?.entries[0]?.handoff?.changedFiles, ['src/a.ts']);
  assert.deepEqual(contextB?.entries[0]?.handoff?.changedFiles, []);
});

test('lifecycle events produce a bounded structured handoff and survive restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-memory-lifecycle-'));
  const root = path.join(directory, 'repo');
  fs.mkdirSync(root);
  const memoryRoot = path.join(directory, 'memory');
  const firstStore = new ProjectMemoryStore({ rootDirectory: memoryRoot });
  const recorder = createProjectMemoryLifecycleSink(firstStore);
  const current = session({ sessionId: 'handoff-session', root });
  const emit = start(recorder, current);

  emit({ type: 'turn.started', turn: { id: 'turn-1', index: 0, startedAt: '2026-09-03T12:00:00.000Z', status: 'running', toolCallCount: 0 } });
  emit({ type: 'user.input', message: { id: 'user', role: 'user', content: 'Implement structured handoff.' } });
  emit({ type: 'tool.call', call: { id: 'read-call', name: 'read_file', arguments: { rootId: 'workspace', path: 'src/a.ts' } } });
  emit({ type: 'tool.result', result: { callId: 'read-call', toolName: 'read_file', status: 'success', output: 'not persisted', mutationStatus: 'not-applicable', durationMs: 3, metadata: { rootId: 'workspace' } } });
  emit({ type: 'read', callId: 'read-call', toolName: 'read_file', status: 'success', detail: 'Inspected source.', metadata: { rootId: 'workspace', relativePath: 'src/a.ts' } });
  emit({ type: 'mutation', callId: 'write-call', toolName: 'write_file', status: 'success', mutationStatus: 'committed', detail: 'Updated implementation.', metadata: { rootId: 'workspace', relativePath: 'src/a.ts', branch: 'feat/runtime-project-memory', worktree: '/tmp/worktree-a' } });
  emit({ type: 'command', callId: 'command-call', toolName: 'exec', status: 'success', mutationStatus: 'not-applicable', detail: 'npm test', metadata: { rootId: 'workspace' } });
  emit({ type: 'validation', callId: 'validation-call', toolName: 'exec', status: 'success', detail: 'npm test', metadata: { rootId: 'workspace' } });
  emit({ type: 'decision.requested', request: { id: 'decision-1', kind: 'clarification', prompt: 'Should the follow-up retain the current branch?' } });
  emit({ type: 'turn.completed', turn: { id: 'turn-1', index: 0, startedAt: '2026-09-03T12:00:00.000Z', completedAt: '2026-09-03T12:01:00.000Z', status: 'paused', toolCallCount: 2, finalText: 'Implementation is ready for the next validation step.' } });
  emit({ type: 'session.completed', status: 'paused' });

  const restartedStore = new ProjectMemoryStore({ rootDirectory: memoryRoot });
  const nextSession = session({ sessionId: 'next-session', root, providerFamily: 'anthropic', connectionId: 'claude' });
  const context = await loadProjectMemoryContext({ store: restartedStore, session: nextSession, task: 'structured handoff validation' });
  const handoff = context?.entries[0]?.handoff;

  assert.ok(handoff);
  if (!handoff) throw new Error('Expected structured handoff.');
  assert.equal(handoff.status, 'paused');
  assert.equal(handoff.goal, 'Implement structured handoff.');
  assert.equal(handoff.branch, 'feat/runtime-project-memory');
  assert.equal(handoff.worktree, '/tmp/worktree-a');
  assert.deepEqual(handoff.activeFiles, ['src/a.ts']);
  assert.deepEqual(handoff.changedFiles, ['src/a.ts']);
  assert.match(handoff.investigationSummary, /Inspected 1 read operation/);
  assert.deepEqual(handoff.validations, ['success — npm test']);
  assert.deepEqual(handoff.openQuestions, ['Should the follow-up retain the current branch?']);
  assert.match(handoff.nextStep, /Resolve the pending decision/);
  assert.match(context?.capsule ?? '', /Current repository source\/tests are authoritative/);
});

test('redaction strips secrets and raw reasoning while retaining safe operational context', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-memory-redaction-'));
  const root = path.join(directory, 'repo');
  fs.mkdirSync(root);
  const store = new ProjectMemoryStore({ rootDirectory: path.join(directory, 'memory') });
  const recorder = createProjectMemoryLifecycleSink(store);
  const current = session({ sessionId: 'secret-session', root });
  const emit = start(recorder, current);
  const privateReasoning = 'RAW_PRIVATE_CHAIN_OF_THOUGHT_DO_NOT_STORE';
  const apiKey = 'sk-live-this-should-never-persist-123456';
  const bearer = 'Bearer very-secret-token-value';

  emit({
    type: 'user.input',
    message: {
      id: 'user', role: 'user', content: `Use api_key=${apiKey} but only remember the safe task.`, reasoningSummary: privateReasoning
    }
  });
  emit({
    type: 'tool.call',
    call: { id: 'secret-call', name: 'exec', arguments: { rootId: 'workspace', password: 'tool-argument-secret', command: `curl -H '${bearer}'` } }
  });
  emit({
    type: 'tool.result',
    result: {
      callId: 'secret-call', toolName: 'exec', status: 'success', mutationStatus: 'not-applicable', durationMs: 1,
      output: { chainOfThought: privateReasoning, secret: 'tool-result-secret' },
      metadata: { rootId: 'workspace', chainOfThought: privateReasoning, authorization: bearer }
    }
  });
  emit({
    type: 'command', callId: 'secret-call', toolName: 'exec', status: 'success', mutationStatus: 'not-applicable',
    detail: `deploy --token super-secret-cli-token`, metadata: { rootId: 'workspace', chainOfThought: privateReasoning }
  });
  emit({ type: 'session.completed', status: 'completed' });

  const scope = projectMemoryRootBindings(current)[0]!.scope;
  const serialized = fs.readFileSync(store.fileForScope(scope), 'utf8');
  assert.doesNotMatch(serialized, /RAW_PRIVATE_CHAIN_OF_THOUGHT_DO_NOT_STORE/);
  assert.doesNotMatch(serialized, /sk-live-this-should-never-persist/);
  assert.doesNotMatch(serialized, /super-secret-cli-token/);
  assert.doesNotMatch(serialized, /tool-argument-secret|tool-result-secret|very-secret-token-value/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /only remember the safe task/);
});

test('errors and cancellation are retained with explicit session state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-memory-errors-'));
  const root = path.join(directory, 'repo');
  fs.mkdirSync(root);
  const store = new ProjectMemoryStore({ rootDirectory: path.join(directory, 'memory') });
  const recorder = createProjectMemoryLifecycleSink(store);

  const failed = session({ sessionId: 'failed-session', root });
  const fail = start(recorder, failed);
  fail({ type: 'user.input', message: { id: 'u1', role: 'user', content: 'Try the failing approach.' } });
  fail({ type: 'error', error: { kind: 'tool', code: 'validation_failed', message: 'Tests failed in src/a.ts.', retry: 'never' }, toolName: 'exec', callId: 'v1' });
  fail({ type: 'session.completed', status: 'failed' });

  const cancelled = session({ sessionId: 'cancelled-session', root });
  const cancel = start(recorder, cancelled);
  cancel({ type: 'user.input', message: { id: 'u2', role: 'user', content: 'Try the cancelled approach.' } });
  cancel({ type: 'cancelled', source: 'tool', callId: 'c1', toolName: 'exec' });
  cancel({ type: 'session.completed', status: 'cancelled' });

  const scope = projectMemoryRootBindings(cancelled)[0]!.scope;
  const document = store.read(scope);
  assert.equal(document.sessions.find((item) => item.sessionId === 'failed-session')?.status, 'failed');
  assert.equal(document.sessions.find((item) => item.sessionId === 'cancelled-session')?.status, 'cancelled');
  assert.equal(document.sessions.find((item) => item.sessionId === 'cancelled-session')?.cancellations[0]?.source, 'tool');

  const retrieval = await loadProjectMemoryContext({
    store,
    session: session({ sessionId: 'reader', root }),
    task: 'failing approach tests'
  });
  assert.match(retrieval?.entries[0]?.handoff?.failedAttempts.join(' ') ?? '', /validation_failed/);
});

test('retention compacts old sessions instead of growing as a transcript dump', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-memory-retention-'));
  const root = path.join(directory, 'repo');
  fs.mkdirSync(root);
  const store = new ProjectMemoryStore({
    rootDirectory: path.join(directory, 'memory'),
    retention: { maxSessions: 2 }
  });
  const recorder = createProjectMemoryLifecycleSink(store);

  for (let index = 1; index <= 3; index += 1) {
    const current = session({ sessionId: `session-${index}`, root });
    const emit = start(recorder, current);
    emit({ type: 'user.input', message: { id: `u-${index}`, role: 'user', content: `Goal ${index}` } });
    emit({ type: 'mutation', callId: `m-${index}`, toolName: 'write_file', status: 'success', mutationStatus: 'committed', metadata: { rootId: 'workspace', relativePath: `src/${index}.ts` } });
    emit({ type: 'session.completed', status: 'completed' });
  }

  const scope = projectMemoryRootBindings(session({ sessionId: 'reader', root }))[0]!.scope;
  const document = store.read(scope);
  assert.equal(document.sessions.length, 2);
  assert.equal(document.compaction.sessionCount, 1);
  assert.ok(document.compaction.changedFiles.includes('src/1.ts'));
  assert.ok(document.compaction.recentGoals.includes('Goal 1'));
});

test('retention never compacts an active or paused session to make room for completed history', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-memory-live-retention-'));
  const root = path.join(directory, 'repo');
  fs.mkdirSync(root);
  const store = new ProjectMemoryStore({
    rootDirectory: path.join(directory, 'memory'),
    retention: { maxSessions: 1 }
  });
  const recorder = createProjectMemoryLifecycleSink(store);

  const active = session({ sessionId: 'active-session', root });
  const activeEmit = start(recorder, active);
  activeEmit({ type: 'user.input', message: { id: 'active-user', role: 'user', content: 'Keep this active session.' } });

  const completed = session({ sessionId: 'completed-session', root });
  const completedEmit = start(recorder, completed);
  completedEmit({ type: 'user.input', message: { id: 'completed-user', role: 'user', content: 'Compact this completed session.' } });
  completedEmit({ type: 'session.completed', status: 'completed' });

  const scope = projectMemoryRootBindings(active)[0]!.scope;
  const document = store.read(scope);
  assert.equal(document.sessions.length, 1);
  assert.equal(document.sessions[0]?.sessionId, 'active-session');
  assert.equal(document.sessions[0]?.status, 'active');
  assert.equal(document.compaction.sessionCount, 1);
  assert.ok(document.compaction.recentGoals.includes('Compact this completed session.'));
});
