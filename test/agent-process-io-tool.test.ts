import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  negotiateEffectiveCapabilities,
  type AgentSessionContext,
  type AxisTool,
  type ToolExecutionContext
} from '../src/agent-runtime/index.js';
import {
  ManagedProcessRegistry,
  PROCESS_EXEC_CAPABILITY,
  PROCESS_EXEC_PERMISSION,
  ProcessSignalTool,
  ProcessStartTool,
  ProcessStdinTool,
  ProcessWaitTool,
  type BackgroundProcessOutput
} from '../src/agent-tools/process/index.js';

function session(root: string): AgentSessionContext {
  const companyId = 'io-company';
  const projectId = 'io-project';
  return {
    sessionId: 'io-session',
    companyId,
    project: { id: projectId, companyId },
    connection: {
      id: 'io-connection',
      providerFamily: 'anthropic',
      authKind: 'claude-account',
      companyId
    },
    modelId: 'io-model',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [{ id: 'workspace', path: root, access: 'write', companyId, projectId }],
    permissions: { default: 'denied', entries: { [PROCESS_EXEC_PERMISSION]: 'granted' } },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{ source: 'io-test', ids: [PROCESS_EXEC_CAPABILITY] }]
    }),
    resources: []
  };
}

function context(
  tool: AxisTool,
  owner: AgentSessionContext,
  args: Record<string, unknown>
): ToolExecutionContext {
  return {
    session: owner,
    call: { id: `call-${tool.definition.name}`, name: tool.definition.name, arguments: args },
    signal: new AbortController().signal,
    reportProgress: () => {},
    reportActivity: () => {}
  };
}

function output(value: unknown): BackgroundProcessOutput {
  return value as BackgroundProcessOutput;
}

function startArgs(source: string): Record<string, unknown> {
  return {
    command: 'node',
    args: ['--input-type=commonjs', '-e', source],
    rootId: 'workspace',
    cwd: '.',
    mutation: 'workspace'
  };
}

test('process_stdin writes bounded input and can close stdin before wait', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-process-stdin-'));
  const owner = session(root);
  const registry = new ManagedProcessRegistry({ killGraceMs: 20 });
  const start = new ProcessStartTool({ registry });
  const stdin = new ProcessStdinTool(registry);
  const wait = new ProcessWaitTool(registry);
  let processId = '';

  try {
    const source = [
      "process.stdin.setEncoding('utf8');",
      "let value = '';",
      "process.stdin.on('data', chunk => { value += chunk; });",
      "process.stdin.on('end', () => { process.stdout.write(value.toUpperCase()); });"
    ].join(' ');
    const started = output((await start.execute(context(start, owner, startArgs(source)))).output);
    processId = started.processId;
    assert.equal(started.stdinOpen, true);

    const afterInput = output((await stdin.execute(context(stdin, owner, {
      processId,
      data: 'hello from axis',
      end: true
    }))).output);
    assert.equal(afterInput.stdinOpen, false);
    assert.equal(afterInput.processMutationStatus, 'started');

    const finished = output((await wait.execute(context(wait, owner, { processId }))).output);
    assert.equal(finished.status, 'exited');
    assert.equal(finished.exitCode, 0);
    assert.equal(finished.stdout, 'HELLO FROM AXIS');
    assert.equal(finished.processMutationStatus, 'committed');
  } finally {
    if (processId) await registry.terminate(owner, processId).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('process_signal sends only an explicit allowed signal to the owned process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-process-signal-'));
  const owner = session(root);
  const registry = new ManagedProcessRegistry({ killGraceMs: 20 });
  const start = new ProcessStartTool({ registry });
  const signal = new ProcessSignalTool(registry);
  const wait = new ProcessWaitTool(registry);
  let processId = '';

  try {
    const started = output((await start.execute(context(
      start,
      owner,
      startArgs('setInterval(() => {}, 1000);')
    ))).output);
    processId = started.processId;

    const signalled = output((await signal.execute(context(signal, owner, {
      processId,
      signal: 'SIGTERM'
    }))).output);
    assert.equal(signalled.processId, processId);

    const finished = output((await wait.execute(context(wait, owner, { processId }))).output);
    assert.equal(finished.status, 'exited');
    assert.equal(finished.processMutationStatus, 'unknown');

    await assert.rejects(
      () => signal.execute(context(signal, owner, { processId, signal: 'SIGKILL' })),
      /not allowed/
    );
  } finally {
    if (processId) await registry.terminate(owner, processId).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
