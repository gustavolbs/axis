import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { OperationCancelledError, throwIfCancelled } from '../../cancellation.js';
import type { AgentSessionContext, ToolExecutionContext } from '../../agent-runtime/index.js';
import { FilesystemToolError, filesystemError } from './errors.js';
import { resolveFilesystemPath, type ResolvedFilesystemPath } from './scope.js';

export const FILESYSTEM_CAPABILITIES = Object.freeze({
  read: 'axis.filesystem.read',
  write: 'axis.filesystem.write'
} as const);

export const FILESYSTEM_PERMISSIONS = Object.freeze({
  read: 'workspace.read',
  write: 'workspace.write'
} as const);

export const READ_TIMEOUT_MS = 30_000;
export const SEARCH_TIMEOUT_MS = 60_000;
export const WRITE_TIMEOUT_MS = 30_000;
export const DEFAULT_READ_LIMIT_BYTES = 2 * 1024 * 1024;
export const MAX_READ_LIMIT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SEARCH_FILE_BYTES = 1024 * 1024;
export const MAX_SEARCH_RESULTS = 500;
export const MAX_DIRECTORY_PAGE = 1000;

export function stringArg(
  args: Readonly<Record<string, unknown>>,
  key: string,
  options: { required?: boolean; allowEmpty?: boolean; defaultValue?: string } = {}
): string {
  const value = args[key];
  if (value === undefined && options.defaultValue !== undefined) return options.defaultValue;
  if (value === undefined && !options.required) return '';
  if (typeof value !== 'string') filesystemError('filesystem_invalid_arguments', `${key} must be a string.`);
  if (!options.allowEmpty && !value.trim()) filesystemError('filesystem_invalid_arguments', `${key} must not be empty.`);
  return value;
}

export function optionalString(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    filesystemError('filesystem_invalid_arguments', `${key} must be a non-empty string when provided.`);
  }
  return value;
}

export function booleanArg(args: Readonly<Record<string, unknown>>, key: string, defaultValue: boolean): boolean {
  const value = args[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') filesystemError('filesystem_invalid_arguments', `${key} must be a boolean.`);
  return value;
}

export function integerArg(
  args: Readonly<Record<string, unknown>>,
  key: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const value = args[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    filesystemError('filesystem_invalid_arguments', `${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function stringArrayArg(
  args: Readonly<Record<string, unknown>>,
  key: string,
  defaultValue: string[]
): string[] {
  const value = args[key];
  if (value === undefined) return defaultValue;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    filesystemError('filesystem_invalid_arguments', `${key} must be an array of non-empty strings.`);
  }
  return value as string[];
}

export function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function decodeUtf8(content: Uint8Array, relativePath: string): string {
  if (content.includes(0)) {
    filesystemError('filesystem_binary_file', `Refusing to decode binary file as UTF-8: ${relativePath}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    filesystemError('filesystem_binary_file', `File is not valid UTF-8 text: ${relativePath}`);
  }
}

export function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = content.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}

export function replaceAllLiteral(content: string, needle: string, replacement: string): string {
  return content.split(needle).join(replacement);
}

export function mimeType(relativePath: string): string | undefined {
  const extension = path.extname(relativePath).toLowerCase();
  return ({
    '.ts': 'text/typescript', '.tsx': 'text/typescript', '.js': 'text/javascript', '.jsx': 'text/javascript',
    '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.html': 'text/html',
    '.css': 'text/css', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.pdf': 'application/pdf', '.zip': 'application/zip'
  } as Record<string, string>)[extension];
}

export function ioError(error: unknown, action: string, relativePath: string): never {
  if (error instanceof FilesystemToolError || error instanceof OperationCancelledError) throw error;
  const errno = (error as NodeJS.ErrnoException).code;
  if (errno === 'ENOENT') filesystemError('filesystem_not_found', `Path does not exist: ${relativePath}`);
  if (errno === 'EEXIST') filesystemError('filesystem_already_exists', `Path already exists: ${relativePath}`);
  if (errno === 'EISDIR') filesystemError('filesystem_not_file', `Expected a regular file: ${relativePath}`);
  if (errno === 'ENOTDIR') {
    filesystemError('filesystem_not_directory', `Expected a directory while ${action}: ${relativePath}`);
  }
  filesystemError(
    'filesystem_io_error',
    `Unable to ${action} ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    { errno, path: relativePath }
  );
}

export async function assertRegularFile(resolved: ResolvedFilesystemPath): Promise<Stats> {
  let stat: Stats;
  try {
    stat = await fs.stat(resolved.targetPath);
  } catch (error) {
    ioError(error, 'stat', resolved.relativePath);
  }
  if (!stat!.isFile()) filesystemError('filesystem_not_file', `Expected a regular file: ${resolved.relativePath}`);
  return stat!;
}

export async function currentFileHash(resolved: ResolvedFilesystemPath, signal: AbortSignal): Promise<string> {
  throwIfCancelled(signal);
  const content = await fs.readFile(resolved.targetPath, { signal });
  throwIfCancelled(signal);
  return sha256(content);
}

export async function assertExpectedHash(
  resolved: ResolvedFilesystemPath,
  expectedSha256: string | undefined,
  signal: AbortSignal
): Promise<string | undefined> {
  if (!expectedSha256) return undefined;
  const actual = await currentFileHash(resolved, signal);
  if (actual !== expectedSha256) {
    filesystemError(
      'filesystem_conflict',
      `File changed since it was read: ${resolved.relativePath}`,
      { expectedSha256, actualSha256: actual }
    );
  }
  return actual;
}

export async function atomicWrite(
  session: AgentSessionContext,
  rootId: string,
  relativePath: string,
  content: string,
  signal: AbortSignal,
  options: { mustExist: boolean; mustNotExist: boolean; expectedSha256?: string }
): Promise<{ beforeSha256: string | null; afterSha256: string; sizeBytes: number }> {
  throwIfCancelled(signal);
  let resolved = await resolveFilesystemPath(session, rootId, relativePath, {
    access: 'write', mustExist: options.mustExist
  });
  if (options.mustNotExist && resolved.exists) {
    filesystemError('filesystem_already_exists', `Path already exists: ${relativePath}`);
  }
  if (resolved.exists) await assertRegularFile(resolved);
  const beforeSha256 = resolved.exists ? await currentFileHash(resolved, signal) : null;
  if (options.expectedSha256 && beforeSha256 !== options.expectedSha256) {
    filesystemError(
      'filesystem_conflict',
      `File changed since it was read: ${relativePath}`,
      { expectedSha256: options.expectedSha256, actualSha256: beforeSha256 }
    );
  }

  throwIfCancelled(signal);
  await fs.mkdir(path.dirname(resolved.targetPath), { recursive: true });
  // Re-resolve after mkdir so a newly materialized parent cannot silently become an escaping symlink.
  resolved = await resolveFilesystemPath(session, rootId, relativePath, {
    access: 'write', mustExist: false
  });
  if (options.mustNotExist && resolved.exists) {
    filesystemError('filesystem_already_exists', `Path already exists: ${relativePath}`);
  }
  if (options.mustExist && !resolved.exists) filesystemError('filesystem_not_found', `Path does not exist: ${relativePath}`);
  if (resolved.exists) {
    await assertRegularFile(resolved);
    if (options.expectedSha256) await assertExpectedHash(resolved, options.expectedSha256, signal);
  }

  const targetDirectory = path.dirname(resolved.targetPath);
  const targetName = path.basename(resolved.targetPath);
  const temporaryPath = path.join(targetDirectory, `.${targetName}.axis-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o666);
    throwIfCancelled(signal);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    throwIfCancelled(signal);
    if (options.mustNotExist) {
      // Link the fully-written temp inode to provide atomic no-clobber create semantics.
      await fs.link(temporaryPath, resolved.targetPath);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    } else {
      if (options.expectedSha256) await assertExpectedHash(resolved, options.expectedSha256, signal);
      await fs.rename(temporaryPath, resolved.targetPath);
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    ioError(error, 'write', relativePath);
  }

  const encoded = Buffer.from(content, 'utf8');
  return { beforeSha256, afterSha256: sha256(encoded), sizeBytes: encoded.byteLength };
}

export function progress(
  context: ToolExecutionContext,
  message: string,
  metadata?: Readonly<Record<string, unknown>>,
  completed?: number,
  total?: number
): void {
  context.reportProgress({ message, metadata, completed, total });
}

export function activity(
  context: ToolExecutionContext,
  kind: 'read' | 'mutation',
  detail: string,
  metadata?: Readonly<Record<string, unknown>>
): void {
  context.reportActivity({ kind, detail, metadata });
}
