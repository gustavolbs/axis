import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { OperationCancelledError } from '../src/cancellation.js';
import {
  AgentRuntime,
  negotiateEffectiveCapabilities,
  ToolRegistry,
  type AgentProviderAdapter,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentSessionContext,
  type AxisTool,
  type ToolActivity,
  type ToolProgress
} from '../src/agent-runtime/index.js';
import {
  FILESYSTEM_CAPABILITIES,
  FILESYSTEM_PERMISSIONS,
  FILESYSTEM_TOOLS,
  FilesystemToolError,
  createFileTool,
  createFilesystemTools,
  editFileTool,
  listDirectoryTool,
  readFileTool,
  searchFilesTool,
  searchTextTool,
  statFileTool,
  writeFileTool
} from '../src/agent-tools/filesystem/index.js';

async function tempRoots(): Promise<{ base: string; rootA: string; rootB: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-filesystem-tools-'));
  const rootA = path.join(base, 'company-a');
  const rootB = path.join(base, 'company-b');
  await fs.mkdir(rootA, { recursive: true });
  await fs.mkdir(rootB, { recursive: true });
  return { base, rootA, rootB };
}

function session(input: {
  root: string;
  companyId?: string;
  projectId?: string;
  connectionId?: string;
  providerFamily?: string;
  access?: 'read' | 'write';
  permissions?: Record<string, 'granted' | 'denied' | 'ask'>;
  capabilities?: string[];
  rootCompanyId?: string;
  rootProjectId?: string;
}): AgentSessionContext {
  const companyId = input.companyId ?? 'company-a';
  const projectId = input.projectId ?? 'project-a';
  return {
    sessionId: `session-${companyId}-${projectId}-${input.connectionId ?? 'connection-test'}`,
    companyId,
    project: { id: projectId, companyId },
    connection: {
      id: input.connectionId ?? 'connection-test',
      providerFamily: input.providerFamily ?? 'openai',
      authKind: 'api-key',
      companyId
    },
    modelId: 'model-test',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [{
      id: 'workspace',
      path: input.root,
      access: input.access ?? 'write',
      companyId: input.rootCompanyId ?? companyId,
      projectId: input.rootProjectId ?? projectId
    }],
    permissions: {
      default: 'denied',
      entries: input.permissions ?? {
        [FILESYSTEM_PERMISSIONS.read]: 'granted',
        [FILESYSTEM_PERMISSIONS.write]: 'granted'
      }
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{
        source: 'filesystem-test',
        ids: input.capabilities ?? [FILESYSTEM_CAPABILITIES.read, FILESYSTEM_CAPABILITIES.write]
      }]
    }),
    resources: []
  };
}

async function execute(
  tool: AxisTool,
  context: AgentSessionContext,
  args: Record<string, unknown>,
  signal = new AbortController().signal
): Promise<{ result: Awaited<ReturnType<AxisTool['execute']>>; progress: ToolProgress[]; activities: ToolActivity[] }> {
  const progress: ToolProgress[] = [];
  const activities: ToolActivity[] = [];
  const result = await tool.execute({
    session: context,
    call: { id: 'call-test', name: tool.definition.name, arguments: args },
    signal,
    reportProgress: (event) => progress.push(event),
    reportActivity: (event) => activities.push(event)
  });
  return { result, progress, activities };
}

class FilesystemFakeAdapter implements AgentProviderAdapter {
  readonly capabilities;
  readonly requests: AgentProviderRequest[] = [];

  constructor(
    readonly connectionId: string,
    readonly providerFamily: string,
    readonly modelId: string,
    toolProtocol: 'native' | 'structured-fallback',
    private readonly call: { name: string; arguments: Record<string, unknown> }
  ) {
    this.capabilities = { streaming: false, toolProtocol } as const;
  }

  async invoke(request: AgentProviderRequest): Promise<AgentProviderResponse> {
    this.requests.push(request);
    if (!request.messages.some((message) => message.role === 'tool')) {
      return {
        toolCalls: [{ id: `${this.providerFamily}-filesystem`, name: this.call.name, arguments: this.call.arguments }],
        stopReason: 'tool_calls'
      };
    }
    return { text: `${this.providerFamily}:done`, toolCalls: [], stopReason: 'complete' };
  }
}

test('filesystem tool set registers without runtime or provider changes', () => {
  const tools = createFilesystemTools();
  const registry = new ToolRegistry(tools);
  assert.equal(tools, FILESYSTEM_TOOLS);
  assert.deepEqual(
    registry.list().map((tool) => tool.definition.name),
    ['create_file', 'edit_file', 'list_directory', 'read_file', 'search_files', 'search_text', 'stat_file', 'write_file']
  );
  for (const tool of tools) assert.ok((tool.definition.timeoutMs ?? 0) > 0);
  assert.deepEqual(readFileTool.definition.requiredCapabilities, [FILESYSTEM_CAPABILITIES.read]);
  assert.deepEqual(createFileTool.definition.requiredCapabilities, [FILESYSTEM_CAPABILITIES.write]);
  assert.deepEqual(editFileTool.definition.requiredCapabilities, [FILESYSTEM_CAPABILITIES.read, FILESYSTEM_CAPABILITIES.write]);
});

test('read_file reads only inside the selected root and reports lifecycle activity', async (t) => {
  const { base, rootA } = await tempRoots();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootA, 'hello.txt'), 'one\ntwo\nthree\n', 'utf8');

  const execution = await execute(readFileTool, session({ root: rootA }), {
    rootId: 'workspace', path: 'hello.txt', startLine: 2, endLine: 3
  });
  const output = execution.result.output as {
    content: string;
    lines: Array<{ number: number; text: string }>;
    sha256: string;
  };
  assert.equal(output.content, 'two\nthree');
  assert.deepEqual(output.lines, [{ number: 2, text: 'two' }, { number: 3, text: 'three' }]);
  assert.match(output.sha256, /^[a-f0-9]{64}$/);
  assert.ok(execution.progress.length >= 1);
  assert.ok(execution.activities.some((activity) => activity.kind === 'read'));
});

test('filesystem rejects absolute paths, traversal, and access outside the authorized root', async (t) => {
  const { base, rootA, rootB } = await tempRoots();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootB, 'secret.txt'), 'company-b', 'utf8');
  const context = session({ root: rootA });

  await assert.rejects(
    () => execute(readFileTool, context, { rootId: 'workspace', path: path.join(rootB, 'secret.txt') }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_invalid_path'
  );
  await assert.rejects(
    () => execute(readFileTool, context, { rootId: 'workspace', path: '../company-b/secret.txt' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_path_escape'
  );
  await assert.rejects(
    () => execute(readFileTool, context, { rootId: 'other-root', path: 'secret.txt' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_root_not_found'
  );
});

test('symlinks that resolve outside a session root are refused and never followed', async (t) => {
  const { base, rootA, rootB } = await tempRoots();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootB, 'secret.txt'), 'secret', 'utf8');
  const link = path.join(rootA, 'escape.txt');
  try {
    await fs.symlink(path.join(rootB, 'secret.txt'), link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }

  await assert.rejects(
    () => execute(readFileTool, session({ root: rootA }), { rootId: 'workspace', path: 'escape.txt' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_symlink_escape'
  );
  const listed = await execute(listDirectoryTool, session({ root: rootA }), { rootId: 'workspace', includeHidden: true });
  const entry = (listed.result.output as { entries: Array<{ name: string; symlinkEscapesRoot: boolean }> }).entries.find((candidate) => candidate.name === 'escape.txt');
  assert.equal(entry?.symlinkEscapesRoot, true);
});

test('session Company and Project root authority is preserved by filesystem execution', async (t) => {
  const { base, rootA, rootB } = await tempRoots();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootA, 'scope.txt'), 'A', 'utf8');
  await fs.writeFile(path.join(rootB, 'scope.txt'), 'B', 'utf8');

  const resultA = await execute(readFileTool, session({ root: rootA, companyId: 'company-a', projectId: 'project-a' }), { rootId: 'workspace', path: 'scope.txt' });
  const resultB = await execute(readFileTool, session({ root: rootB, companyId: 'company-b', projectId: 'project-b' }), { rootId: 'workspace', path: 'scope.txt' });
  assert.equal((resultA.result.output as { content: string }).content, 'A');
  assert.equal((resultB.result.output as { content: string }).content, 'B');

  await assert.rejects(
    () => execute(
      readFileTool,
      session({ root: rootA, companyId: 'company-a', projectId: 'project-a', rootCompanyId: 'company-b' }),
      { rootId: 'workspace', path: 'scope.txt' }
    ),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_root_scope_mismatch'
  );
  await assert.rejects(
    () => execute(
      readFileTool,
      session({ root: rootA, companyId: 'company-a', projectId: 'project-a', rootProjectId: 'project-other' }),
      { rootId: 'workspace', path: 'scope.txt' }
    ),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_root_scope_mismatch'
  );
});

test('create/write/edit are atomic scoped mutations with conflict detection and committed mutation status', async (t) => {
  const { base, rootA } = await tempRoots();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const context = session({ root: rootA });

  const created = await execute(createFileTool, context, { rootId: 'workspace', path: 'nested/file.txt', content: 'alpha' });
  assert.equal(created.result.mutationStatus, 'committed');
  const createOutput = created.result.output as { afterSha256: string };
  assert.ok(created.activities.some((activity) => activity.kind === 'mutation'));

  const written = await execute(writeFileTool, context, {
    rootId: 'workspace', path: 'nested/file.txt', content: 'alpha beta', expectedSha256: createOutput.afterSha256
  });
  assert.equal(written.result.mutationStatus, 'committed');
  const writeOutput = written.result.output as { afterSha256: string };

  const edited = await execute(editFileTool, context, {
    rootId: 'workspace', path: 'nested/file.txt', oldText: 'beta', newText: 'gamma', expectedSha256: writeOutput.afterSha256
  });
  assert.equal(edited.result.mutationStatus, 'committed');
  assert.equal(await fs.readFile(path.join(rootA, 'nested/file.txt'), 'utf8'), 'alpha gamma');

  await assert.rejects(
    () => execute(writeFileTool, context, {
      rootId: 'workspace', path: 'nested/file.txt', content: 'stale overwrite', expectedSha256: createOutput.afterSha256
    }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_conflict'
  );
  await assert.rejects(
    () => execute(createFileTool, context, { rootId: 'workspace', path: 'nested/file.txt', content: 'clobber' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_already_exists'
  );
});

test('read-only roots and runtime permissions block mutations before filesystem execution', async (t) => {
  const { base, rootA } = await tempRoots();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await assert.rejects(
    () => execute(createFileTool, session({ root: rootA, access: 'read' }), { rootId: 'workspace', path: 'blocked.txt', content: 'nope' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_root_read_only'
  );

  const runtime = new AgentRuntime({ tools: [createFileTool] });
  const deniedSession = session({
    root: rootA,
    connectionId: 'denied-connection',
    permissions: { [FILESYSTEM_PERMISSIONS.read]: 'granted', [FILESYSTEM_PERMISSIONS.write]: 'denied' }
  });
  const adapter = new FilesystemFakeAdapter(
    'denied-connection', 'openai', 'model-test', 'native',
    { name: 'create_file', arguments: { rootId: 'workspace', path: 'runtime-blocked.txt', content: 'nope' } }
  );
  const result = await runtime.run({ context: deniedSession, provider: adapter, userInput: 'Create a file.' });
  assert.equal(result.toolResults[0]?.status, 'error');
  assert.equal(result.toolResults[0]?.error?.kind, 'permission');
  assert.equal(result.toolResults[0]?.mutationStatus, 'unknown');
  await assert.rejects(() => fs.stat(path.join(rootA, 'runtime-blocked.txt')));
});

test('filesystem cancellation is preemptive for tool work', async (t) => {
  const { base, rootA } = await tempRoots();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootA, 'one.txt'), 'one', 'utf8');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => execute(searchFilesTool, session({ root: rootA }), { rootId: 'workspace', globs: ['**/*.txt'] }, controller.signal),
    (error) => error instanceof OperationCancelledError
  );
});

test('list/stat/search/glob expose bounded metadata without decoding binary files as text', async (t) => {
  const { base, rootA } = await tempRoots();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootA, 'src'));
  await fs.writeFile(path.join(rootA, 'src', 'one.ts'), 'const needle = 1;\n', 'utf8');
  await fs.writeFile(path.join(rootA, 'src', 'ignored.ts'), 'needle\n', 'utf8');
  await fs.writeFile(path.join(rootA, '.gitignore'), 'src/ignored.ts\n', 'utf8');
  await fs.writeFile(path.join(rootA, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  const context = session({ root: rootA });

  const listed = await execute(listDirectoryTool, context, { rootId: 'workspace' });
  assert.ok((listed.result.output as { entries: Array<{ name: string }> }).entries.some((entry) => entry.name === 'src'));

  const metadata = await execute(statFileTool, context, { rootId: 'workspace', path: 'binary.bin' });
  assert.equal((metadata.result.output as { encoding: string }).encoding, 'binary');
  await assert.rejects(
    () => execute(readFileTool, context, { rootId: 'workspace', path: 'binary.bin' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_binary_file'
  );

  const files = await execute(searchFilesTool, context, { rootId: 'workspace', globs: ['**/*.ts'] });
  assert.deepEqual(
    (files.result.output as { matches: Array<{ path: string }> }).matches.map((match) => match.path),
    ['src/one.ts']
  );

  const text = await execute(searchTextTool, context, { rootId: 'workspace', query: 'needle', globs: ['**/*.ts'] });
  assert.deepEqual(
    (text.result.output as { matches: Array<{ path: string }> }).matches.map((match) => match.path),
    ['src/one.ts']
  );
});

test('filesystem tools return explicit stable errors for missing and ambiguous operations', async (t) => {
  const { base, rootA } = await tempRoots();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const context = session({ root: rootA });
  await fs.writeFile(path.join(rootA, 'repeated.txt'), 'same same', 'utf8');

  await assert.rejects(
    () => execute(readFileTool, context, { rootId: 'workspace', path: 'missing.txt' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_not_found' && error.message.includes('[filesystem_not_found]')
  );
  await assert.rejects(
    () => execute(editFileTool, context, { rootId: 'workspace', path: 'repeated.txt', oldText: 'same', newText: 'new' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_edit_ambiguous'
  );
});

test('different fake provider adapters drive the same filesystem tool without provider knowledge in the tool', async (t) => {
  const { base, rootA } = await tempRoots();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(rootA, 'hello.txt'), 'provider-neutral', 'utf8');
  const runtime = new AgentRuntime({ tools: [readFileTool] });

  for (const input of [
    { connectionId: 'openai-test', providerFamily: 'openai', protocol: 'native' as const },
    { connectionId: 'anthropic-test', providerFamily: 'anthropic', protocol: 'structured-fallback' as const }
  ]) {
    const context = session({ root: rootA, connectionId: input.connectionId, providerFamily: input.providerFamily });
    const adapter = new FilesystemFakeAdapter(
      input.connectionId, input.providerFamily, 'model-test', input.protocol,
      { name: 'read_file', arguments: { rootId: 'workspace', path: 'hello.txt' } }
    );
    const result = await runtime.run({ context, provider: adapter, userInput: 'Read hello.txt.', requireToolUse: true });
    assert.equal(result.status, 'completed');
    assert.equal((result.toolResults[0]?.output as { content: string }).content, 'provider-neutral');
    assert.equal(adapter.requests[0]?.tools[0]?.name, 'read_file');
  }
});
