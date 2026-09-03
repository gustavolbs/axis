import fs from 'node:fs/promises';
import path from 'node:path';

import type { AxisTool, ToolExecutionContext } from '../../agent-runtime/index.js';
import { throwIfCancelled } from '../../cancellation.js';
import { filesystemError } from './errors.js';
import {
  activity,
  booleanArg,
  FILESYSTEM_CAPABILITIES,
  FILESYSTEM_PERMISSIONS,
  integerArg,
  ioError,
  progress,
  stringArg,
  WRITE_TIMEOUT_MS
} from './io.js';
import { resolveFilesystemPath } from './scope.js';

async function assertNotTopLevelSymlink(rootPath: string, relativePath: string): Promise<void> {
  const lexical = path.resolve(rootPath, relativePath);
  const stat = await fs.lstat(lexical);
  if (stat.isSymbolicLink()) {
    filesystemError('filesystem_unsupported_operation', `This operation refuses a symbolic-link source: ${relativePath}`);
  }
}

async function copyTree(
  context: ToolExecutionContext,
  sourcePath: string,
  destinationPath: string,
  relativeLabel: string
): Promise<{ files: number; directories: number }> {
  throwIfCancelled(context.signal);
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    filesystemError('filesystem_unsupported_operation', `copy_path refuses symbolic links inside the copied tree: ${relativeLabel}`);
  }
  if (stat.isFile()) {
    await fs.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    await fs.chmod(destinationPath, stat.mode & 0o777);
    return { files: 1, directories: 0 };
  }
  if (!stat.isDirectory()) {
    filesystemError('filesystem_unsupported_operation', `copy_path supports only regular files and directories: ${relativeLabel}`);
  }

  await fs.mkdir(destinationPath, { mode: stat.mode & 0o777 });
  let files = 0;
  let directories = 1;
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  for (let index = 0; index < entries.length; index += 1) {
    throwIfCancelled(context.signal);
    const entry = entries[index]!;
    const childRelative = `${relativeLabel}/${entry.name}`;
    const copied = await copyTree(
      context,
      path.join(sourcePath, entry.name),
      path.join(destinationPath, entry.name),
      childRelative
    );
    files += copied.files;
    directories += copied.directories;
    if ((files + directories) % 50 === 0) {
      progress(context, `Copying ${relativeLabel}`, { files, directories });
    }
  }
  return { files, directories };
}

export const createDirectoryTool: AxisTool = {
  definition: {
    name: 'create_directory',
    description: 'Create one directory inside a writable authorized root. The parent directory must already exist.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rootId', 'path'],
      properties: { rootId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 } }
    },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.write], requiredPermissions: [FILESYSTEM_PERMISSIONS.write],
    effect: 'mutation', mutationRisk: 'definite', retryOnFailure: 'after-confirmation', timeoutMs: WRITE_TIMEOUT_MS
  },
  async execute(context) {
    const rootId = stringArg(context.call.arguments, 'rootId', { required: true });
    const relativePath = stringArg(context.call.arguments, 'path', { required: true });
    const resolved = await resolveFilesystemPath(context.session, rootId, relativePath, { access: 'write', mustExist: false });
    if (resolved.exists) filesystemError('filesystem_already_exists', `Path already exists: ${relativePath}`);
    const parent = await resolveFilesystemPath(context.session, rootId, path.dirname(relativePath), { access: 'write', allowRoot: true, mustExist: true });
    const parentStat = await fs.stat(parent.targetPath);
    if (!parentStat.isDirectory()) filesystemError('filesystem_not_directory', `Parent is not a directory: ${path.dirname(relativePath)}`);
    activity(context, 'mutation', `Creating directory ${relativePath}`, { rootId, path: relativePath });
    try { await fs.mkdir(resolved.targetPath); }
    catch (error) { ioError(error, 'create directory', relativePath); }
    await resolveFilesystemPath(context.session, rootId, relativePath, { access: 'write', mustExist: true });
    return { output: { rootId, path: relativePath }, mutationStatus: 'committed', retry: 'after-confirmation', metadata: { rootId, path: relativePath } };
  }
};

export const movePathTool: AxisTool = {
  definition: {
    name: 'move_path',
    description: 'Atomically rename or move a file/directory inside the same writable authorized root. Cross-device fallback is intentionally refused.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rootId', 'from', 'to'],
      properties: { rootId: { type: 'string', minLength: 1 }, from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } }
    },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.write], requiredPermissions: [FILESYSTEM_PERMISSIONS.write],
    effect: 'mutation', mutationRisk: 'definite', retryOnFailure: 'after-confirmation', timeoutMs: WRITE_TIMEOUT_MS
  },
  async execute(context) {
    const args = context.call.arguments;
    const rootId = stringArg(args, 'rootId', { required: true });
    const from = stringArg(args, 'from', { required: true });
    const to = stringArg(args, 'to', { required: true });
    const source = await resolveFilesystemPath(context.session, rootId, from, { access: 'write', mustExist: true });
    const destination = await resolveFilesystemPath(context.session, rootId, to, { access: 'write', mustExist: false });
    if (destination.exists) filesystemError('filesystem_already_exists', `Destination already exists: ${to}`);
    await assertNotTopLevelSymlink(source.realPath, source.relativePath);
    const parent = await resolveFilesystemPath(context.session, rootId, path.dirname(to), { access: 'write', allowRoot: true, mustExist: true });
    if (!(await fs.stat(parent.targetPath)).isDirectory()) filesystemError('filesystem_not_directory', `Destination parent is not a directory: ${path.dirname(to)}`);
    activity(context, 'mutation', `Moving ${from} to ${to}`, { rootId, from, to });
    try { await fs.rename(source.targetPath, destination.targetPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        filesystemError('filesystem_unsupported_operation', 'move_path refuses cross-device fallback because copy+delete would make mutation status uncertain.');
      }
      ioError(error, 'move', from);
    }
    return { output: { rootId, from, to }, mutationStatus: 'committed', retry: 'after-confirmation', metadata: { rootId, from, to } };
  }
};

export const copyPathTool: AxisTool = {
  definition: {
    name: 'copy_path',
    description: 'Copy a regular file or directory tree inside the same authorized root without following symbolic links. Destination must not exist.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rootId', 'from', 'to'],
      properties: { rootId: { type: 'string', minLength: 1 }, from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } }
    },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.read, FILESYSTEM_CAPABILITIES.write],
    requiredPermissions: [FILESYSTEM_PERMISSIONS.read, FILESYSTEM_PERMISSIONS.write],
    effect: 'mutation', mutationRisk: 'definite', retryOnFailure: 'after-confirmation', timeoutMs: WRITE_TIMEOUT_MS
  },
  async execute(context) {
    const args = context.call.arguments;
    const rootId = stringArg(args, 'rootId', { required: true });
    const from = stringArg(args, 'from', { required: true });
    const to = stringArg(args, 'to', { required: true });
    const source = await resolveFilesystemPath(context.session, rootId, from, { access: 'read', mustExist: true });
    const destination = await resolveFilesystemPath(context.session, rootId, to, { access: 'write', mustExist: false });
    if (destination.exists) filesystemError('filesystem_already_exists', `Destination already exists: ${to}`);
    await assertNotTopLevelSymlink(source.realPath, source.relativePath);
    const parent = await resolveFilesystemPath(context.session, rootId, path.dirname(to), { access: 'write', allowRoot: true, mustExist: true });
    if (!(await fs.stat(parent.targetPath)).isDirectory()) filesystemError('filesystem_not_directory', `Destination parent is not a directory: ${path.dirname(to)}`);
    activity(context, 'mutation', `Copying ${from} to ${to}`, { rootId, from, to });
    let counts: { files: number; directories: number };
    try { counts = await copyTree(context, source.targetPath, destination.targetPath, from); }
    catch (error) {
      await fs.rm(destination.targetPath, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof Error && error.name === 'FilesystemToolError') throw error;
      ioError(error, 'copy', from);
    }
    return { output: { rootId, from, to, ...counts! }, mutationStatus: 'committed', retry: 'after-confirmation', metadata: { rootId, from, to, ...counts! } };
  }
};

export const deletePathTool: AxisTool = {
  definition: {
    name: 'delete_path',
    description: 'Delete a file or directory inside a writable authorized root. Non-empty directories require recursive=true. This operation is intentionally explicit and may be irreversible.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rootId', 'path'],
      properties: { rootId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, recursive: { type: 'boolean' } }
    },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.write],
    requiredPermissions: [FILESYSTEM_PERMISSIONS.write, 'workspace.delete'],
    effect: 'mutation', mutationRisk: 'definite', retryOnFailure: 'never', timeoutMs: WRITE_TIMEOUT_MS
  },
  async execute(context) {
    const rootId = stringArg(context.call.arguments, 'rootId', { required: true });
    const relativePath = stringArg(context.call.arguments, 'path', { required: true });
    const recursive = booleanArg(context.call.arguments, 'recursive', false);
    const resolved = await resolveFilesystemPath(context.session, rootId, relativePath, { access: 'write', mustExist: true });
    await assertNotTopLevelSymlink(resolved.realPath, resolved.relativePath);
    const stat = await fs.stat(resolved.targetPath);
    if (stat.isDirectory() && !recursive) {
      const entries = await fs.readdir(resolved.targetPath);
      if (entries.length > 0) filesystemError('filesystem_not_empty', `Directory is not empty; recursive=true is required: ${relativePath}`);
    }
    activity(context, 'mutation', `Deleting ${relativePath}`, { rootId, path: relativePath, recursive });
    try { await fs.rm(resolved.targetPath, { recursive: stat.isDirectory() && recursive, force: false }); }
    catch (error) { ioError(error, 'delete', relativePath); }
    return { output: { rootId, path: relativePath, recursive }, mutationStatus: 'committed', retry: 'never', metadata: { rootId, path: relativePath, recursive } };
  }
};

export const setFileModeTool: AxisTool = {
  definition: {
    name: 'set_file_mode',
    description: 'Set POSIX permission bits for a file or directory inside a writable authorized root. Symbolic-link targets are refused.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rootId', 'path', 'mode'],
      properties: { rootId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, mode: { type: 'integer', minimum: 0, maximum: 511 } }
    },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.write], requiredPermissions: [FILESYSTEM_PERMISSIONS.write],
    effect: 'mutation', mutationRisk: 'definite', retryOnFailure: 'after-confirmation', timeoutMs: WRITE_TIMEOUT_MS
  },
  async execute(context) {
    const rootId = stringArg(context.call.arguments, 'rootId', { required: true });
    const relativePath = stringArg(context.call.arguments, 'path', { required: true });
    const mode = integerArg(context.call.arguments, 'mode', 0o644, 0, 0o777);
    const resolved = await resolveFilesystemPath(context.session, rootId, relativePath, { access: 'write', mustExist: true });
    await assertNotTopLevelSymlink(resolved.realPath, resolved.relativePath);
    activity(context, 'mutation', `Changing mode for ${relativePath}`, { rootId, path: relativePath, mode });
    try { await fs.chmod(resolved.targetPath, mode); }
    catch (error) { ioError(error, 'chmod', relativePath); }
    return { output: { rootId, path: relativePath, mode }, mutationStatus: 'committed', retry: 'after-confirmation', metadata: { rootId, path: relativePath, mode } };
  }
};
