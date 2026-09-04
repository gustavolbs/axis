import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  AgentRuntime,
  StaticToolPermissionGate,
  ToolRegistry,
  type AgentProviderAdapter,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentSessionContext
} from '../src/agent-runtime/index.js';
import { createFilesystemP12Tools } from '../src/agent-tools/filesystem/index.js';
import { createGitTools } from '../src/agent-tools/git/index.js';
import { createProcessTools } from '../src/agent-tools/process/index.js';
import { withCancellationSignal } from '../src/cancellation.js';
import { loadConfig, type LocalCoderConfig } from '../src/config.js';
import { RemoteWorkerAgentExecutionTarget } from '../src/remote-agent-execution-target.js';
import {
  createRemoteAxisToolRegistry,
  executeRemoteAxisTool,
  remoteAxisToolNames
} from '../src/remote-axis-tool-handler.js';
import type { RemoteAxisToolRequest } from '../src/remote-protocol.js';
import { RemoteWorkerClient } from '../src/remote-worker-client.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(): { root: string; remote: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-remote-tool-repo-'));
  const root = path.join(parent, 'source');
  const remote = path.join(parent, 'origin.git');
  fs.mkdirSync(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'axis@example.test']);
  git(root, ['config', 'user.name', 'Axis Test']);
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello\n');
  git(root, ['add', 'hello.txt']);
  git(root, ['commit', '-m', 'initial']);
  git(parent, ['init', '--bare', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-u', 'origin', 'HEAD']);
  return { root, remote };
}

async function workerServer(token: string): Promise<{
  url: string;
  config: LocalCoderConfig;
  requests: string[];
  close(): Promise<void>;
}> {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-remote-tool-worker-'));
  const config = loadConfig({
    LOCAL_CODER_WORKER_STATE_PATH: state,
    LOCAL_CODER_WORKER_BOOTSTRAP: 'none',
    LOCAL_CODER_REMOTE_MAX_DELTA_BYTES: '8000000',
    LOCAL_CODER_MAX_FILE_BYTES: '1000000'
  });
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push(raw);
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end(JSON.stringify({ protocolVersion: 1, error: 'Unauthorized.' }));
        return;
      }
      const controller = new AbortController();
      request.once('aborted', () => controller.abort());
      response.once('close', () => { if (!response.writableEnded) controller.abort(); });
      void executeRemoteAxisTool(
        JSON.parse(raw) as RemoteAxisToolRequest,
        config,
        controller.signal,
        createRemoteAxisToolRegistry()
      ).then((result) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      }, (error) => {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ protocolVersion: 1, error: error instanceof Error ? error.message : String(error) }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test Worker did not bind TCP.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    config,
    requests,
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function session(root: string): AgentSessionContext {
  const capabilities = Object.fromEntries([
    'axis.filesystem.read', 'axis.filesystem.write', 'axis.process.exec', 'axis.git.read'
  ].map((id) => [id, { id, available: true, offeredBy: ['worker'], blockedBy: [] }]));
  return {
    sessionId: 'remote-session',
    companyId: 'company-a',
    project: { id: 'project-a', companyId: 'company-a' },
    connection: { id: 'ollama', providerFamily: 'ollama', authKind: 'local', companyId: null },
    modelId: 'test-model',
    executionTarget: { id: 'worker-a', kind: 'worker', mode: 'workspace' },
    roots: [{ id: 'root', path: root, access: 'write', companyId: 'company-a', projectId: 'project-a' }],
    permissions: { default: 'denied', entries: {
      'workspace.read': 'granted', 'workspace.write': 'granted',
      'process.exec': 'granted', 'git.read': 'granted'
    } },
    capabilities: { entries: capabilities },
    resources: []
  };
}

class ScriptedAdapter implements AgentProviderAdapter {
  readonly connectionId = 'ollama';
  readonly providerFamily = 'ollama';
  readonly modelId = 'test-model';
  readonly capabilities = { toolProtocol: 'native' as const, streaming: false, providerManagedToolExecution: 'disabled' as const };
  private index = 0;
  constructor(private readonly responses: AgentProviderResponse[]) {}
  async invoke(_request: AgentProviderRequest): Promise<AgentProviderResponse> {
    return this.responses[this.index++]!;
  }
}

test('canonical AgentRuntime executes read, mutation, process and Git through an authenticated Worker without credentials', async () => {
  const repo = repository();
  const server = await workerServer('worker-secret');
  try {
    const clientConfig = { ...server.config, remoteWorkerUrl: server.url, remoteWorkerToken: 'worker-secret', remoteWorkerTimeoutMs: 20_000 };
    const target = new RemoteWorkerAgentExecutionTarget('worker-a', new RemoteWorkerClient(clientConfig), remoteAxisToolNames());
    const allTools = [
      ...createFilesystemP12Tools(),
      ...createProcessTools().tools,
      ...createGitTools().tools
    ].filter((tool) => target.supports(tool.definition.name));
    const adapter = new ScriptedAdapter([
      { complete: false, toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { rootId: 'root', path: 'hello.txt' } }] },
      { complete: false, toolCalls: [{ id: 'write-1', name: 'write_file', arguments: { rootId: 'root', path: 'hello.txt', content: 'worker wrote\n' } }] },
      { complete: false, toolCalls: [{ id: 'process-1', name: 'process_exec', arguments: { rootId: 'root', cwd: '.', command: 'node', args: ['-e', "require('fs').writeFileSync('process.txt','remote process\\n')"], mutation: 'workspace' } }] },
      { complete: false, toolCalls: [{ id: 'git-1', name: 'git_status', arguments: { rootId: 'root' } }] },
      { complete: true, text: 'done', toolCalls: [] }
    ]);
    const result = await new AgentRuntime({
      tools: new ToolRegistry(allTools),
      executionTargets: [target],
      permissionGate: new StaticToolPermissionGate()
    }).run({ context: session(repo.root), provider: adapter, userInput: 'work', requireToolUse: true });
    assert.equal(result.status, 'completed', JSON.stringify(result, null, 2));
    assert.equal(fs.readFileSync(path.join(repo.root, 'hello.txt'), 'utf8'), 'worker wrote\n');
    assert.equal(fs.readFileSync(path.join(repo.root, 'process.txt'), 'utf8'), 'remote process\n');
    assert.equal(result.toolResults.length, 4);
    assert.ok(server.requests.every((raw) => !raw.includes('worker-secret')));
    assert.ok(server.requests.every((raw) => !raw.includes('apiKey') && !raw.includes('remoteWorkerToken')));
    const forged = JSON.parse(server.requests[0]!) as RemoteAxisToolRequest;
    forged.session.roots[0] = { ...forged.session.roots[0]!, companyId: 'company-b' };
    await assert.rejects(
      () => executeRemoteAxisTool(forged, server.config, new AbortController().signal),
      /belongs to Company company-b/
    );
  } finally {
    await server.close();
  }
});

test('cancellation crosses the HTTP boundary and terminates a remote process call', async () => {
  const repo = repository();
  const server = await workerServer('token');
  try {
    const target = new RemoteWorkerAgentExecutionTarget('worker-a', new RemoteWorkerClient({
      ...server.config, remoteWorkerUrl: server.url, remoteWorkerToken: 'token', remoteWorkerTimeoutMs: 20_000
    }), remoteAxisToolNames());
    const processTool = createProcessTools().tools.find((tool) => tool.definition.name === 'process_exec')!;
    const controller = new AbortController();
    const pending = withCancellationSignal(controller.signal, () => target.execute(processTool, {
      session: session(repo.root),
      call: { id: 'cancel-process', name: 'process_exec', arguments: {
        rootId: 'root', cwd: '.', command: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], mutation: 'read-only'
      } },
      signal: controller.signal, reportProgress() {}, reportActivity() {}
    }));
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(() => pending, /cancel/i);
  } finally {
    await server.close();
  }
});

test('permission denial happens before Worker transmission and unsupported tools never fall back locally', async () => {
  const repo = repository();
  const server = await workerServer('token');
  try {
    const target = new RemoteWorkerAgentExecutionTarget('worker-a', new RemoteWorkerClient({
      ...server.config, remoteWorkerUrl: server.url, remoteWorkerToken: 'token', remoteWorkerTimeoutMs: 20_000
    }), remoteAxisToolNames());
    let localRuns = 0;
    const write = createFilesystemP12Tools().find((tool) => tool.definition.name === 'write_file')!;
    const guarded = { ...write, execute: async (...args: Parameters<typeof write.execute>) => { localRuns += 1; return await write.execute(...args); } };
    const denied = session(repo.root);
    denied.permissions.entries['workspace.write'] = 'denied';
    const result = await new AgentRuntime({ tools: [guarded], executionTargets: [target] }).run({
      context: denied,
      provider: new ScriptedAdapter([
        { complete: false, toolCalls: [{ id: 'deny', name: 'write_file', arguments: { rootId: 'root', path: 'hello.txt', content: 'bad' } }] },
        { complete: true, text: 'denied', toolCalls: [] }
      ]),
      userInput: 'deny'
    });
    assert.equal(result.toolResults[0]?.error?.code, 'permission_denied', JSON.stringify(result, null, 2));
    assert.equal(server.requests.length, 0);
    assert.equal(localRuns, 0);
    await assert.rejects(
      () => target.execute({ ...write, definition: { ...write.definition, name: 'unsupported_tool' } }, {
        session: session(repo.root), call: { id: 'x', name: 'unsupported_tool', arguments: {} }, signal: new AbortController().signal,
        reportProgress() {}, reportActivity() {}
      }),
      /not supported/
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('disconnect keeps read retry safe but marks a remote mutation indeterminate without desktop fallback', async () => {
  const repo = repository();
  const server = http.createServer((request) => {
    request.resume();
    request.once('end', () => request.socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Disconnect server did not bind.');
  const config = {
    ...loadConfig({ LOCAL_CODER_WORKER_STATE_PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'axis-disconnect-')) }),
    remoteWorkerUrl: `http://127.0.0.1:${address.port}`,
    remoteWorkerToken: 'token',
    remoteWorkerTimeoutMs: 2_000
  };
  const target = new RemoteWorkerAgentExecutionTarget('worker-a', new RemoteWorkerClient(config), remoteAxisToolNames());
  try {
    for (const [toolName, args, expectedStatus, expectedRetry] of [
      ['read_file', { rootId: 'root', path: 'hello.txt' }, 'not-applicable', 'safe'],
      ['write_file', { rootId: 'root', path: 'hello.txt', content: 'uncertain\n' }, 'unknown', 'after-confirmation']
    ] as const) {
      let localRuns = 0;
      const native = createFilesystemP12Tools().find((tool) => tool.definition.name === toolName)!;
      const guarded = { ...native, execute: async (...callArgs: Parameters<typeof native.execute>) => {
        localRuns += 1;
        return await native.execute(...callArgs);
      } };
      const result = await new AgentRuntime({ tools: [guarded], executionTargets: [target] }).run({
        context: session(repo.root),
        provider: new ScriptedAdapter([
          { complete: false, toolCalls: [{ id: `disconnect-${toolName}`, name: toolName, arguments: args }] },
          { complete: true, text: 'stopped', toolCalls: [] }
        ]),
        userInput: 'disconnect'
      });
      assert.equal(result.toolResults[0]?.mutationStatus, expectedStatus);
      assert.equal(result.toolResults[0]?.error?.retry, expectedRetry);
      assert.equal(localRuns, 0);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
