import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { OperationCancelledError } from '../src/cancellation.js';
import {
  AgentRuntime,
  negotiateEffectiveCapabilities,
  type AgentExecutionTarget,
  type AgentLifecycleEvent,
  type AgentProviderAdapter,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentSessionContext,
  type AxisTool,
  type ToolExecutionContext,
  type ToolExecutionOutput
} from '../src/agent-runtime/index.js';
import {
  PROCESS_EXEC_CAPABILITY,
  PROCESS_EXEC_PERMISSION,
  PROCESS_EXEC_TOOL_NAME,
  ProcessExecTool,
  runProcess,
  sanitizeProcessEnvironment,
  type ProcessExecInput,
  type ProcessExecOutput
} from '../src/agent-tools/process/index.js';

interface SessionOptions {
  providerFamily?: string;
  connectionId?: string;
  authKind?: AgentSessionContext['connection']['authKind'];
  targetId?: string;
  targetKind?: AgentSessionContext['executionTarget']['kind'];
  targetMode?: AgentSessionContext['executionTarget']['mode'];
  permission?: 'granted' | 'denied' | 'ask';
  rootAccess?: 'read' | 'write';
}

function session(root: string, options: SessionOptions = {}): AgentSessionContext {
  const companyId = 'process-company';
  const projectId = 'process-project';
  return {
    sessionId: `session-${options.connectionId ?? 'primary'}`,
    companyId,
    project: { id: projectId, companyId },
    connection: {
      id: options.connectionId ?? 'process-connection',
      providerFamily: options.providerFamily ?? 'openai',
      authKind: options.authKind ?? 'api-key',
      companyId
    },
    modelId: 'process-model',
    executionTarget: {
      id: options.targetId ?? 'desktop',
      kind: options.targetKind ?? 'desktop',
      mode: options.targetMode ?? 'workspace'
    },
    roots: [{
      id: 'workspace',
      path: root,
      access: options.rootAccess ?? 'write',
      companyId,
      projectId
    }],
    permissions: {
      default: 'denied',
      entries: { [PROCESS_EXEC_PERMISSION]: options.permission ?? 'granted' }
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{ source: 'axis-process-test', ids: [PROCESS_EXEC_CAPABILITY] }]
    }),
    resources: []
  };
}

class ScriptedProcessAdapter implements AgentProviderAdapter {
  readonly capabilities = { streaming: false, toolProtocol: 'native' } as const;
  readonly requests: AgentProviderRequest[] = [];

  constructor(
    readonly connectionId: string,
    readonly providerFamily: string,
    readonly modelId: string,
    private readonly toolArguments: ProcessExecInput
  ) {}

  async invoke(request: AgentProviderRequest): Promise<AgentProviderResponse> {
    this.requests.push(request);
    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    if (!hasToolResult) {
      return {
        toolCalls: [{
          id: `call-${this.connectionId}`,
          name: PROCESS_EXEC_TOOL_NAME,
          arguments: this.toolArguments
        }],
        stopReason: 'tool_calls'
      };
    }
    return { text: 'done', toolCalls: [], stopReason: 'complete' };
  }
}

class RecordingExecutionTarget implements AgentExecutionTarget {
  calls = 0;

  constructor(readonly id: string) {}

  async execute(tool: AxisTool, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    this.calls += 1;
    return await tool.execute(context);
  }
}

async function tempWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'axis-process-'));
}

async function runTool(input: {
  root: string;
  call: ProcessExecInput;
  tool?: ProcessExecTool;
  session?: AgentSessionContext;
  providerFamily?: string;
  connectionId?: string;
  authKind?: AgentSessionContext['connection']['authKind'];
  events?: AgentLifecycleEvent[];
  executionTargets?: readonly AgentExecutionTarget[];
  signal?: AbortSignal;
}) {
  const providerFamily = input.providerFamily ?? 'openai';
  const connectionId = input.connectionId ?? 'process-connection';
  const context = input.session ?? session(input.root, {
    providerFamily,
    connectionId,
    authKind: input.authKind
  });
  const provider = new ScriptedProcessAdapter(
    connectionId,
    providerFamily,
    'process-model',
    input.call
  );
  const runtime = new AgentRuntime({
    tools: [input.tool ?? new ProcessExecTool()],
    executionTargets: input.executionTargets,
    lifecycle: input.events ? [(event) => input.events?.push(event)] : []
  });
  const result = await runtime.run({
    context,
    provider,
    userInput: 'Run the requested engineering command.',
    requireToolUse: true,
    signal: input.signal
  });
  return { result, provider };
}

function processOutput(value: unknown): ProcessExecOutput {
  return value as ProcessExecOutput;
}

function nodeEval(source: string): ProcessExecInput {
  return {
    command: 'node',
    args: ['--input-type=commonjs', '-e', source],
    rootId: 'workspace',
    cwd: '.',
    mutation: 'workspace'
  };
}

test('process_exec captures stdout, stderr and successful exit code with command lifecycle', async () => {
  const root = await tempWorkspace();
  try {
    const events: AgentLifecycleEvent[] = [];
    const { result } = await runTool({
      root,
      events,
      call: nodeEval("process.stdout.write('hello'); process.stderr.write('warning');")
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.toolResults[0]?.status, 'success');
    assert.equal(result.toolResults[0]?.mutationStatus, 'committed');
    const output = processOutput(result.toolResults[0]?.output);
    assert.equal(output.exitCode, 0);
    assert.equal(output.stdout, 'hello');
    assert.equal(output.stderr, 'warning');
    assert.equal(output.executionTargetId, 'desktop');
    assert.ok(events.some((event) =>
      event.type === 'command' &&
      event.toolName === PROCESS_EXEC_TOOL_NAME &&
      event.detail?.includes('node')
    ));
    assert.ok(events.some((event) =>
      event.type === 'command' &&
      event.toolName === PROCESS_EXEC_TOOL_NAME &&
      event.mutationStatus === 'committed'
    ));
    assert.ok(events.some((event) => event.type === 'tool.progress'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('non-zero process exit remains an observable command result with uncertain mutation status', async () => {
  const root = await tempWorkspace();
  try {
    const { result } = await runTool({ root, call: nodeEval("process.stderr.write('nope'); process.exit(7);") });
    assert.equal(result.status, 'completed');
    assert.equal(result.toolResults[0]?.status, 'success');
    assert.equal(result.toolResults[0]?.mutationStatus, 'unknown');
    const output = processOutput(result.toolResults[0]?.output);
    assert.equal(output.exitCode, 7);
    assert.equal(output.stderr, 'nope');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime timeout aborts the process and preserves canonical timeout/mutation safety', async () => {
  const root = await tempWorkspace();
  try {
    const tool = new ProcessExecTool({ timeoutMs: 100, killGraceMs: 20 });
    const { result } = await runTool({
      root,
      tool,
      call: nodeEval('setInterval(() => {}, 1000);')
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.toolResults[0]?.status, 'error');
    assert.equal(result.toolResults[0]?.error?.kind, 'timeout');
    assert.equal(result.toolResults[0]?.error?.code, 'tool_timeout');
    assert.equal(result.toolResults[0]?.mutationStatus, 'unknown');
    assert.equal(result.toolResults[0]?.error?.retry, 'after-confirmation');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

test('cancellation terminates the spawned process tree', async () => {
  const root = await tempWorkspace();
  const controller = new AbortController();
  let descendantPid = 0;
  let streamed = '';
  let resolvePid: ((pid: number) => void) | undefined;
  const pidReady = new Promise<number>((resolve) => { resolvePid = resolve; });
  const sanitized = sanitizeProcessEnvironment(process.env);
  const source = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['--input-type=commonjs', '-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
    "process.stdout.write('child:' + child.pid + '\\n');",
    'setInterval(() => {}, 1000);'
  ].join(' ');

  const running = runProcess({
    command: 'node',
    args: ['--input-type=commonjs', '-e', source],
    cwd: root,
    env: sanitized.env,
    signal: controller.signal,
    killGraceMs: 20,
    onOutput: ({ stream, chunk }) => {
      if (stream !== 'stdout') return;
      streamed += chunk;
      const match = /child:(\d+)/.exec(streamed);
      if (match && resolvePid) {
        resolvePid(Number(match[1]));
        resolvePid = undefined;
      }
    }
  });

  try {
    descendantPid = await Promise.race([
      pidReady,
      new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error('descendant pid timeout')), 2_000))
    ]);
    assert.equal(processIsAlive(descendantPid), true);
    controller.abort();
    await assert.rejects(running, (error) => error instanceof OperationCancelledError);
    assert.equal(processIsAlive(descendantPid), false);
  } finally {
    controller.abort();
    if (descendantPid && processIsAlive(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cwd outside the selected session root is refused before execution', async () => {
  const root = await tempWorkspace();
  try {
    const call = { ...nodeEval("process.stdout.write('never');"), cwd: '../outside' };
    const { result } = await runTool({ root, call });
    assert.equal(result.toolResults[0]?.status, 'error');
    assert.equal(result.toolResults[0]?.error?.kind, 'tool');
    assert.match(result.toolResults[0]?.error?.message ?? '', /escapes the authorized process root/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('child environment keeps explicit ordinary values and drops ambient secrets', async () => {
  const root = await tempWorkspace();
  try {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      OPENAI_API_KEY: 'must-not-leak',
      AXIS_PROCESS_SECRET: 'must-not-leak-either'
    };
    const tool = new ProcessExecTool({ environment });
    const call: ProcessExecInput = {
      ...nodeEval(
        "process.stdout.write(JSON.stringify({ safe: process.env.AXIS_PROCESS_SAFE, openai: process.env.OPENAI_API_KEY, secret: process.env.AXIS_PROCESS_SECRET }));"
      ),
      env: { AXIS_PROCESS_SAFE: 'visible' }
    };
    const { result } = await runTool({ root, tool, call });
    const output = processOutput(result.toolResults[0]?.output);
    assert.deepEqual(JSON.parse(output.stdout), { safe: 'visible' });
    assert.ok((result.toolResults[0]?.metadata?.droppedEnvironmentKeyCount as number) > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('process_exec never switches away from the exact execution target', async () => {
  const root = await tempWorkspace();
  try {
    const target = new RecordingExecutionTarget('worker-a');
    const workerSession = session(root, {
      targetId: 'worker-a',
      targetKind: 'worker',
      connectionId: 'worker-connection'
    });
    const { result } = await runTool({
      root,
      session: workerSession,
      connectionId: 'worker-connection',
      executionTargets: [target],
      call: nodeEval("process.stdout.write('worker');")
    });

    assert.equal(target.calls, 1);
    assert.equal(result.status, 'completed');
    assert.equal(processOutput(result.toolResults[0]?.output).executionTargetId, 'worker-a');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mutating command requires write root and reports committed only after clean completion', async () => {
  const root = await tempWorkspace();
  try {
    const mutating = nodeEval("require('node:fs').writeFileSync('mutated.txt', 'ok');");
    const { result } = await runTool({ root, call: mutating });
    assert.equal(result.toolResults[0]?.mutationStatus, 'committed');
    assert.equal(await fs.readFile(path.join(root, 'mutated.txt'), 'utf8'), 'ok');

    const readOnlySession = session(root, { rootAccess: 'read', connectionId: 'read-only-root' });
    const refused = await runTool({
      root,
      session: readOnlySession,
      connectionId: 'read-only-root',
      call: mutating
    });
    assert.equal(refused.result.toolResults[0]?.status, 'error');
    assert.match(refused.result.toolResults[0]?.error?.message ?? '', /mutating commands require write access/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('permission denial prevents process execution', async () => {
  const root = await tempWorkspace();
  try {
    const deniedSession = session(root, { permission: 'denied', connectionId: 'denied-connection' });
    const { result } = await runTool({
      root,
      session: deniedSession,
      connectionId: 'denied-connection',
      call: nodeEval("require('node:fs').writeFileSync('should-not-exist.txt', 'bad');")
    });
    assert.equal(result.toolResults[0]?.status, 'error');
    assert.equal(result.toolResults[0]?.error?.kind, 'permission');
    await assert.rejects(() => fs.stat(path.join(root, 'should-not-exist.txt')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the same process tool operates independently of provider family and auth kind', async () => {
  const root = await tempWorkspace();
  try {
    const tool = new ProcessExecTool();
    const openai = await runTool({
      root,
      tool,
      providerFamily: 'openai',
      connectionId: 'chatgpt-account',
      authKind: 'chatgpt-account',
      call: nodeEval("process.stdout.write('shared-tool');")
    });
    const anthropic = await runTool({
      root,
      tool,
      providerFamily: 'anthropic',
      connectionId: 'claude-api',
      authKind: 'api-key',
      call: nodeEval("process.stdout.write('shared-tool');")
    });

    assert.equal(processOutput(openai.result.toolResults[0]?.output).stdout, 'shared-tool');
    assert.equal(processOutput(anthropic.result.toolResults[0]?.output).stdout, 'shared-tool');
    assert.equal(openai.provider.requests[0]?.tools[0]?.name, PROCESS_EXEC_TOOL_NAME);
    assert.equal(anthropic.provider.requests[0]?.tools[0]?.name, PROCESS_EXEC_TOOL_NAME);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('read-only intent is fail-closed unless policy can prove the invocation', async () => {
  const root = await tempWorkspace();
  try {
    const readSession = session(root, { rootAccess: 'read', connectionId: 'read-command' });
    const safe = await runTool({
      root,
      session: readSession,
      connectionId: 'read-command',
      call: {
        command: 'node',
        args: ['--version'],
        rootId: 'workspace',
        cwd: '.',
        mutation: 'read-only'
      }
    });
    assert.equal(safe.result.toolResults[0]?.status, 'success');
    assert.equal(safe.result.toolResults[0]?.mutationStatus, 'not-applicable');

    const unsafeDeclaration = await runTool({
      root,
      session: readSession,
      connectionId: 'read-command',
      call: {
        command: 'node',
        args: ['--input-type=commonjs', '-e', "require('node:fs').writeFileSync('x', 'x')"],
        rootId: 'workspace',
        cwd: '.',
        mutation: 'read-only'
      }
    });
    assert.equal(unsafeDeclaration.result.toolResults[0]?.status, 'error');
    assert.match(unsafeDeclaration.result.toolResults[0]?.error?.message ?? '', /cannot be proven read-only/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
