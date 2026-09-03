import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { OperationCancelledError } from '../src/cancellation.js';
import {
  negotiateEffectiveCapabilities,
  type AgentSessionContext,
  type AxisTool,
  type ToolExecutionContext,
  type ToolExecutionOutput
} from '../src/agent-runtime/index.js';
import {
  ManagedProcessRegistry,
  PROCESS_EXEC_CAPABILITY,
  PROCESS_EXEC_PERMISSION,
  ProcessListTool,
  ProcessPollTool,
  ProcessStartTool,
  ProcessTerminateTool,
  ProcessWaitTool,
  ProcessWhichTool,
  resolveProcessExecutable,
  type BackgroundProcessOutput
} from '../src/agent-tools/process/index.js';

function session(root: string, id = 'primary'): AgentSessionContext {
  const companyId = 'background-company';
  const projectId = 'background-project';
  return {
    sessionId: `background-session-${id}`,
    companyId,
    project: { id: projectId, companyId },
    connection: {
      id: `background-connection-${id}`,
      providerFamily: 'openai',
      authKind: 'api-key',
      companyId
    },
    modelId: 'background-model',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [{
      id: 'workspace',
      path: root,
      access: 'write',
      companyId,
      projectId
    }],
    permissions: {
      default: 'denied',
      entries: { [PROCESS_EXEC_PERMISSION]: 'granted' }
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{ source: 'background-test', ids: [PROCESS_EXEC_CAPABILITY] }]
    }),
    resources: []
  };
}

async function tempWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'axis-background-process-'));
}

function toolContext(
  tool: AxisTool,
  sessionContext: AgentSessionContext,
  args: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal
): ToolExecutionContext {
  return {
    session: sessionContext,
    call: { id: `call-${tool.definition.name}`, name: tool.definition.name, arguments: args },
    signal,
    reportProgress: () => {},
    reportActivity: () => {}
  };
}

async function execute(
  tool: AxisTool,
  sessionContext: AgentSessionContext,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolExecutionOutput> {
  return await tool.execute(toolContext(tool, sessionContext, args, signal));
}

function backgroundOutput(value: unknown): BackgroundProcessOutput {
  return value as BackgroundProcessOutput;
}

function startInput(source: string): Record<string, unknown> {
  return {
    command: 'node',
    args: ['--input-type=commonjs', '-e', source],
    rootId: 'workspace',
    cwd: '.',
    mutation: 'workspace'
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

async function waitForOutput(
  poll: ProcessPollTool,
  owner: AgentSessionContext,
  processId: string,
  pattern: RegExp
): Promise<BackgroundProcessOutput> {
  const started = Date.now();
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let combined = '';
  while (Date.now() - started < 3_000) {
    const result = await execute(poll, owner, { processId, stdoutOffset, stderrOffset });
    const output = backgroundOutput(result.output);
    combined += output.stdout;
    stdoutOffset = output.nextStdoutOffset;
    stderrOffset = output.nextStderrOffset;
    if (pattern.test(combined)) return { ...output, stdout: combined };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for output matching ${String(pattern)}.`);
}

test('background process can be started, incrementally polled, listed and terminated by id', async () => {
  const root = await tempWorkspace();
  const registry = new ManagedProcessRegistry({ killGraceMs: 20 });
  const start = new ProcessStartTool({ registry });
  const poll = new ProcessPollTool(registry);
  const terminate = new ProcessTerminateTool(registry);
  const list = new ProcessListTool(registry);
  const owner = session(root);
  let processId = '';
  let descendantPid = 0;

  const source = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['--input-type=commonjs', '-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
    "process.stdout.write('child:' + child.pid + '\\n');",
    "setTimeout(() => process.stdout.write('ready\\n'), 40);",
    'setInterval(() => {}, 1000);'
  ].join(' ');

  try {
    const started = await execute(start, owner, startInput(source));
    const initial = backgroundOutput(started.output);
    processId = initial.processId;
    assert.equal(initial.status, 'running');
    assert.equal(initial.executionTargetId, 'desktop');
    assert.equal(initial.processMutationStatus, 'started');
    assert.ok(initial.pid > 0);

    const streamed = await waitForOutput(poll, owner, processId, /ready/);
    const match = /child:(\d+)/.exec(streamed.stdout);
    assert.ok(match);
    descendantPid = Number(match[1]);
    assert.equal(processIsAlive(descendantPid), true);
    assert.match(streamed.stdout, /ready/);
    assert.ok(streamed.nextStdoutOffset > 0);

    const listed = await execute(list, owner, {});
    const processes = listed.output as BackgroundProcessOutput[];
    assert.equal(processes.length, 1);
    assert.equal(processes[0]?.processId, processId);
    assert.equal(processes[0]?.stdout, '');

    const stopped = backgroundOutput((await execute(terminate, owner, { processId })).output);
    assert.equal(stopped.status, 'terminated');
    assert.equal(stopped.processMutationStatus, 'unknown');
    assert.equal(processIsAlive(descendantPid), false);
  } finally {
    if (processId) await registry.terminate(owner, processId).catch(() => undefined);
    if (descendantPid && processIsAlive(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('background process ids are inaccessible from another immutable session', async () => {
  const root = await tempWorkspace();
  const registry = new ManagedProcessRegistry({ killGraceMs: 20 });
  const start = new ProcessStartTool({ registry });
  const poll = new ProcessPollTool(registry);
  const primary = session(root, 'primary');
  const other = session(root, 'other');
  let processId = '';

  try {
    const started = await execute(start, primary, startInput('setInterval(() => {}, 1000);'));
    processId = backgroundOutput(started.output).processId;
    await assert.rejects(
      () => execute(poll, other, { processId }),
      /not owned by this immutable Axis session/
    );
  } finally {
    if (processId) await registry.terminate(primary, processId).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('process_wait reports clean completion and final mutation status', async () => {
  const root = await tempWorkspace();
  const registry = new ManagedProcessRegistry();
  const start = new ProcessStartTool({ registry });
  const wait = new ProcessWaitTool(registry);
  const owner = session(root);

  try {
    const started = backgroundOutput((await execute(
      start,
      owner,
      startInput("setTimeout(() => { process.stdout.write('complete'); }, 30);")
    )).output);
    const result = await execute(wait, owner, { processId: started.processId });
    const finished = backgroundOutput(result.output);
    assert.equal(finished.status, 'exited');
    assert.equal(finished.exitCode, 0);
    assert.equal(finished.stdout, 'complete');
    assert.equal(finished.processMutationStatus, 'committed');
    assert.equal(result.mutationStatus, 'committed');
  } finally {
    await registry.terminateSession(owner.sessionId);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cancelling a wait does not kill the background process', async () => {
  const root = await tempWorkspace();
  const registry = new ManagedProcessRegistry({ killGraceMs: 20 });
  const start = new ProcessStartTool({ registry });
  const wait = new ProcessWaitTool(registry);
  const owner = session(root);
  let processId = '';
  let pid = 0;

  try {
    const started = backgroundOutput((await execute(
      start,
      owner,
      startInput('setInterval(() => {}, 1000);')
    )).output);
    processId = started.processId;
    pid = started.pid;

    await assert.rejects(
      () => execute(wait, owner, { processId }, AbortSignal.timeout(50)),
      (error) => error instanceof OperationCancelledError
    );
    const stillRunning = registry.snapshotFor(owner, processId);
    assert.equal(stillRunning.status, 'running');
    assert.equal(processIsAlive(pid), true);
  } finally {
    if (processId) await registry.terminate(owner, processId).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bounded background logs expose cursor gaps instead of silently losing output', async () => {
  const root = await tempWorkspace();
  const registry = new ManagedProcessRegistry({ outputLimitBytes: 32 });
  const start = new ProcessStartTool({ registry });
  const wait = new ProcessWaitTool(registry);
  const owner = session(root);

  try {
    const started = backgroundOutput((await execute(
      start,
      owner,
      startInput("process.stdout.write('x'.repeat(256));")
    )).output);
    const finished = backgroundOutput((await execute(wait, owner, {
      processId: started.processId,
      stdoutOffset: 0,
      stderrOffset: 0
    })).output);
    assert.equal(finished.status, 'exited');
    assert.equal(finished.stdout.length, 32);
    assert.equal(finished.stdoutTruncatedBeforeCursor, true);
    assert.ok(finished.stdoutRetainedFromOffset > 0);
    assert.equal(finished.nextStdoutOffset, 256);
  } finally {
    await registry.terminateSession(owner.sessionId);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('terminateSession provides the cancellation hook needed by future runtime composition', async () => {
  const root = await tempWorkspace();
  const registry = new ManagedProcessRegistry({ killGraceMs: 20 });
  const start = new ProcessStartTool({ registry });
  const owner = session(root);

  try {
    const first = backgroundOutput((await execute(start, owner, startInput('setInterval(() => {}, 1000);'))).output);
    const second = backgroundOutput((await execute(start, owner, startInput('setInterval(() => {}, 1000);'))).output);
    assert.equal(processIsAlive(first.pid), true);
    assert.equal(processIsAlive(second.pid), true);

    assert.equal(await registry.terminateSession(owner.sessionId), 2);
    assert.equal(processIsAlive(first.pid), false);
    assert.equal(processIsAlive(second.pid), false);
    assert.equal(registry.snapshotFor(owner, first.processId).status, 'terminated');
    assert.equal(registry.snapshotFor(owner, second.processId).status, 'terminated');
  } finally {
    await registry.terminateSession(owner.sessionId);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('process_which resolves the exact Axis PATH without shell fallback', async () => {
  const nodeDirectory = path.dirname(process.execPath);
  const environment: NodeJS.ProcessEnv = {
    PATH: nodeDirectory,
    Path: nodeDirectory,
    PATHEXT: process.env.PATHEXT,
    COMSPEC: process.env.COMSPEC,
    SHELL: process.env.SHELL
  };
  const resolution = await resolveProcessExecutable('node', environment);
  assert.equal(resolution.found, true);
  assert.equal(resolution.requiresShell, false);
  assert.ok(resolution.executablePath);
  assert.match(path.basename(resolution.executablePath ?? ''), /^node(?:\.exe)?$/i);

  const missing = await resolveProcessExecutable('axis-definitely-missing-binary', environment);
  assert.equal(missing.found, false);
  assert.match(missing.diagnostic, /not found on the PATH visible to Axis/);

  const root = await tempWorkspace();
  try {
    const which = new ProcessWhichTool({ environment });
    const result = await execute(which, session(root), { command: 'node' });
    assert.equal((result.output as { found: boolean }).found, true);
    assert.equal(which.definition.effect, 'read');
    assert.equal(which.definition.mutationRisk, 'none');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
