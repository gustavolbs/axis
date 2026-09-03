import type { AxisTool } from '../../agent-runtime/index.js';
import type { GitToolOptions } from './core.js';
import {
  GitBranchCreateTool,
  GitStageTool,
  GitUnstageTool,
  GitWorktreeCreateTool,
  GitWorktreeRemoveTool
} from './mutation-tools.js';
import {
  GitBranchInfoTool,
  GitCommitMetadataTool,
  GitDiffTool,
  GitStatusTool,
  GitWorktreeListTool
} from './read-tools.js';

export interface GitToolSuite {
  readonly status: GitStatusTool;
  readonly diff: GitDiffTool;
  readonly branchInfo: GitBranchInfoTool;
  readonly commitMetadata: GitCommitMetadataTool;
  readonly branchCreate: GitBranchCreateTool;
  readonly stage: GitStageTool;
  readonly unstage: GitUnstageTool;
  readonly worktreeList: GitWorktreeListTool;
  readonly worktreeCreate: GitWorktreeCreateTool;
  readonly worktreeRemove: GitWorktreeRemoveTool;
  readonly tools: readonly AxisTool[];
}

/** Provider-neutral Git construction point for later runtime composition. */
export function createGitTools(options: GitToolOptions = {}): GitToolSuite {
  const status = new GitStatusTool(options);
  const diff = new GitDiffTool(options);
  const branchInfo = new GitBranchInfoTool(options);
  const commitMetadata = new GitCommitMetadataTool(options);
  const branchCreate = new GitBranchCreateTool(options);
  const stage = new GitStageTool(options);
  const unstage = new GitUnstageTool(options);
  const worktreeList = new GitWorktreeListTool(options);
  const worktreeCreate = new GitWorktreeCreateTool(options);
  const worktreeRemove = new GitWorktreeRemoveTool(options);
  return {
    status,
    diff,
    branchInfo,
    commitMetadata,
    branchCreate,
    stage,
    unstage,
    worktreeList,
    worktreeCreate,
    worktreeRemove,
    tools: [
      status,
      diff,
      branchInfo,
      commitMetadata,
      branchCreate,
      stage,
      unstage,
      worktreeList,
      worktreeCreate,
      worktreeRemove
    ]
  };
}
