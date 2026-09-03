import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { OperationCancelledError } from '../src/cancellation.js';
import {
  AgentRuntime,
  negotiateEffectiveCapabilities,
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
  GIT_BRANCH_CREATE_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_READ_CAPABILITY,
  GIT_READ_PERMISSION,
  GIT_STATUS_TOOL_NAME,
  GIT_WORKTREE_CAPABILITY,
  GIT_WORKTREE_PERMISSION,
  GIT_WORKTREE_CREATE_TOOL_NAME,
  GIT_WRITE_CAPABILITY,
  GIT_WRITE_PERMISSION,
  GitBranchCreateTool,
  GitCommitMetadataTool,
  GitDiffTool,
  GitStageTool,
  GitStatusTool,
  GitUnstageTool,
  GitWorktreeCreateTool,
  GitWorktreeListTool,
  GitWorktreeRemoveTool,
  createGitTools,
  resolveGitRepository,
  type GitDiffOutput,
  type GitStatusOutput
} from '../src/agent-tools/git/index.js';

const execFileAsync = promisify(execFile);

interface RepoFixture {
  readonly parent: string;
  readonly source: string;
  readonly worktrees: string;
}

interface SessionOptions {
  readonly sessionId?: string;
  readonly companyId?: string;
  readonly projectId?: string;
  readonly sourceCompanyId?: string;
  readonly sourceProjectId?: string;
  readonly sourceAccess?: 'read' | 'write';
  readonly worktreeCompanyId?: string;
  readonly worktreeProjectId?: string;
  readonly worktreeAccess?: 'read' | 'write';
  readonly providerFamily?: string;
  readonly connectionId?: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  return result.stdout.trimEnd();
}

async function fixture(): Promise<RepoFixture> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'axis-git-'));
  const source = path.join(parent, 'source');
  const worktrees = path.join(parent, 'worktrees');
  await fs.mkdir(source);
  await fs.mkdir(worktrees);
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.name', 'Axis Git Test']);
  await git(source, ['config', 'user.email', 'axis-git-test@example.invalid']);
  await fs.writeFile(path.join(source, 'file.txt'), 'one\n', 'utf8');
  await git(source, ['add', 'file.txt']);
  await git(source, ['commit', '-m', 'initial commit']);
  return { parent, source, worktrees };
}

function session(repo: RepoFixture, options: SessionOptions = {}): AgentSessionContext {
  const companyId = options.companyId ?? 'git-company';
  const projectId = options.projectId ?? 'git-project';
  const connectionId = options.connectionId ?? 'git-connection';
  return {
    sessionId: options.sessionId ?? 'git-session',
    companyId,
    project: { id: projectId, companyId },
    connection: {
      id: connectionId,
      providerFamily: options.providerFamily ?? 'openai',
      authKind: 'api-key',
      companyId
    },
    modelId: 'git-model',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [
      {
        id: 'source',
        path: repo.source,
        access: options.sourceAccess ?? 'write',
        companyId: options.sourceCompanyId ?? companyId,
        projectId: options.sourceProjectId ?? projectId
      },
      {
        id: 'worktrees',
        path: repo.worktrees,
        access: options.worktreeAccess ?? 'write',
        companyId: options.worktreeCompanyId ?? companyId,
        projectId: options.worktreeProjectId ?? projectId
      }
    ],
    permissions: {
      default: 'denied',
      entries: {
        [GIT_READ_PERMISSION]: 'granted',
        [GIT_WRITE_PERMISSION]: 'granted',
        [GIT_WORKTREE_PERMISSION]: 'granted'
      }
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{
        source: 'axis-git-test',
        ids: [GIT_READ_CAPABILITY, GIT_WRITE_CAPABILITY, GIT_WORKTREE_CAPABILITY]
      }]
    }),
    resources: []
  };
}

function directContext(
  repo: RepoFixture,
  tool: AxisTool,
  args: Readonly<Record<string, unknown>>,
  options: SessionOptions = {},
  signal: AbortSignal = new AbortController().signal,
  callId = 'git-call'
): ToolExecutionContext {
  return {
    session: session(repo, options),
    call: { id: callId, name: tool.definition.name, arguments: args },
    signal,
    reportProgress: () => undefined,
    reportActivity: () => undefined
  };
}

async function execute(
  repo: RepoFixture,
  tool: AxisTool,
  args: Readonly<Record<string, unknown>>,
  options: SessionOptions = {},
  signal?: AbortSignal,
  callId?: string
): Promise<ToolExecutionOutput> {
  return await tool.execute(directContext(repo, tool, args, options, signal, callId));
}

class ScriptedGitAdapter implements AgentProviderAdapter {
  readonly capabilities = { streaming: false, toolProtocol: 'native' } as const;
  readonly requests: AgentProviderRequest[] = [];

  constructor(
    readonly connectionId: string,
    readonly providerFamily: string,
    readonly modelId: string,
    private readonly toolName: string,
    private readonly args: Readonly<Record<string, unknown>>
  ) {}

  async invoke(request: AgentProviderRequest): Promise<AgentProviderResponse> {
    this.requests.push(request);
    if (!request.messages.some((message) => message.role === 'tool')) {
      return {
        toolCalls: [{ id: `call-${this.connectionId}`, name: this.toolName, arguments: this.args }],
        stopReason: 'tool_calls'
      };
    }
    return { text: 'done', toolCalls: [], stopReason: 'complete' };
  }
}

class RecordingExecutionTarget {
  calls = 0;
  constructor(readonly id: string) {}
  async execute(tool: AxisTool, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    this.calls += 1;
    return await tool.execute(context);
  }
}

test('git_status and git_diff read working and staged state without mutation', async () => {
  const repo = await fixture();
  try {
    const statusTool = new GitStatusTool();
    const diffTool = new GitDiffTool();
    const clean = await execute(repo, statusTool, { rootId: 'source' });
    assert.equal(clean.mutationStatus, 'not-applicable');
    assert.equal((clean.output as GitStatusOutput).clean, true);
    assert.equal((clean.output as GitStatusOutput).branch, 'main');

    await fs.writeFile(path.join(repo.source, 'file.txt'), 'two\n', 'utf8');
    const working = await execute(repo, diffTool, { rootId: 'source', scope: 'working' });
    assert.equal(working.mutationStatus, 'not-applicable');
    assert.match((working.output as GitDiffOutput).diff, /-one/);
    assert.match((working.output as GitDiffOutput).diff, /\+two/);

    const stage = await execute(repo, new GitStageTool(), { rootId: 'source', paths: ['file.txt'] });
    assert.equal(stage.mutationStatus, 'committed');
    const staged = await execute(repo, diffTool, { rootId: 'source', scope: 'staged' });
    assert.match((staged.output as GitDiffOutput).diff, /\+two/);
    const unstage = await execute(repo, new GitUnstageTool(), { rootId: 'source', paths: ['file.txt'] });
    assert.equal(unstage.mutationStatus, 'committed');
    assert.equal(await git(repo.source, ['diff', '--cached', '--name-only']), '');
  } finally {
    await fs.rm(repo.parent, { recursive: true, force: true });
  }
});

test('branch and commit operations keep source checkout selected and expose bounded metadata', async () => {
  const repo = await fixture();
  try {
    const before = await git(repo.source, ['branch', '--show-current']);
    const created = await execute(repo, new GitBranchCreateTool(), {
      rootId: 'source', branchName: 'feature/review', startRef: 'HEAD'
    });
    assert.equal(created.mutationStatus, 'committed');
    assert.equal((created.output as { sourceCheckoutChanged: boolean }).sourceCheckoutChanged, false);
    assert.equal(await git(repo.source, ['branch', '--show-current']), before);
    assert.equal(await git(repo.source, ['show-ref', '--verify', '--quiet', 'refs/heads/feature/review']).then(() => 'yes'), 'yes');

    const metadata = await execute(repo, new GitCommitMetadataTool(), { rootId: 'source', ref: 'HEAD', maxCount: 1 });
    const commits = (metadata.output as { commits: Array<{ subject: string; hash: string }> }).commits;
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.subject, 'initial commit');
    assert.match(commits[0]?.hash ?? '', /^[a-f0-9]{40,64}$/);
  } finally {
    await fs.rm(repo.parent, { recursive: true, force: true });
  }
});

test('managed worktree is isolated, source checkout is preserved, list is filtered and cleanup is safe', async () => {
  const repo = await fixture();
  const outside = path.join(repo.parent, 'outside-worktree');
  try {
    await fs.writeFile(path.join(repo.source, 'local.txt'), 'source-only\n', 'utf8');
    await git(repo.source, ['worktree', 'add', '-b', 'outside/branch', outside, 'HEAD']);
    const sourceBefore = await git(repo.source, ['status', '--porcelain=v1']);

    const created = await execute(repo, new GitWorktreeCreateTool(), {
      sourceRootId: 'source',
      worktreeRootId: 'worktrees',
      branchName: 'feature/isolated',
      branchMode: 'create',
      startRef: 'HEAD'
    }, {}, undefined, 'worktree-create');
    assert.equal(created.mutationStatus, 'committed');
    const output = created.output as { worktreeId: string; sourceCheckoutChanged: boolean };
    assert.match(output.worktreeId, /^wt-[a-f0-9]{20}$/);
    assert.equal(output.sourceCheckoutChanged, false);
    assert.equal(await git(repo.source, ['branch', '--show-current']), 'main');
    assert.equal(await git(repo.source, ['status', '--porcelain=v1']), sourceBefore);

    const destination = path.join(repo.worktrees, output.worktreeId);
    assert.equal(await git(destination, ['branch', '--show-current']), 'feature/isolated');

    const listed = await execute(repo, new GitWorktreeListTool(), {
      sourceRootId: 'source', worktreeRootId: 'worktrees'
    });
    const managed = (listed.output as { managed: Array<{ worktreeId: string }> }).managed;
    assert.deepEqual(managed.map((item) => item.worktreeId), [output.worktreeId]);
    assert.equal(JSON.stringify(listed.output).includes(outside), false);

    const removed = await execute(repo, new GitWorktreeRemoveTool(), {
      sourceRootId: 'source', worktreeRootId: 'worktrees', worktreeId: output.worktreeId, force: true
    }, {}, undefined, 'worktree-remove');
    assert.equal(removed.mutationStatus, 'committed');
    await assert.rejects(fs.access(destination));
    assert.equal(await git(repo.source, ['branch', '--show-current']), 'main');
    assert.equal((await fs.stat(repo.source)).isDirectory(), true);
  } finally {
    await git(repo.source, ['worktree', 'remove', '--force', outside]).catch(() => undefined);
    await fs.rm(repo.parent, { recursive: true, force: true });
  }
});

test('worktree ownership lock prevents another Axis session from removing a job worktree', async () => {
  const repo = await fixture();
  try {
    const created = await execute(repo, new GitWorktreeCreateTool(), {
      sourceRootId: 'source', worktreeRootId: 'worktrees', branchName: 'feature/session-a', branchMode: 'create', startRef: 'HEAD'
    }, { sessionId: 'session-a' }, undefined, 'create-a');
    const worktreeId = (created.output as { worktreeId: string }).worktreeId;

    await assert.rejects(
      execute(repo, new GitWorktreeRemoveTool(), {
        sourceRootId: 'source', worktreeRootId: 'worktrees', worktreeId, force: true
      }, { sessionId: 'session-b' }),
      /axis\.git\.worktree_ownership_denied/
    );
    assert.equal((await fs.stat(path.join(repo.worktrees, worktreeId))).isDirectory(), true);

    const removed = await execute(repo, new GitWorktreeRemoveTool(), {
      sourceRootId: 'source', worktreeRootId: 'worktrees', worktreeId, force: true
    }, { sessionId: 'session-a' });
    assert.equal(removed.mutationStatus, 'committed');
  } finally {
    await fs.rm(repo.parent, { recursive: true, force: true });
  }
});

test('Git scope fails closed for cross-Company roots, nested implicit repositories and overlapping worktree roots', async () => {
  const repo = await fixture();
  try {
    const forged = session(repo, { sourceCompanyId: 'other-company' });
    await assert.rejects(
      resolveGitRepository({ session: forged, signal: new AbortController().signal }, 'source', false),
      /axis\.git\.cross_company_denied/
    );

    const nested = path.join(repo.source, 'nested');
    await fs.mkdir(nested);
    const nestedRepo = { ...repo, source: nested };
    await assert.rejects(
      execute(nestedRepo, new GitStatusTool(), { rootId: 'source' }),
      /axis\.git\.implicit_repository_denied/
    );

    const overlappingSession = session({ ...repo, worktrees: repo.source });
    const overlappingTool = new GitWorktreeCreateTool();
    await assert.rejects(
      overlappingTool.execute({
        ...directContext(repo, overlappingTool, {
          sourceRootId: 'source', worktreeRootId: 'worktrees', branchName: 'feature/nope', branchMode: 'create', startRef: 'HEAD'
        }),
        session: overlappingSession
      }),
      /axis\.git\.overlapping_roots_denied/
    );
  } finally {
    await fs.rm(repo.parent, { recursive: true, force: true });
  }
});

test('Git cancellation propagates through the shared process runtime', async () => {
  const repo = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      execute(repo, new GitStatusTool(), { rootId: 'source' }, {}, controller.signal),
      (error: unknown) => error instanceof OperationCancelledError
    );
  } finally {
    await fs.rm(repo.parent, { recursive: true, force: true });
  }
});

test('the same provider-neutral Git tool runs through different provider adapters and canonical lifecycle', async () => {
  const repo = await fixture();
  try {
    for (const [providerFamily, connectionId] of [['openai', 'openai-connection'], ['anthropic', 'anthropic-connection']] as const) {
      const events: AgentLifecycleEvent[] = [];
      const target = new RecordingExecutionTarget('desktop');
      const provider = new ScriptedGitAdapter(connectionId, providerFamily, 'git-model', GIT_STATUS_TOOL_NAME, { rootId: 'source' });
      const runtime = new AgentRuntime({
        tools: [new GitStatusTool()],
        executionTargets: [target],
        lifecycle: [(event: AgentLifecycleEvent) => events.push(event)]
      });
      const result = await runtime.run({
        context: session(repo, { providerFamily, connectionId }),
        provider,
        userInput: 'Read repository state.',
        requireToolUse: true
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.toolResults[0]?.status, 'success');
      assert.equal(result.toolResults[0]?.mutationStatus, 'not-applicable');
      assert.equal(target.calls, 1);
      assert.ok(events.some((event) => event.type === 'read' && event.toolName === GIT_STATUS_TOOL_NAME));
    }
  } finally {
    await fs.rm(repo.parent, { recursive: true, force: true });
  }
});

test('Git tool suite exposes explicit read/write/worktree capability boundaries', () => {
  const suite = createGitTools();
  assert.equal(suite.tools.length, 10);
  assert.equal(suite.status.definition.name, GIT_STATUS_TOOL_NAME);
  assert.equal(suite.diff.definition.name, GIT_DIFF_TOOL_NAME);
  assert.equal(suite.branchCreate.definition.name, GIT_BRANCH_CREATE_TOOL_NAME);
  assert.equal(suite.worktreeCreate.definition.name, GIT_WORKTREE_CREATE_TOOL_NAME);
  assert.deepEqual(suite.status.definition.requiredCapabilities, [GIT_READ_CAPABILITY]);
  assert.deepEqual(suite.branchCreate.definition.requiredCapabilities, [GIT_READ_CAPABILITY, GIT_WRITE_CAPABILITY]);
  assert.deepEqual(suite.worktreeCreate.definition.requiredCapabilities, [GIT_READ_CAPABILITY, GIT_WRITE_CAPABILITY, GIT_WORKTREE_CAPABILITY]);
});
