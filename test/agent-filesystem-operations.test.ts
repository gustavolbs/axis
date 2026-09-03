import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  AgentRuntime,
  negotiateEffectiveCapabilities,
  type AgentProviderAdapter,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentSessionContext,
  type AxisTool
} from '../src/agent-runtime/index.js';
import {
  FILESYSTEM_CAPABILITIES,
  FILESYSTEM_PERMISSIONS,
  FilesystemToolError,
  copyPathTool,
  createDirectoryTool,
  deletePathTool,
  movePathTool,
  patchFileTool,
  setFileModeTool
} from '../src/agent-tools/filesystem/index.js';

async function workspace(): Promise<{ base: string; root: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-filesystem-ops-'));
  const root = path.join(base, 'workspace');
  await fs.mkdir(root);
  return { base, root };
}

function session(root: string, extra: {
  permissions?: Record<string, 'granted' | 'denied' | 'ask'>;
  capabilities?: string[];
  connectionId?: string;
} = {}): AgentSessionContext {
  return {
    sessionId: 'filesystem-operations-session',
    companyId: 'company-a',
    project: { id: 'project-a', companyId: 'company-a' },
    connection: {
      id: extra.connectionId ?? 'filesystem-operations-connection',
      providerFamily: 'openai', authKind: 'api-key', companyId: 'company-a'
    },
    modelId: 'model-test',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [{ id: 'workspace', path: root, access: 'write', companyId: 'company-a', projectId: 'project-a' }],
    permissions: {
      default: 'denied',
      entries: extra.permissions ?? {
        [FILESYSTEM_PERMISSIONS.read]: 'granted',
        [FILESYSTEM_PERMISSIONS.write]: 'granted',
        'workspace.delete': 'granted'
      }
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{ source: 'filesystem-operations-test', ids: extra.capabilities ?? [FILESYSTEM_CAPABILITIES.read, FILESYSTEM_CAPABILITIES.write] }]
    }),
    resources: []
  };
}

async function execute(tool: AxisTool, context: AgentSessionContext, args: Record<string, unknown>) {
  return await tool.execute({
    session: context,
    call: { id: `call-${tool.definition.name}`, name: tool.definition.name, arguments: args },
    signal: new AbortController().signal,
    reportProgress: () => undefined,
    reportActivity: () => undefined
  });
}

class DeleteAdapter implements AgentProviderAdapter {
  readonly providerFamily = 'openai';
  readonly modelId = 'model-test';
  readonly capabilities = { streaming: false, toolProtocol: 'native' as const };
  readonly requests: AgentProviderRequest[] = [];

  constructor(readonly connectionId: string) {}

  async invoke(request: AgentProviderRequest): Promise<AgentProviderResponse> {
    this.requests.push(request);
    if (!request.messages.some((message) => message.role === 'tool')) {
      return {
        toolCalls: [{ id: 'delete-call', name: 'delete_path', arguments: { rootId: 'workspace', path: 'protected.txt' } }],
        stopReason: 'tool_calls'
      };
    }
    return { text: 'done', toolCalls: [], stopReason: 'complete' };
  }
}

test('patch_file applies contextual hunks atomically and rejects stale/ambiguous patches', async (t) => {
  const { base, root } = await workspace();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'sample.ts'), 'const one = 1;\nconst two = 2;\n', 'utf8');
  const context = session(root);

  const patched = await execute(patchFileTool, context, {
    rootId: 'workspace', path: 'sample.ts',
    patches: [
      { oldText: 'const one = 1;', newText: 'const one = 10;' },
      { oldText: 'const two = 2;', newText: 'const two = 20;' }
    ]
  });
  assert.equal(patched.mutationStatus, 'committed');
  assert.equal(await fs.readFile(path.join(root, 'sample.ts'), 'utf8'), 'const one = 10;\nconst two = 20;\n');

  await fs.writeFile(path.join(root, 'ambiguous.txt'), 'same\nsame\n', 'utf8');
  await assert.rejects(
    () => execute(patchFileTool, context, {
      rootId: 'workspace', path: 'ambiguous.txt', patches: [{ oldText: 'same', newText: 'changed' }]
    }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_edit_ambiguous'
  );
});

test('create_directory, move_path and copy_path preserve root scope and committed mutation status', async (t) => {
  const { base, root } = await workspace();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const context = session(root);

  const directory = await execute(createDirectoryTool, context, { rootId: 'workspace', path: 'src' });
  assert.equal(directory.mutationStatus, 'committed');
  await fs.writeFile(path.join(root, 'src', 'one.txt'), 'one', 'utf8');

  const copied = await execute(copyPathTool, context, { rootId: 'workspace', from: 'src', to: 'copy' });
  assert.equal(copied.mutationStatus, 'committed');
  assert.equal(await fs.readFile(path.join(root, 'copy', 'one.txt'), 'utf8'), 'one');

  const moved = await execute(movePathTool, context, { rootId: 'workspace', from: 'copy/one.txt', to: 'copy/two.txt' });
  assert.equal(moved.mutationStatus, 'committed');
  assert.equal(await fs.readFile(path.join(root, 'copy', 'two.txt'), 'utf8'), 'one');

  await assert.rejects(
    () => execute(movePathTool, context, { rootId: 'workspace', from: 'copy/two.txt', to: '../escape.txt' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_path_escape'
  );
});

test('copy_path refuses symlinks inside directory trees instead of reading through them', async (t) => {
  const { base, root } = await workspace();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'source'));
  await fs.writeFile(path.join(root, 'target.txt'), 'target', 'utf8');
  try {
    await fs.symlink('../target.txt', path.join(root, 'source', 'link.txt'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }

  await assert.rejects(
    () => execute(copyPathTool, session(root), { rootId: 'workspace', from: 'source', to: 'destination' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_unsupported_operation'
  );
  await assert.rejects(() => fs.stat(path.join(root, 'destination')));
});

test('delete_path requires explicit delete permission and recursive intent for non-empty directories', async (t) => {
  const { base, root } = await workspace();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'dir'));
  await fs.writeFile(path.join(root, 'dir', 'file.txt'), 'data', 'utf8');

  await assert.rejects(
    () => execute(deletePathTool, session(root), { rootId: 'workspace', path: 'dir' }),
    (error) => error instanceof FilesystemToolError && error.code === 'filesystem_not_empty'
  );

  const deleted = await execute(deletePathTool, session(root), { rootId: 'workspace', path: 'dir', recursive: true });
  assert.equal(deleted.mutationStatus, 'committed');
  await assert.rejects(() => fs.stat(path.join(root, 'dir')));

  await fs.writeFile(path.join(root, 'protected.txt'), 'keep', 'utf8');
  const denied = session(root, {
    connectionId: 'delete-denied',
    permissions: {
      [FILESYSTEM_PERMISSIONS.read]: 'granted',
      [FILESYSTEM_PERMISSIONS.write]: 'granted',
      'workspace.delete': 'denied'
    }
  });
  const runtime = new AgentRuntime({ tools: [deletePathTool] });
  const result = await runtime.run({ context: denied, provider: new DeleteAdapter('delete-denied'), userInput: 'Delete protected.txt.' });
  assert.equal(result.toolResults[0]?.status, 'error');
  assert.equal(result.toolResults[0]?.error?.kind, 'permission');
  assert.equal(await fs.readFile(path.join(root, 'protected.txt'), 'utf8'), 'keep');
});

test('set_file_mode exposes controlled executable/permission mutation', async (t) => {
  const { base, root } = await workspace();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'script.sh'), '#!/bin/sh\n', 'utf8');
  const changed = await execute(setFileModeTool, session(root), { rootId: 'workspace', path: 'script.sh', mode: 0o755 });
  assert.equal(changed.mutationStatus, 'committed');
  if (process.platform !== 'win32') {
    const stat = await fs.stat(path.join(root, 'script.sh'));
    assert.equal(stat.mode & 0o777, 0o755);
  }
});
