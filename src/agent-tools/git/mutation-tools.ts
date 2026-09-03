import fs from 'node:fs/promises';
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
  GIT_WRITE_CAPABILITY,
  GIT_WRITE_PERMISSION,
  GitToolError,
  assertDisjointRoots,
  assertLiteralRelativePath,
  booleanValue,
  managedOwnershipReason,
  managedWorktreeId,
  parseWorktreePorcelain,
  requiredString,
  resolveGitRepository,
  resolveGitStorageRoot,
  runGitCommand,
  stringArray,
  validateBranchName,
  validateCommitRef,
  withinRoot,
  type GitToolOptions,
  type ResolvedGitRepository,
  type ResolvedGitStorageRoot
} from './core.js';

export const GIT_BRANCH_CREATE_TOOL_NAME = 'git_branch_create';
export const GIT_STAGE_TOOL_NAME = 'git_stage';
export const GIT_UNSTAGE_TOOL_NAME = 'git_unstage';
export const GIT_WORKTREE_CREATE_TOOL_NAME = 'git_worktree_create';
export const GIT_WORKTREE_REMOVE_TOOL_NAME = 'git_worktree_remove';

function mutationDefinition(
  name: string,
  description: string,
  schema: Record<string, unknown>,
  timeoutMs: number,
  worktree = false
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: schema,
    requiredCapabilities: worktree
      ? [GIT_READ_CAPABILITY, GIT_WRITE_CAPABILITY, GIT_WORKTREE_CAPABILITY]
      : [GIT_READ_CAPABILITY, GIT_WRITE_CAPABILITY],
    requiredPermissions: worktree
      ? [GIT_READ_PERMISSION, GIT_WRITE_PERMISSION, GIT_WORKTREE_PERMISSION]
      : [GIT_READ_PERMISSION, GIT_WRITE_PERMISSION],
    effect: 'mutation',
    mutationRisk: 'definite',
    retryOnFailure: 'after-confirmation',
    timeoutMs
  };
}

export class GitBranchCreateTool implements AxisTool {
  readonly definition: ToolDefinition;
  constructor(private readonly options: GitToolOptions = {}) {
    this.definition = Object.freeze(mutationDefinition(
      GIT_BRANCH_CREATE_TOOL_NAME,
      'Create a branch ref at an explicit commit without switching or otherwise changing the source checkout.',
      {
        type: 'object', additionalProperties: false, required: ['rootId', 'branchName', 'startRef'],
        properties: {
          rootId: { type: 'string', minLength: 1 },
          branchName: { type: 'string', minLength: 1 },
          startRef: { type: 'string', minLength: 1 }
        }
      },
      options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    ));
  }
  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const rootId = requiredString(context.call.arguments.rootId, 'Git rootId');
    const repository = await resolveGitRepository(context, rootId, true, this.options);
    const branchName = await validateBranchName(
      repository,
      requiredString(context.call.arguments.branchName, 'Git branchName'),
      context.signal,
      this.options
    );
    const startRef = requiredString(context.call.arguments.startRef, 'Git startRef', 1_024);
    const startCommit = await validateCommitRef(repository, startRef, context.signal, this.options);
    context.reportProgress({ message: `Creating branch ${branchName}.`, metadata: { rootId, branchName, startCommit } });
    await runGitCommand({
      ...this.options,
      cwd: repository.rootPath,
      args: ['branch', branchName, startCommit],
      signal: context.signal,
      mutation: true
    });
    context.reportActivity({
      kind: 'mutation', detail: `Created Git branch ${branchName}`,
      metadata: { rootId, branchName, startCommit, sourceCheckoutChanged: false, mutationStatus: 'committed' }
    });
    return {
      output: { rootId, branchName, startCommit, sourceCheckoutChanged: false },
      mutationStatus: 'committed', retry: 'after-confirmation',
      metadata: { rootId, branchName, startCommit, sourceCheckoutChanged: false }
    };
  }
}

abstract class GitPathMutationTool implements AxisTool {
  abstract readonly definition: ToolDefinition;
  abstract execute(context: ToolExecutionContext): Promise<ToolExecutionOutput>;
  constructor(protected readonly options: GitToolOptions = {}) {}
  protected async input(context: ToolExecutionContext) {
    const rootId = requiredString(context.call.arguments.rootId, 'Git rootId');
    const paths = stringArray(context.call.arguments.paths, 'Git paths').map(assertLiteralRelativePath);
    const repository = await resolveGitRepository(context, rootId, true, this.options);
    return { rootId, paths, repository };
  }
}

export class GitStageTool extends GitPathMutationTool {
  readonly definition: ToolDefinition;
  constructor(options: GitToolOptions = {}) {
    super(options);
    this.definition = Object.freeze(mutationDefinition(
      GIT_STAGE_TOOL_NAME,
      'Stage explicit literal root-relative paths in one authorized repository. Pathspec magic, traversal and implicit all-files staging are refused.',
      {
        type: 'object', additionalProperties: false, required: ['rootId', 'paths'],
        properties: {
          rootId: { type: 'string', minLength: 1 },
          paths: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', minLength: 1 } }
        }
      },
      options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    ));
  }
  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const { rootId, paths, repository } = await this.input(context);
    await runGitCommand({
      ...this.options,
      cwd: repository.rootPath,
      args: ['--literal-pathspecs', 'add', '--', ...paths],
      signal: context.signal,
      mutation: true
    });
    context.reportActivity({ kind: 'mutation', detail: 'Staged Git paths', metadata: { rootId, paths, mutationStatus: 'committed' } });
    return { output: { rootId, paths }, mutationStatus: 'committed', retry: 'after-confirmation', metadata: { rootId, pathCount: paths.length } };
  }
}

export class GitUnstageTool extends GitPathMutationTool {
  readonly definition: ToolDefinition;
  constructor(options: GitToolOptions = {}) {
    super(options);
    this.definition = Object.freeze(mutationDefinition(
      GIT_UNSTAGE_TOOL_NAME,
      'Unstage explicit literal root-relative paths without modifying working-tree file contents.',
      {
        type: 'object', additionalProperties: false, required: ['rootId', 'paths'],
        properties: {
          rootId: { type: 'string', minLength: 1 },
          paths: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', minLength: 1 } }
        }
      },
      options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    ));
  }
  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const { rootId, paths, repository } = await this.input(context);
    await runGitCommand({
      ...this.options,
      cwd: repository.rootPath,
      args: ['--literal-pathspecs', 'restore', '--staged', '--', ...paths],
      signal: context.signal,
      mutation: true
    });
    context.reportActivity({ kind: 'mutation', detail: 'Unstaged Git paths', metadata: { rootId, paths, mutationStatus: 'committed' } });
    return { output: { rootId, paths }, mutationStatus: 'committed', retry: 'after-confirmation', metadata: { rootId, pathCount: paths.length } };
  }
}

async function branchExists(
  repository: ResolvedGitRepository,
  branchName: string,
  signal: AbortSignal,
  options: GitToolOptions
): Promise<boolean> {
  try {
    await runGitCommand({
      ...options,
      cwd: repository.rootPath,
      args: ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
      signal
    });
    return true;
  } catch (error) {
    if (error instanceof GitToolError && error.code === 'axis.git.command_failed') return false;
    throw error;
  }
}

async function cleanupFailedWorktreeCreation(input: {
  repository: ResolvedGitRepository;
  destination: string;
  branchName: string;
  branchMode: 'create' | 'existing';
  options: GitToolOptions;
}): Promise<'rolled-back' | 'partial' | 'unknown'> {
  const cleanupSignal = AbortSignal.timeout(5_000);
  try {
    const list = await runGitCommand({
      ...input.options,
      cwd: input.repository.rootPath,
      args: ['worktree', 'list', '--porcelain'],
      signal: cleanupSignal
    });
    const record = parseWorktreePorcelain(list.stdout).find((item) => path.resolve(item.path) === input.destination);
    if (record) {
      try {
        await runGitCommand({
          ...input.options,
          cwd: input.repository.rootPath,
          args: ['worktree', 'unlock', input.destination],
          signal: cleanupSignal,
          mutation: true
        });
      } catch {
        // It may not have reached the lock phase. Removal below remains bounded.
      }
      await runGitCommand({
        ...input.options,
        cwd: input.repository.rootPath,
        args: ['worktree', 'remove', '--force', input.destination],
        signal: cleanupSignal,
        mutation: true
      });
    } else {
      await fs.rm(input.destination, { recursive: true, force: true });
    }

    // A failed `worktree add -b` can leave a branch ref. Deleting it here would
    // race another job that may have claimed the same ref, so fail closed: retain
    // the ref and report partial rollback rather than deleting uncertain state.
    if (input.branchMode === 'create' && await branchExists(input.repository, input.branchName, cleanupSignal, input.options)) {
      return 'partial';
    }
    return 'rolled-back';
  } catch {
    return 'unknown';
  }
}

interface WorktreeCreateInput {
  readonly sourceRootId: string;
  readonly worktreeRootId: string;
  readonly branchName: string;
  readonly branchMode: 'create' | 'existing';
  readonly startRef?: string;
}

function parseWorktreeCreateInput(value: Readonly<Record<string, unknown>>): WorktreeCreateInput {
  const branchMode = value.branchMode;
  if (branchMode !== 'create' && branchMode !== 'existing') {
    throw new GitToolError('axis.git.invalid_input', 'Git worktree branchMode must be create or existing.');
  }
  const startRef = value.startRef === undefined ? undefined : requiredString(value.startRef, 'Git startRef', 1_024);
  if (branchMode === 'create' && !startRef) {
    throw new GitToolError('axis.git.invalid_input', 'Creating a worktree branch requires explicit startRef.');
  }
  if (branchMode === 'existing' && startRef) {
    throw new GitToolError('axis.git.invalid_input', 'Existing-branch worktree creation does not accept startRef.');
  }
  return {
    sourceRootId: requiredString(value.sourceRootId, 'Git sourceRootId'),
    worktreeRootId: requiredString(value.worktreeRootId, 'Git worktreeRootId'),
    branchName: requiredString(value.branchName, 'Git branchName'),
    branchMode,
    startRef
  };
}

export class GitWorktreeCreateTool implements AxisTool {
  readonly definition: ToolDefinition;
  constructor(private readonly options: GitToolOptions = {}) {
    this.definition = Object.freeze(mutationDefinition(
      GIT_WORKTREE_CREATE_TOOL_NAME,
      'Create an isolated Git worktree under a separate authorized worktree storage root. The source checkout is never switched, reset, cleaned, or reused as the destination.',
      {
        type: 'object', additionalProperties: false,
        required: ['sourceRootId', 'worktreeRootId', 'branchName', 'branchMode'],
        properties: {
          sourceRootId: { type: 'string', minLength: 1 },
          worktreeRootId: { type: 'string', minLength: 1 },
          branchName: { type: 'string', minLength: 1 },
          branchMode: { type: 'string', enum: ['create', 'existing'] },
          startRef: { type: 'string', minLength: 1 }
        }
      },
      options.timeoutMs ?? 60_000,
      true
    ));
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const input = parseWorktreeCreateInput(context.call.arguments);
    const repository = await resolveGitRepository(context, input.sourceRootId, true, this.options);
    const worktreeRoot = await resolveGitStorageRoot(context.session, input.worktreeRootId);
    assertDisjointRoots(repository.rootPath, worktreeRoot.rootPath);
    const branchName = await validateBranchName(repository, input.branchName, context.signal, this.options);
    let startCommit: string | undefined;
    if (input.branchMode === 'create') {
      startCommit = await validateCommitRef(repository, input.startRef as string, context.signal, this.options);
      if (await branchExists(repository, branchName, context.signal, this.options)) {
        throw new GitToolError('axis.git.branch_exists', `Branch ${branchName} already exists.`);
      }
    } else if (!(await branchExists(repository, branchName, context.signal, this.options))) {
      throw new GitToolError('axis.git.branch_missing', `Branch ${branchName} does not exist.`);
    }

    const worktreeId = managedWorktreeId(context.session, context.call.id, branchName);
    const destination = path.join(worktreeRoot.rootPath, worktreeId);
    if (!withinRoot(worktreeRoot.rootPath, destination) || destination === worktreeRoot.rootPath) {
      throw new GitToolError('axis.git.worktree_path_denied', 'Managed worktree destination escaped its authorized storage root.');
    }
    try {
      await fs.access(destination);
      throw new GitToolError('axis.git.worktree_exists', `Managed worktree ${worktreeId} already exists.`);
    } catch (error) {
      if (error instanceof GitToolError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const addArgs = input.branchMode === 'create'
      ? ['worktree', 'add', '-b', branchName, destination, startCommit as string]
      : ['worktree', 'add', destination, branchName];
    context.reportProgress({
      message: `Creating isolated worktree ${worktreeId}.`,
      metadata: { sourceRootId: input.sourceRootId, worktreeRootId: input.worktreeRootId, worktreeId, branchName }
    });
    try {
      await runGitCommand({
        ...this.options,
        cwd: repository.rootPath,
        args: addArgs,
        signal: context.signal,
        mutation: true,
        onOutput: (stream, chunk) => context.reportProgress({
          message: `${stream}: ${chunk.slice(0, 4_096)}`,
          metadata: { worktreeId, branchName, phase: 'git-output' }
        })
      });
      const destinationReal = await fs.realpath(destination);
      if (destinationReal !== destination) {
        throw new GitToolError('axis.git.worktree_path_mismatch', 'Created worktree resolved to an unexpected path.');
      }
      const childRepository = await runGitCommand({
        ...this.options,
        cwd: destination,
        args: ['rev-parse', '--show-toplevel'],
        signal: context.signal
      });
      if (await fs.realpath(childRepository.stdout.trim()) !== destinationReal) {
        throw new GitToolError('axis.git.worktree_repository_mismatch', 'Created worktree is not rooted at its managed destination.');
      }
      await runGitCommand({
        ...this.options,
        cwd: repository.rootPath,
        args: ['worktree', 'lock', '--reason', managedOwnershipReason(context.session, worktreeId), destination],
        signal: context.signal,
        mutation: true
      });
    } catch (error) {
      const rollbackStatus = await cleanupFailedWorktreeCreation({
        repository,
        destination,
        branchName,
        branchMode: input.branchMode,
        options: this.options
      });
      if (error instanceof GitToolError) {
        throw new GitToolError(error.code, `${error.message} Cleanup status: ${rollbackStatus}.`, {
          ...error.details,
          cleanupStatus: rollbackStatus
        });
      }
      throw error;
    }

    const output = {
      sourceRootId: input.sourceRootId,
      worktreeRootId: input.worktreeRootId,
      worktreeId,
      branchName,
      branchMode: input.branchMode,
      startCommit,
      sourceCheckoutChanged: false,
      locked: true
    } as const;
    context.reportActivity({
      kind: 'mutation', detail: `Created isolated Git worktree ${worktreeId}`,
      metadata: { ...output, mutationStatus: 'committed' }
    });
    return { output, mutationStatus: 'committed', retry: 'after-confirmation', metadata: output };
  }
}

async function assertOwnedManagedWorktree(input: {
  context: ToolExecutionContext;
  repository: ResolvedGitRepository;
  worktreeRoot: ResolvedGitStorageRoot;
  worktreeId: string;
  options: GitToolOptions;
}): Promise<{ destination: string; branch?: string; lockedReason?: string }> {
  if (!/^wt-[a-f0-9]{20}$/.test(input.worktreeId)) {
    throw new GitToolError('axis.git.invalid_worktree_id', 'Managed worktreeId has an invalid format.');
  }
  const destination = path.join(input.worktreeRoot.rootPath, input.worktreeId);
  if (!withinRoot(input.worktreeRoot.rootPath, destination) || destination === input.worktreeRoot.rootPath) {
    throw new GitToolError('axis.git.worktree_path_denied', 'Managed worktree destination escaped its authorized storage root.');
  }
  if (destination === input.repository.rootPath) {
    throw new GitToolError('axis.git.source_checkout_protected', 'The source checkout cannot be removed as a managed worktree.');
  }
  const list = await runGitCommand({
    ...input.options,
    cwd: input.repository.rootPath,
    args: ['worktree', 'list', '--porcelain'],
    signal: input.context.signal
  });
  const record = parseWorktreePorcelain(list.stdout).find((item) => path.resolve(item.path) === destination);
  if (!record) {
    throw new GitToolError('axis.git.worktree_not_found', `Managed worktree ${input.worktreeId} is not registered in the source repository.`);
  }
  const expectedReason = managedOwnershipReason(input.context.session, input.worktreeId);
  if (record.lockedReason !== expectedReason) {
    throw new GitToolError(
      'axis.git.worktree_ownership_denied',
      `Managed worktree ${input.worktreeId} is not owned by this immutable Axis session.`
    );
  }
  const realDestination = await fs.realpath(destination);
  if (realDestination !== destination) {
    throw new GitToolError('axis.git.worktree_path_mismatch', 'Managed worktree path resolves unexpectedly.');
  }
  const commonDir = await runGitCommand({
    ...input.options,
    cwd: destination,
    args: ['rev-parse', '--git-common-dir'],
    signal: input.context.signal
  });
  const childCommonDir = await fs.realpath(path.resolve(destination, commonDir.stdout.trim()));
  if (childCommonDir !== input.repository.gitCommonDir) {
    throw new GitToolError('axis.git.worktree_repository_mismatch', 'Managed worktree belongs to a different Git repository.');
  }
  return { destination, branch: record.branch, lockedReason: record.lockedReason };
}

export class GitWorktreeRemoveTool implements AxisTool {
  readonly definition: ToolDefinition;
  constructor(private readonly options: GitToolOptions = {}) {
    this.definition = Object.freeze(mutationDefinition(
      GIT_WORKTREE_REMOVE_TOOL_NAME,
      'Remove a worktree only when its path is under an explicit authorized storage root and its Axis ownership lock matches the current immutable session. The source checkout is always protected.',
      {
        type: 'object', additionalProperties: false,
        required: ['sourceRootId', 'worktreeRootId', 'worktreeId'],
        properties: {
          sourceRootId: { type: 'string', minLength: 1 },
          worktreeRootId: { type: 'string', minLength: 1 },
          worktreeId: { type: 'string', pattern: '^wt-[a-f0-9]{20}$' },
          force: { type: 'boolean' }
        }
      },
      options.timeoutMs ?? 60_000,
      true
    ));
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const sourceRootId = requiredString(context.call.arguments.sourceRootId, 'Git sourceRootId');
    const worktreeRootId = requiredString(context.call.arguments.worktreeRootId, 'Git worktreeRootId');
    const worktreeId = requiredString(context.call.arguments.worktreeId, 'Git worktreeId', 128);
    const force = booleanValue(context.call.arguments.force, 'Git force');
    const repository = await resolveGitRepository(context, sourceRootId, true, this.options);
    const worktreeRoot = await resolveGitStorageRoot(context.session, worktreeRootId);
    assertDisjointRoots(repository.rootPath, worktreeRoot.rootPath);
    const owned = await assertOwnedManagedWorktree({
      context, repository, worktreeRoot, worktreeId, options: this.options
    });
    context.reportProgress({ message: `Removing managed worktree ${worktreeId}.`, metadata: { sourceRootId, worktreeRootId, worktreeId, force } });
    await runGitCommand({
      ...this.options,
      cwd: repository.rootPath,
      args: ['worktree', 'unlock', owned.destination],
      signal: context.signal,
      mutation: true
    });
    try {
      await runGitCommand({
        ...this.options,
        cwd: repository.rootPath,
        args: ['worktree', 'remove', ...(force ? ['--force'] : []), owned.destination],
        signal: context.signal,
        mutation: true
      });
    } catch (error) {
      try {
        await runGitCommand({
          ...this.options,
          cwd: repository.rootPath,
          args: ['worktree', 'lock', '--reason', managedOwnershipReason(context.session, worktreeId), owned.destination],
          signal: context.signal,
          mutation: true
        });
      } catch {
        // The runtime will preserve unknown mutation status on the original failure.
      }
      throw error;
    }
    const output = { sourceRootId, worktreeRootId, worktreeId, branchName: owned.branch, force, sourceCheckoutChanged: false } as const;
    context.reportActivity({ kind: 'mutation', detail: `Removed managed Git worktree ${worktreeId}`, metadata: { ...output, mutationStatus: 'committed' } });
    return { output, mutationStatus: 'committed', retry: 'after-confirmation', metadata: output };
  }
}
