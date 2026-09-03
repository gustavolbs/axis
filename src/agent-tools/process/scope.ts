import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentRoot, AgentSessionContext } from '../../agent-runtime/index.js';

export interface ResolvedProcessScope {
  readonly root: AgentRoot;
  readonly rootPath: string;
  readonly cwdPath: string;
  readonly cwd: string;
}

function assertWithinRoot(rootPath: string, targetPath: string, label: string): void {
  const relative = path.relative(rootPath, targetPath);
  if (relative === '') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the authorized process root.`);
  }
}

/**
 * Process calls identify an exact session root and a root-relative cwd. The real
 * path comparison prevents a cwd symlink from escaping the authority frozen into
 * AgentSessionContext.
 */
export async function resolveProcessScope(
  session: AgentSessionContext,
  rootId: string,
  cwd: string,
  mutation: 'read-only' | 'workspace'
): Promise<ResolvedProcessScope> {
  if (session.executionTarget.mode !== 'workspace') {
    throw new Error(
      `Execution target ${session.executionTarget.id} is inference-only and cannot execute workspace processes.`
    );
  }

  const root = session.roots.find((candidate) => candidate.id === rootId);
  if (!root) {
    throw new Error(`Process root ${rootId} is not authorized for this session.`);
  }
  if (mutation === 'workspace' && root.access !== 'write') {
    throw new Error(`Process root ${rootId} is read-only; mutating commands require write access.`);
  }
  if (!cwd.trim()) throw new Error('Process cwd must not be empty.');
  if (path.isAbsolute(cwd)) {
    throw new Error('Process cwd must be relative to the selected session root.');
  }

  const rootPath = await fs.realpath(root.path);
  const rootStat = await fs.stat(rootPath);
  if (!rootStat.isDirectory()) throw new Error(`Process root is not a directory: ${root.path}`);

  const lexicalCwd = path.resolve(rootPath, cwd);
  assertWithinRoot(rootPath, lexicalCwd, 'Process cwd');

  let cwdPath: string;
  try {
    cwdPath = await fs.realpath(lexicalCwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Process cwd does not exist: ${cwd}`);
    }
    throw error;
  }
  assertWithinRoot(rootPath, cwdPath, 'Process cwd symlink resolution');

  const cwdStat = await fs.stat(cwdPath);
  if (!cwdStat.isDirectory()) throw new Error(`Process cwd is not a directory: ${cwd}`);

  return {
    root,
    rootPath,
    cwdPath,
    cwd: path.relative(rootPath, cwdPath) || '.'
  };
}

export function assertPathArgumentWithinRoot(rootPath: string, value: string): void {
  let candidate = value;
  const equals = candidate.indexOf('=');
  if (equals > 0) candidate = candidate.slice(equals + 1);

  const pathLike = path.isAbsolute(candidate) ||
    candidate === '..' ||
    candidate.startsWith(`..${path.sep}`) ||
    candidate.startsWith('../') ||
    candidate.startsWith('..\\') ||
    candidate.startsWith(`.${path.sep}`) ||
    candidate.startsWith('./') ||
    candidate.startsWith('.\\');
  if (!pathLike) return;

  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(rootPath, candidate);
  assertWithinRoot(rootPath, resolved, `Process argument ${value}`);
}
