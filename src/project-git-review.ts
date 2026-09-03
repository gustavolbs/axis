import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ProjectDefinition } from './project-store.js';
import { resolveWorkspace } from './workspace.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

export type ProjectGitDiffScope = 'working' | 'staged';

export interface ProjectGitReview {
  scope: ProjectGitDiffScope;
  workspace: string;
  repositoryRoot: string;
  diff: string;
  status: string[];
  clean: boolean;
  generatedAt: string;
}

function normalizeScope(value: string | null | undefined): ProjectGitDiffScope {
  return value === 'staged' ? 'staged' : 'working';
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: MAX_GIT_OUTPUT,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0'
    }
  });
  return result.stdout.trimEnd();
}

/**
 * Read Git state only from a Project-owned workspace. The caller must resolve
 * Company ownership before invoking this helper; no arbitrary cwd or path is
 * accepted from the renderer.
 */
export async function readProjectGitReview(
  project: ProjectDefinition,
  requestedScope?: string | null
): Promise<ProjectGitReview> {
  const configuredWorkspace = project.workspace.trim();
  if (!configuredWorkspace) throw new Error(`Project ${project.id} has no folder configured.`);
  const workspace = await resolveWorkspace(configuredWorkspace);
  const repositoryRoot = await git(workspace, ['rev-parse', '--show-toplevel']);
  const scope = normalizeScope(requestedScope);
  const diffArgs = scope === 'staged'
    ? ['diff', '--cached', '--no-ext-diff', '--no-color', '--unified=3', '--']
    : ['diff', '--no-ext-diff', '--no-color', '--unified=3', '--'];
  const [diff, porcelain] = await Promise.all([
    git(workspace, diffArgs),
    git(workspace, ['status', '--porcelain=v1', '--untracked-files=normal'])
  ]);
  const status = porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [];
  return {
    scope,
    workspace,
    repositoryRoot,
    diff,
    status,
    clean: status.length === 0,
    generatedAt: new Date().toISOString()
  };
}
