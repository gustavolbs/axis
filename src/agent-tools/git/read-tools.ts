import path from 'node:path';

import type {
  AxisTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutput
} from '../../agent-runtime/index.js';
import {
  DEFAULT_GIT_TIMEOUT_MS,
  GIT_READ_CAPABILITY,
  GIT_READ_PERMISSION,
  GIT_WORKTREE_CAPABILITY,
  GIT_WORKTREE_PERMISSION,
  GitToolError,
  boundedInteger,
  optionalString,
  parseWorktreePorcelain,
  requiredString,
  resolveGitRepository,
  resolveGitStorageRoot,
  runGitCommand,
  validateCommitRef,
  withinRoot,
  type GitToolOptions
} from './core.js';

export const GIT_STATUS_TOOL_NAME = 'git_status';
export const GIT_DIFF_TOOL_NAME = 'git_diff';
export const GIT_BRANCH_INFO_TOOL_NAME = 'git_branch_info';
export const GIT_COMMIT_METADATA_TOOL_NAME = 'git_commit_metadata';
export const GIT_WORKTREE_LIST_TOOL_NAME = 'git_worktree_list';

interface GitStatusInput { readonly rootId: string; }
export interface GitStatusOutput {
  readonly rootId: string;
  readonly clean: boolean;
  readonly branch: string | null;
  readonly head: string;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly entries: readonly string[];
}

export type GitDiffScope = 'working' | 'staged' | 'branch' | 'commit';
interface GitDiffInput {
  readonly rootId: string;
  readonly scope: GitDiffScope;
  readonly baseRef?: string;
  readonly targetRef?: string;
  readonly contextLines: number;
}
export interface GitDiffOutput {
  readonly rootId: string;
  readonly scope: GitDiffScope;
  readonly baseRef?: string;
  readonly targetRef?: string;
  readonly diff: string;
  readonly truncated: boolean;
}

interface GitCommitMetadataInput {
  readonly rootId: string;
  readonly ref: string;
  readonly maxCount: number;
}
export interface GitCommitMetadata {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committedAt: string;
  readonly subject: string;
}
export interface GitCommitMetadataOutput {
  readonly rootId: string;
  readonly ref: string;
  readonly commits: readonly GitCommitMetadata[];
}

export interface GitWorktreeListOutput {
  readonly sourceRootId: string;
  readonly worktreeRootId: string;
  readonly source: {
    readonly head?: string;
    readonly branch?: string;
    readonly detached: boolean;
  };
  readonly managed: readonly {
    readonly worktreeId: string;
    readonly head?: string;
    readonly branch?: string;
    readonly detached: boolean;
    readonly locked: boolean;
  }[];
}

function readDefinition(name: string, description: string, schema: Record<string, unknown>, timeoutMs: number): ToolDefinition {
  return {
    name,
    description,
    inputSchema: schema,
    requiredCapabilities: [GIT_READ_CAPABILITY],
    requiredPermissions: [GIT_READ_PERMISSION],
    effect: 'read',
    mutationRisk: 'none',
    retryOnFailure: 'safe',
    timeoutMs
  };
}

async function optionalGitCommand(
  request: Parameters<typeof runGitCommand>[0]
): Promise<Awaited<ReturnType<typeof runGitCommand>> | undefined> {
  try {
    return await runGitCommand(request);
  } catch (error) {
    if (error instanceof GitToolError && error.code === 'axis.git.command_failed') return undefined;
    throw error;
  }
}

async function branchState(
  rootId: string,
  context: ToolExecutionContext,
  options: GitToolOptions
): Promise<Omit<GitStatusOutput, 'rootId' | 'clean' | 'entries'>> {
  const repository = await resolveGitRepository(context, rootId, false, options);
  const [headResult, branchResult, upstreamResult] = await Promise.all([
    runGitCommand({ ...options, cwd: repository.rootPath, args: ['rev-parse', 'HEAD'], signal: context.signal }),
    optionalGitCommand({
      ...options,
      cwd: repository.rootPath,
      args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      signal: context.signal
    }),
    optionalGitCommand({
      ...options,
      cwd: repository.rootPath,
      args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      signal: context.signal
    })
  ]);
  const branch = branchResult?.stdout.trim() || null;
  const upstream = upstreamResult?.stdout.trim() || null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await runGitCommand({
      ...options,
      cwd: repository.rootPath,
      args: ['rev-list', '--left-right', '--count', `${upstream}...HEAD`],
      signal: context.signal
    });
    const [behindValue, aheadValue] = counts.stdout.trim().split(/\s+/).map((item) => Number(item));
    behind = Number.isFinite(behindValue) ? behindValue : 0;
    ahead = Number.isFinite(aheadValue) ? aheadValue : 0;
  }
  return { branch, head: headResult.stdout.trim(), upstream, ahead, behind };
}

export class GitStatusTool implements AxisTool {
  readonly definition: ToolDefinition;
  constructor(private readonly options: GitToolOptions = {}) {
    this.definition = Object.freeze(readDefinition(
      GIT_STATUS_TOOL_NAME,
      'Read Git status and branch divergence from one exact authorized repository root without changing the checkout.',
      {
        type: 'object', additionalProperties: false, required: ['rootId'],
        properties: { rootId: { type: 'string', minLength: 1 } }
      },
      options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    ));
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const input: GitStatusInput = { rootId: requiredString(context.call.arguments.rootId, 'Git rootId') };
    const repository = await resolveGitRepository(context, input.rootId, false, this.options);
    context.reportProgress({ message: `Reading Git status for ${input.rootId}.`, metadata: { rootId: input.rootId } });
    const [status, branch] = await Promise.all([
      runGitCommand({
        ...this.options,
        cwd: repository.rootPath,
        args: ['status', '--porcelain=v1', '--untracked-files=normal'],
        signal: context.signal
      }),
      branchState(input.rootId, context, this.options)
    ]);
    const entries = status.stdout.trimEnd() ? status.stdout.trimEnd().split(/\r?\n/) : [];
    const output: GitStatusOutput = {
      rootId: input.rootId,
      clean: entries.length === 0,
      ...branch,
      entries
    };
    context.reportActivity({
      kind: 'read',
      detail: `Git status ${input.rootId}`,
      metadata: { rootId: input.rootId, clean: output.clean, entryCount: entries.length }
    });
    return { output, mutationStatus: 'not-applicable', retry: 'safe', metadata: { rootId: input.rootId } };
  }
}

export class GitBranchInfoTool implements AxisTool {
  readonly definition: ToolDefinition;
  constructor(private readonly options: GitToolOptions = {}) {
    this.definition = Object.freeze(readDefinition(
      GIT_BRANCH_INFO_TOOL_NAME,
      'Read HEAD, current branch, upstream and ahead/behind counts for one exact authorized repository root.',
      {
        type: 'object', additionalProperties: false, required: ['rootId'],
        properties: { rootId: { type: 'string', minLength: 1 } }
      },
      options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    ));
  }
  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const rootId = requiredString(context.call.arguments.rootId, 'Git rootId');
    const output = { rootId, ...(await branchState(rootId, context, this.options)) };
    context.reportActivity({ kind: 'read', detail: `Git branch ${rootId}`, metadata: { rootId, branch: output.branch } });
    return { output, mutationStatus: 'not-applicable', retry: 'safe', metadata: { rootId } };
  }
}

function parseDiffInput(value: Readonly<Record<string, unknown>>): GitDiffInput {
  const scope = value.scope;
  if (scope !== 'working' && scope !== 'staged' && scope !== 'branch' && scope !== 'commit') {
    throw new Error('Git diff scope must be working, staged, branch, or commit.');
  }
  const baseRef = optionalString(value.baseRef, 'Git diff baseRef', 1_024);
  const targetRef = optionalString(value.targetRef, 'Git diff targetRef', 1_024);
  if (scope === 'branch' && !baseRef) throw new Error('Git branch diff requires an explicit baseRef.');
  if (scope === 'commit' && (!baseRef || !targetRef)) {
    throw new Error('Git commit diff requires explicit baseRef and targetRef.');
  }
  if ((scope === 'working' || scope === 'staged') && (baseRef || targetRef)) {
    throw new Error(`Git ${scope} diff does not accept revision refs.`);
  }
  if (scope === 'branch' && targetRef) throw new Error('Git branch diff always targets HEAD and does not accept targetRef.');
  return {
    rootId: requiredString(value.rootId, 'Git rootId'),
    scope,
    baseRef,
    targetRef,
    contextLines: boundedInteger(value.contextLines, 'Git diff contextLines', 3, 0, 50)
  };
}

export class GitDiffTool implements AxisTool {
  readonly definition: ToolDefinition;
  constructor(private readonly options: GitToolOptions = {}) {
    this.definition = Object.freeze(readDefinition(
      GIT_DIFF_TOOL_NAME,
      'Read an unstaged, staged, branch, or commit-range unified diff from one exact authorized repository root. Revision ranges are explicit; no branch base is guessed.',
      {
        type: 'object', additionalProperties: false, required: ['rootId', 'scope'],
        properties: {
          rootId: { type: 'string', minLength: 1 },
          scope: { type: 'string', enum: ['working', 'staged', 'branch', 'commit'] },
          baseRef: { type: 'string', minLength: 1 },
          targetRef: { type: 'string', minLength: 1 },
          contextLines: { type: 'integer', minimum: 0, maximum: 50 }
        }
      },
      options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    ));
  }
  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const input = parseDiffInput(context.call.arguments);
    const repository = await resolveGitRepository(context, input.rootId, false, this.options);
    if (input.baseRef) await validateCommitRef(repository, input.baseRef, context.signal, this.options);
    if (input.targetRef) await validateCommitRef(repository, input.targetRef, context.signal, this.options);
    const common = ['diff', '--no-ext-diff', '--no-color', `--unified=${input.contextLines}`];
    const args = input.scope === 'working'
      ? [...common, '--']
      : input.scope === 'staged'
        ? [...common, '--cached', '--']
        : input.scope === 'branch'
          ? [...common, `${input.baseRef}...HEAD`, '--']
          : [...common, input.baseRef as string, input.targetRef as string, '--'];
    context.reportProgress({ message: `Reading ${input.scope} Git diff.`, metadata: { rootId: input.rootId, scope: input.scope } });
    const result = await runGitCommand({ ...this.options, cwd: repository.rootPath, args, signal: context.signal });
    const output: GitDiffOutput = {
      rootId: input.rootId,
      scope: input.scope,
      baseRef: input.baseRef,
      targetRef: input.targetRef,
      diff: result.stdout,
      truncated: result.stdoutTruncated
    };
    context.reportActivity({
      kind: 'read', detail: `Git ${input.scope} diff`,
      metadata: { rootId: input.rootId, scope: input.scope, bytes: Buffer.byteLength(result.stdout), truncated: result.stdoutTruncated }
    });
    return { output, mutationStatus: 'not-applicable', retry: 'safe', metadata: { rootId: input.rootId, scope: input.scope } };
  }
}

function parseCommitLog(value: string): GitCommitMetadata[] {
  const records: GitCommitMetadata[] = [];
  for (const record of value.split('\x1e').filter((item) => item.length > 0)) {
    const fields = record.replace(/^\r?\n/, '').split('\x1f');
    if (fields.length < 9) continue;
    records.push({
      hash: fields[0] ?? '',
      parents: (fields[1] ?? '').split(' ').filter(Boolean),
      authorName: fields[2] ?? '',
      authorEmail: fields[3] ?? '',
      authoredAt: fields[4] ?? '',
      committerName: fields[5] ?? '',
      committerEmail: fields[6] ?? '',
      committedAt: fields[7] ?? '',
      subject: fields.slice(8).join('\x1f').replace(/\r?\n$/, '')
    });
  }
  return records;
}

export class GitCommitMetadataTool implements AxisTool {
  readonly definition: ToolDefinition;
  constructor(private readonly options: GitToolOptions = {}) {
    this.definition = Object.freeze(readDefinition(
      GIT_COMMIT_METADATA_TOOL_NAME,
      'Read bounded commit metadata from an explicit Git ref without reading patch bodies or changing repository state.',
      {
        type: 'object', additionalProperties: false, required: ['rootId'],
        properties: {
          rootId: { type: 'string', minLength: 1 },
          ref: { type: 'string', minLength: 1 },
          maxCount: { type: 'integer', minimum: 1, maximum: 50 }
        }
      },
      options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    ));
  }
  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const input: GitCommitMetadataInput = {
      rootId: requiredString(context.call.arguments.rootId, 'Git rootId'),
      ref: optionalString(context.call.arguments.ref, 'Git commit ref', 1_024) ?? 'HEAD',
      maxCount: boundedInteger(context.call.arguments.maxCount, 'Git maxCount', 20, 1, 50)
    };
    const repository = await resolveGitRepository(context, input.rootId, false, this.options);
    await validateCommitRef(repository, input.ref, context.signal, this.options);
    const result = await runGitCommand({
      ...this.options,
      cwd: repository.rootPath,
      args: [
        'log', `--max-count=${input.maxCount}`,
        '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1e',
        input.ref
      ],
      signal: context.signal
    });
    const commits = parseCommitLog(result.stdout);
    const output: GitCommitMetadataOutput = { rootId: input.rootId, ref: input.ref, commits };
    context.reportActivity({ kind: 'read', detail: `Git commit metadata ${input.ref}`, metadata: { rootId: input.rootId, count: commits.length } });
    return { output, mutationStatus: 'not-applicable', retry: 'safe', metadata: { rootId: input.rootId, count: commits.length } };
  }
}

export class GitWorktreeListTool implements AxisTool {
  readonly definition: ToolDefinition;
  constructor(private readonly options: GitToolOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    this.definition = Object.freeze({
      name: GIT_WORKTREE_LIST_TOOL_NAME,
      description: 'List the source checkout plus only worktrees located under one explicitly authorized worktree storage root. Other repository worktree paths are filtered out.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['sourceRootId', 'worktreeRootId'],
        properties: {
          sourceRootId: { type: 'string', minLength: 1 },
          worktreeRootId: { type: 'string', minLength: 1 }
        }
      },
      requiredCapabilities: [GIT_READ_CAPABILITY, GIT_WORKTREE_CAPABILITY],
      requiredPermissions: [GIT_READ_PERMISSION, GIT_WORKTREE_PERMISSION],
      effect: 'read', mutationRisk: 'none', retryOnFailure: 'safe', timeoutMs
    });
  }
  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const sourceRootId = requiredString(context.call.arguments.sourceRootId, 'Git sourceRootId');
    const worktreeRootId = requiredString(context.call.arguments.worktreeRootId, 'Git worktreeRootId');
    const repository = await resolveGitRepository(context, sourceRootId, false, this.options);
    const worktreeRoot = await resolveGitStorageRoot(context.session, worktreeRootId);
    const result = await runGitCommand({
      ...this.options,
      cwd: repository.rootPath,
      args: ['worktree', 'list', '--porcelain'],
      signal: context.signal
    });
    const records = parseWorktreePorcelain(result.stdout);
    const sourceRecord = records.find((record) => path.resolve(record.path) === repository.rootPath);
    const managed = records.filter((record) => {
      const candidate = path.resolve(record.path);
      return candidate !== repository.rootPath && withinRoot(worktreeRoot.rootPath, candidate);
    }).map((record) => ({
      worktreeId: path.relative(worktreeRoot.rootPath, path.resolve(record.path)),
      head: record.head,
      branch: record.branch,
      detached: record.detached,
      locked: record.lockedReason !== undefined
    })).filter((record) => record.worktreeId && !record.worktreeId.includes(path.sep));
    const output: GitWorktreeListOutput = {
      sourceRootId,
      worktreeRootId,
      source: {
        head: sourceRecord?.head,
        branch: sourceRecord?.branch,
        detached: sourceRecord?.detached ?? false
      },
      managed
    };
    context.reportActivity({ kind: 'read', detail: 'Git worktree list', metadata: { sourceRootId, worktreeRootId, managedCount: managed.length } });
    return { output, mutationStatus: 'not-applicable', retry: 'safe', metadata: { sourceRootId, worktreeRootId, managedCount: managed.length } };
  }
}
