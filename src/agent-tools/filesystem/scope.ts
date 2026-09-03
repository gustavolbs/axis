import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentRoot, AgentSessionContext } from '../../agent-runtime/index.js';
import { filesystemError } from './errors.js';

export interface ResolvedFilesystemRoot {
  readonly root: AgentRoot;
  readonly realPath: string;
}

export interface ResolvedFilesystemPath extends ResolvedFilesystemRoot {
  /** Canonical existing target, or a lexical path below the canonical root when missing. */
  readonly targetPath: string;
  readonly relativePath: string;
  readonly exists: boolean;
}

function isOutside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function normalizedRelativePath(value: string, allowRoot: boolean): string {
  if (value.includes('\0')) filesystemError('filesystem_invalid_path', 'Paths must not contain NUL bytes.');
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    filesystemError('filesystem_invalid_path', `Filesystem paths must be relative to an authorized root: ${value}`);
  }

  const platformNeutral = value.replace(/[\\/]+/g, path.sep);
  const normalized = path.normalize(platformNeutral || '.');
  if (!allowRoot && (normalized === '.' || normalized === '')) {
    filesystemError('filesystem_invalid_path', 'A file path relative to the authorized root is required.');
  }
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    filesystemError('filesystem_path_escape', `Path escapes the authorized root: ${value}`);
  }
  return normalized;
}

export async function resolveFilesystemRoot(
  session: AgentSessionContext,
  rootId: string,
  access: 'read' | 'write'
): Promise<ResolvedFilesystemRoot> {
  if (!rootId.trim()) filesystemError('filesystem_invalid_arguments', 'rootId must not be empty.');
  const root = session.roots.find((candidate) => candidate.id === rootId);
  if (!root) filesystemError('filesystem_root_not_found', `Root ${rootId} is not authorized for this session.`);

  if (root.companyId !== session.companyId || (root.projectId !== undefined && root.projectId !== session.project?.id)) {
    filesystemError(
      'filesystem_root_scope_mismatch',
      `Root ${root.id} does not belong to the active Company/Project session scope.`,
      { rootCompanyId: root.companyId, rootProjectId: root.projectId, sessionCompanyId: session.companyId, sessionProjectId: session.project?.id }
    );
  }
  if (access === 'write' && root.access !== 'write') {
    filesystemError('filesystem_root_read_only', `Root ${root.id} is read-only for this session.`);
  }
  if (!path.isAbsolute(root.path)) {
    filesystemError('filesystem_invalid_root', `Authorized root ${root.id} must use an absolute path.`);
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(root.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    filesystemError(
      code === 'ENOENT' ? 'filesystem_not_found' : 'filesystem_io_error',
      `Unable to resolve authorized root ${root.id}: ${error instanceof Error ? error.message : String(error)}`,
      { rootId: root.id, errno: code }
    );
  }

  const stat = await fs.stat(realPath!);
  if (!stat.isDirectory()) filesystemError('filesystem_invalid_root', `Authorized root ${root.id} is not a directory.`);
  return { root, realPath: realPath! };
}

async function nearestExistingPath(candidate: string): Promise<{ path: string; realPath: string }> {
  let current = candidate;
  while (true) {
    try {
      const lstat = await fs.lstat(current);
      try {
        return { path: current, realPath: await fs.realpath(current) };
      } catch (error) {
        if (lstat.isSymbolicLink() && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          filesystemError('filesystem_broken_symlink', `Broken symlink cannot be used as a filesystem target: ${current}`);
        }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function resolveFilesystemPath(
  session: AgentSessionContext,
  rootId: string,
  relativeInput: string,
  options: { access: 'read' | 'write'; allowRoot?: boolean; mustExist?: boolean }
): Promise<ResolvedFilesystemPath> {
  const resolvedRoot = await resolveFilesystemRoot(session, rootId, options.access);
  const relativePath = normalizedRelativePath(relativeInput, options.allowRoot ?? false);
  const lexicalPath = path.resolve(resolvedRoot.realPath, relativePath);
  if (isOutside(resolvedRoot.realPath, lexicalPath)) {
    filesystemError('filesystem_path_escape', `Path escapes authorized root ${rootId}: ${relativeInput}`);
  }

  try {
    const lstat = await fs.lstat(lexicalPath);
    let targetPath: string;
    try {
      targetPath = await fs.realpath(lexicalPath);
    } catch (error) {
      if (lstat.isSymbolicLink() && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        filesystemError('filesystem_broken_symlink', `Broken symlink is not an allowed filesystem target: ${relativeInput}`);
      }
      throw error;
    }
    if (isOutside(resolvedRoot.realPath, targetPath)) {
      filesystemError('filesystem_symlink_escape', `Symlink resolution escapes authorized root ${rootId}: ${relativeInput}`);
    }
    return { ...resolvedRoot, targetPath, relativePath, exists: true };
  } catch (error) {
    if (error instanceof Error && error.name === 'FilesystemToolError') throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      filesystemError(
        'filesystem_io_error',
        `Unable to inspect ${relativeInput}: ${error instanceof Error ? error.message : String(error)}`,
        { rootId, path: relativeInput, errno: (error as NodeJS.ErrnoException).code }
      );
    }
  }

  if (options.mustExist) filesystemError('filesystem_not_found', `Path does not exist: ${relativeInput}`);
  try {
    const ancestor = await nearestExistingPath(path.dirname(lexicalPath));
    if (isOutside(resolvedRoot.realPath, ancestor.realPath)) {
      filesystemError('filesystem_symlink_escape', `Parent symlink resolution escapes authorized root ${rootId}: ${relativeInput}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'FilesystemToolError') throw error;
    filesystemError(
      'filesystem_io_error',
      `Unable to resolve parent path for ${relativeInput}: ${error instanceof Error ? error.message : String(error)}`,
      { rootId, path: relativeInput, errno: (error as NodeJS.ErrnoException).code }
    );
  }

  return { ...resolvedRoot, targetPath: lexicalPath, relativePath, exists: false };
}

export function toRootRelative(rootRealPath: string, absolutePath: string): string {
  const relative = path.relative(rootRealPath, absolutePath);
  if (relative === '') return '.';
  return relative.split(path.sep).join('/');
}
