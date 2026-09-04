import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parseWorktreePorcelain, runGitCommand } from './agent-tools/git/core.js';

export interface ManagedJobWorktree {
  readonly id: string;
  readonly companyId: string;
  readonly projectId?: string;
  readonly sourceWorkspace: string;
  readonly workspace: string;
  readonly branchName: string;
  readonly ownershipLock: string;
  readonly createdAt: string;
}

export class JobWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobWorktreeError';
  }
}

function identity(companyId: string, projectId: string | undefined, source: string, jobId: string): string {
  return createHash('sha256').update(`${companyId}\0${projectId ?? ''}\0${source}\0${jobId}`).digest('hex');
}

async function git(cwd: string, args: readonly string[], signal: AbortSignal, mutation = false): Promise<string> {
  return (await runGitCommand({ cwd, args, signal, mutation })).stdout.trim();
}

/**
 * Product-level worktree lifecycle. This runs before AgentRuntime composition,
 * so the immutable session receives the managed checkout—not the source checkout.
 */
export class JobWorktreeManager {
  constructor(private readonly storageRoot?: string) {}

  get enabled(): boolean {
    return Boolean(this.storageRoot);
  }

  async prepare(input: {
    readonly jobId: string;
    readonly companyId: string;
    readonly projectId?: string;
    readonly sourceWorkspace: string;
    readonly existing?: ManagedJobWorktree;
    readonly signal: AbortSignal;
  }): Promise<ManagedJobWorktree | undefined> {
    if (!this.storageRoot) return undefined;
    const source = await fs.realpath(input.sourceWorkspace);
    try {
      await git(source, ['rev-parse', '--show-toplevel'], input.signal);
    } catch {
      // Non-Git workspaces have no source checkout to protect.
      return undefined;
    }
    if (input.existing) {
      if (
        input.existing.companyId !== input.companyId ||
        input.existing.projectId !== input.projectId ||
        path.resolve(input.existing.sourceWorkspace) !== path.resolve(input.sourceWorkspace)
      ) {
        throw new JobWorktreeError('Managed worktree ownership does not match the current Company, Project, or source checkout.');
      }
      return await this.recover(input.existing, input.signal);
    }

    const digest = identity(input.companyId, input.projectId, source, input.jobId);
    const id = `wt-${digest.slice(0, 20)}`;
    const root = path.join(this.storageRoot, digest.slice(0, 16));
    const branchName = `axis/job-${input.jobId}`;
    const ownershipLock = `axis:${digest.slice(0, 16)}:${id}`;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const workspace = path.join(await fs.realpath(root), id);
    try {
      await fs.access(workspace);
      throw new JobWorktreeError(`Managed worktree destination already exists: ${id}.`);
    } catch (error) {
      if (error instanceof JobWorktreeError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await git(source, ['worktree', 'add', '-b', branchName, workspace, 'HEAD'], input.signal, true);
    try {
      const resolved = await fs.realpath(workspace);
      if (resolved !== workspace) throw new JobWorktreeError(`Managed worktree ${id} resolved unexpectedly.`);
      await git(source, ['worktree', 'lock', '--reason', ownershipLock, workspace], input.signal, true);
    } catch (error) {
      // Keep any uncertain creation visible and locked rather than deleting a path
      // that may contain a user-visible mutation after an interrupted setup.
      throw new JobWorktreeError(
        `Managed worktree ${id} could not be verified: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return { id, companyId: input.companyId, projectId: input.projectId, sourceWorkspace: input.sourceWorkspace, workspace, branchName, ownershipLock, createdAt: new Date().toISOString() };
  }

  async cleanup(worktree: ManagedJobWorktree, signal: AbortSignal): Promise<void> {
    await this.recover(worktree, signal);
    const dirty = await git(worktree.workspace, ['status', '--porcelain=v1', '--untracked-files=all'], signal);
    if (dirty) {
      throw new JobWorktreeError(
        `Managed worktree ${worktree.id} contains unintegrated changes and was preserved.`
      );
    }
    const branchTip = await git(worktree.workspace, ['rev-parse', 'HEAD'], signal);
    const sourceTip = await git(worktree.sourceWorkspace, ['rev-parse', 'HEAD'], signal);
    if (branchTip !== sourceTip) {
      try {
        await git(worktree.sourceWorkspace, ['merge-base', '--is-ancestor', branchTip, sourceTip], signal);
      } catch {
        throw new JobWorktreeError(
          `Managed worktree ${worktree.id} contains commits not integrated into the source checkout and was preserved.`
        );
      }
    }
    await git(worktree.sourceWorkspace, ['worktree', 'unlock', worktree.workspace], signal, true);
    try {
      await git(worktree.sourceWorkspace, ['worktree', 'remove', worktree.workspace], signal, true);
    } catch (error) {
      try {
        await git(worktree.sourceWorkspace, ['worktree', 'lock', '--reason', worktree.ownershipLock, worktree.workspace], signal, true);
      } catch {
        // The original removal error is more useful, and a failed re-lock leaves
        // the worktree visibly unresolved rather than pretending cleanup succeeded.
      }
      throw error;
    }
  }

  private async recover(worktree: ManagedJobWorktree, signal: AbortSignal): Promise<ManagedJobWorktree> {
    const source = await fs.realpath(worktree.sourceWorkspace);
    const workspace = path.resolve(worktree.workspace);
    const listed = parseWorktreePorcelain(await git(source, ['worktree', 'list', '--porcelain'], signal));
    const record = listed.find((entry) => path.resolve(entry.path) === workspace);
    if (!record || record.branch !== worktree.branchName || record.lockedReason !== worktree.ownershipLock) {
      throw new JobWorktreeError(`Managed worktree ${worktree.id} cannot be recovered with its recorded ownership.`);
    }
    if (await fs.realpath(workspace) !== workspace) {
      throw new JobWorktreeError(`Managed worktree ${worktree.id} resolved unexpectedly during recovery.`);
    }
    return { ...worktree, workspace };
  }
}
