import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentRoot, AgentSessionContext, ToolExecutionContext } from '../../agent-runtime/index.js';
import { sanitizeProcessEnvironment } from '../process/environment.js';
import { runProcess } from '../process/runner.js';

export const GIT_READ_CAPABILITY = 'axis.git.read';
export const GIT_WRITE_CAPABILITY = 'axis.git.write';
export const GIT_WORKTREE_CAPABILITY = 'axis.git.worktree';

export const GIT_READ_PERMISSION = 'git.read';
export const GIT_WRITE_PERMISSION = 'git.write';
export const GIT_WORKTREE_PERMISSION = 'git.worktree';

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

export interface GitToolOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
  readonly killGraceMs?: number;
}

export interface ResolvedGitRepository {
  readonly root: AgentRoot;
  readonly rootPath: string;
  readonly gitCommonDir: string;
}

export interface ResolvedGitStorageRoot {
  readonly root: AgentRoot;
  readonly rootPath: string;
}

export class GitToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(`[${code}] ${message}`);
    this.name = 'GitToolError';
  }
}

export function requiredString(value: unknown, label: string, maxLength = 32_768): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GitToolError('axis.git.invalid_input', `${label} must be a non-empty string.`);
  }
  if (value.includes('\0')) {
    throw new GitToolError('axis.git.invalid_input', `${label} must not contain NUL bytes.`);
  }
  if (value.length > maxLength) {
    throw new GitToolError('axis.git.invalid_input', `${label} exceeds ${maxLength} characters.`);
  }
  return value;
}

export function optionalString(value: unknown, label: string, maxLength = 32_768): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, maxLength);
}

export function boundedInteger(
  value: unknown,
  label: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new GitToolError('axis.git.invalid_input', `${label} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

export function booleanValue(value: unknown, label: string, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new GitToolError('axis.git.invalid_input', `${label} must be a boolean.`);
  }
  return value;
}

export function stringArray(value: unknown, label: string, maxItems = 256): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new GitToolError(
      'axis.git.invalid_input',
      `${label} must be a non-empty array with at most ${maxItems} strings.`
    );
  }
  return value.map((item, index) => requiredString(item, `${label}[${index}]`, 8_192));
}

function assertSessionRootAuthority(session: AgentSessionContext, root: AgentRoot): void {
  if (root.companyId !== session.companyId) {
    throw new GitToolError(
      'axis.git.cross_company_denied',
      `Git root ${root.id} belongs to Company ${root.companyId}, not session Company ${session.companyId}.`
    );
  }
  if (root.projectId !== undefined && root.projectId !== session.project?.id) {
    throw new GitToolError(
      'axis.git.project_scope_denied',
      `Git root ${root.id} belongs to Project ${root.projectId}, not session Project ${session.project?.id ?? '(none)'}.`
    );
  }
}

async function resolveAuthorizedRoot(
  session: AgentSessionContext,
  rootId: string,
  requireWrite: boolean
): Promise<ResolvedGitStorageRoot> {
  if (session.executionTarget.mode !== 'workspace') {
    throw new GitToolError(
      'axis.git.execution_target_denied',
      `Execution target ${session.executionTarget.id} is inference-only and cannot execute Git workspace operations.`
    );
  }
  const root = session.roots.find((candidate) => candidate.id === rootId);
  if (!root) {
    throw new GitToolError('axis.git.root_not_authorized', `Git root ${rootId} is not authorized for this session.`);
  }
  assertSessionRootAuthority(session, root);
  if (requireWrite && root.access !== 'write') {
    throw new GitToolError('axis.git.write_denied', `Git root ${rootId} is read-only.`);
  }

  let rootPath: string;
  try {
    rootPath = await fs.realpath(root.path);
  } catch (error) {
    throw new GitToolError(
      'axis.git.root_unavailable',
      `Git root ${rootId} cannot be resolved.`,
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
  const stat = await fs.stat(rootPath);
  if (!stat.isDirectory()) {
    throw new GitToolError('axis.git.root_not_directory', `Git root ${rootId} is not a directory.`);
  }
  return { root, rootPath };
}

export interface GitCommandRequest extends GitToolOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  readonly mutation?: boolean;
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export async function runGitCommand(request: GitCommandRequest): Promise<GitCommandResult> {
  const environment = sanitizeProcessEnvironment(request.environment ?? process.env, {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    LC_ALL: 'C',
    ...(request.mutation ? {} : { GIT_OPTIONAL_LOCKS: '0' })
  });
  const result = await runProcess({
    command: 'git',
    args: request.args,
    cwd: request.cwd,
    env: environment.env,
    signal: request.signal,
    outputLimitBytes: request.outputLimitBytes ?? DEFAULT_GIT_OUTPUT_LIMIT_BYTES,
    killGraceMs: request.killGraceMs,
    onOutput: request.onOutput
      ? ({ stream, chunk }) => request.onOutput?.(stream, chunk)
      : undefined
  });
  if (result.exitCode !== 0 || result.signal !== null) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const diagnostic = (stderr || stdout || `git exited with code ${String(result.exitCode)}`).slice(0, 4_096);
    throw new GitToolError('axis.git.command_failed', diagnostic, {
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated
    });
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated
  };
}

export async function resolveGitRepository(
  context: Pick<ToolExecutionContext, 'session' | 'signal'>,
  rootId: string,
  requireWrite: boolean,
  options: GitToolOptions = {}
): Promise<ResolvedGitRepository> {
  const storage = await resolveAuthorizedRoot(context.session, rootId, requireWrite);
  const common = {
    ...options,
    cwd: storage.rootPath,
    signal: context.signal,
    mutation: false
  } as const;
  let topLevel: string;
  let commonDir: string;
  try {
    topLevel = (await runGitCommand({ ...common, args: ['rev-parse', '--show-toplevel'] })).stdout.trim();
    commonDir = (await runGitCommand({ ...common, args: ['rev-parse', '--git-common-dir'] })).stdout.trim();
  } catch (error) {
    if (error instanceof GitToolError) {
      throw new GitToolError('axis.git.not_repository', `Root ${rootId} is not an accessible Git worktree.`, {
        cause: error.message
      });
    }
    throw error;
  }

  const repositoryPath = await fs.realpath(path.resolve(storage.rootPath, topLevel));
  if (repositoryPath !== storage.rootPath) {
    throw new GitToolError(
      'axis.git.implicit_repository_denied',
      `Root ${rootId} resolves inside a larger repository. Authorize the repository checkout itself as a distinct session root.`
    );
  }
  const gitCommonDir = await fs.realpath(path.resolve(storage.rootPath, commonDir));
  return { root: storage.root, rootPath: storage.rootPath, gitCommonDir };
}

export async function resolveGitStorageRoot(
  session: AgentSessionContext,
  rootId: string
): Promise<ResolvedGitStorageRoot> {
  return await resolveAuthorizedRoot(session, rootId, true);
}

export function assertDisjointRoots(left: string, right: string): void {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  const overlaps = relativeLeft === '' ||
    (!relativeLeft.startsWith('..') && !path.isAbsolute(relativeLeft)) ||
    (!relativeRight.startsWith('..') && !path.isAbsolute(relativeRight));
  if (overlaps) {
    throw new GitToolError(
      'axis.git.overlapping_roots_denied',
      'The source checkout and managed worktree storage root must be disjoint.'
    );
  }
}

export function assertLiteralRelativePath(value: string): string {
  const normalized = requiredString(value, 'Git path', 8_192);
  if (path.isAbsolute(normalized)) {
    throw new GitToolError('axis.git.path_scope_denied', `Git path must be root-relative: ${normalized}`);
  }
  const resolved = path.normalize(normalized);
  if (resolved === '..' || resolved.startsWith(`..${path.sep}`)) {
    throw new GitToolError('axis.git.path_scope_denied', `Git path escapes the authorized repository: ${normalized}`);
  }
  if (normalized.startsWith(':')) {
    throw new GitToolError('axis.git.pathspec_magic_denied', `Git pathspec magic is not allowed: ${normalized}`);
  }
  return normalized;
}

export async function validateCommitRef(
  repository: ResolvedGitRepository,
  ref: string,
  signal: AbortSignal,
  options: GitToolOptions = {}
): Promise<string> {
  const normalized = requiredString(ref, 'Git ref', 1_024);
  if (normalized.startsWith('-')) {
    throw new GitToolError('axis.git.invalid_ref', `Git ref must not begin with '-': ${normalized}`);
  }
  const result = await runGitCommand({
    ...options,
    cwd: repository.rootPath,
    args: ['rev-parse', '--verify', `${normalized}^{commit}`],
    signal
  });
  return result.stdout.trim();
}

export async function validateBranchName(
  repository: ResolvedGitRepository,
  branchName: string,
  signal: AbortSignal,
  options: GitToolOptions = {}
): Promise<string> {
  const normalized = requiredString(branchName, 'Git branch name', 512);
  if (normalized.startsWith('-')) {
    throw new GitToolError('axis.git.invalid_branch', `Git branch must not begin with '-': ${normalized}`);
  }
  await runGitCommand({
    ...options,
    cwd: repository.rootPath,
    args: ['check-ref-format', '--branch', normalized],
    signal
  });
  return normalized;
}

export function managedWorktreeId(session: AgentSessionContext, callId: string, branchName: string): string {
  const digest = createHash('sha256')
    .update(`${session.companyId}\0${session.project?.id ?? ''}\0${session.sessionId}\0${callId}\0${branchName}`)
    .digest('hex')
    .slice(0, 20);
  return `wt-${digest}`;
}

export function managedOwnershipReason(session: AgentSessionContext, worktreeId: string): string {
  const scope = createHash('sha256')
    .update(`${session.companyId}\0${session.project?.id ?? ''}\0${session.sessionId}`)
    .digest('hex')
    .slice(0, 16);
  return `axis:${scope}:${worktreeId}`;
}

export interface ParsedWorktreeRecord {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly lockedReason?: string;
  readonly prunableReason?: string;
}

export function parseWorktreePorcelain(value: string): ParsedWorktreeRecord[] {
  const records: ParsedWorktreeRecord[] = [];
  for (const block of value.trim().split(/\r?\n\r?\n/).filter(Boolean)) {
    let worktreePath = '';
    let head: string | undefined;
    let branch: string | undefined;
    let bare = false;
    let detached = false;
    let lockedReason: string | undefined;
    let prunableReason: string | undefined;
    for (const line of block.split(/\r?\n/)) {
      const space = line.indexOf(' ');
      const key = space === -1 ? line : line.slice(0, space);
      const item = space === -1 ? '' : line.slice(space + 1);
      if (key === 'worktree') worktreePath = item;
      else if (key === 'HEAD') head = item;
      else if (key === 'branch') branch = item.replace(/^refs\/heads\//, '');
      else if (key === 'bare') bare = true;
      else if (key === 'detached') detached = true;
      else if (key === 'locked') lockedReason = item || undefined;
      else if (key === 'prunable') prunableReason = item || undefined;
    }
    if (worktreePath) records.push({
      path: worktreePath,
      head,
      branch,
      bare,
      detached,
      lockedReason,
      prunableReason
    });
  }
  return records;
}

export function withinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
