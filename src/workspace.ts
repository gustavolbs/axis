import fs from 'node:fs/promises';
import path from 'node:path';

const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules', '.ssh']);

function hasBlockedSegment(relativePath: string): boolean {
  return relativePath.split(path.sep).some((segment) => BLOCKED_SEGMENTS.has(segment));
}

function isSensitiveEnvFile(relativePath: string): boolean {
  const basename = path.basename(relativePath);
  return basename === '.env' || basename.startsWith('.env.');
}

export async function resolveWorkspace(workspace: string): Promise<string> {
  if (!path.isAbsolute(workspace)) {
    throw new Error('workspace must be an absolute path.');
  }

  const resolved = await fs.realpath(workspace);
  const stat = await fs.stat(resolved);

  if (!stat.isDirectory()) {
    throw new Error(`workspace is not a directory: ${resolved}`);
  }

  return resolved;
}

export function resolveWorkspacePath(workspace: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`File path must be relative to the workspace: ${relativePath}`);
  }

  const normalized = path.normalize(relativePath);
  const resolved = path.resolve(workspace, normalized);
  const relative = path.relative(workspace, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }

  if (hasBlockedSegment(relative) || isSensitiveEnvFile(relative)) {
    throw new Error(`Path is blocked by local-coder policy: ${relativePath}`);
  }

  return resolved;
}

export interface WorkspaceFileSnapshot {
  path: string;
  content: string | null;
}

export async function readWorkspaceFile(
  workspace: string,
  relativePath: string,
  maxBytes: number
): Promise<WorkspaceFileSnapshot> {
  const absolutePath = resolveWorkspacePath(workspace, relativePath);

  try {
    const stat = await fs.stat(absolutePath);

    if (!stat.isFile()) {
      throw new Error(`Not a regular file: ${relativePath}`);
    }

    if (stat.size > maxBytes) {
      throw new Error(`File exceeds ${maxBytes} bytes: ${relativePath}`);
    }

    return {
      path: relativePath,
      content: await fs.readFile(absolutePath, 'utf8')
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: relativePath, content: null };
    }

    throw error;
  }
}

export async function writeWorkspaceFile(
  workspace: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = resolveWorkspacePath(workspace, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf8');
}

export async function restoreWorkspaceFile(
  workspace: string,
  snapshot: WorkspaceFileSnapshot
): Promise<void> {
  const absolutePath = resolveWorkspacePath(workspace, snapshot.path);

  if (snapshot.content === null) {
    await fs.rm(absolutePath, { force: true });
    return;
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, snapshot.content, 'utf8');
}
