import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveWorkspace } from './workspace.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

export type ProjectGitDiffScope = 'working' | 'staged' | 'branch';

export interface ProjectGitReviewSource {
  id: string;
  workspace: string;
}

export interface ProjectGitReview {
  scope: ProjectGitDiffScope;
  workspace: string;
  repositoryRoot: string;
  diff: string;
  status: string[];
  clean: boolean;
  baseRef?: string;
  generatedAt: string;
}

function normalizeScope(value: string | null | undefined): ProjectGitDiffScope {
  if (value === 'staged' || value === 'branch') return value;
  return 'working';
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

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const output = await git(cwd, args);
    return output || undefined;
  } catch {
    return undefined;
  }
}

async function branchBase(workspace: string): Promise<string> {
  const upstream = await tryGit(workspace, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream) return upstream;
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const exists = await tryGit(workspace, ['rev-parse', '--verify', '--quiet', candidate]);
    if (exists) return candidate;
  }
  throw new Error('No upstream, main, or master ref is available for Branch review.');
}

/**
 * Read Git state only from a Project-owned workspace. The caller must resolve
 * Company ownership before invoking this helper; no arbitrary cwd or path is
 * accepted from the renderer.
 */
export async function readProjectGitReview(
  project: ProjectGitReviewSource,
  requestedScope?: string | null
): Promise<ProjectGitReview> {
  const configuredWorkspace = project.workspace.trim();
  if (!configuredWorkspace) throw new Error(`Project ${project.id} has no folder configured.`);
  const workspace = await resolveWorkspace(configuredWorkspace);
  const repositoryRoot = await git(workspace, ['rev-parse', '--show-toplevel']);
  const scope = normalizeScope(requestedScope);
  const baseRef = scope === 'branch' ? await branchBase(workspace) : undefined;
  const diffArgs = scope === 'staged'
    ? ['diff', '--cached', '--no-ext-diff', '--no-color', '--unified=3', '--']
    : scope === 'branch'
      ? ['diff', '--no-ext-diff', '--no-color', '--unified=3', `${baseRef}...HEAD`, '--']
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
    baseRef,
    generatedAt: new Date().toISOString()
  };
}
