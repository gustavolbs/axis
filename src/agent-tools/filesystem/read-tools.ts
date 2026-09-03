import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { throwIfCancelled } from '../../cancellation.js';
import type { AxisTool } from '../../agent-runtime/index.js';
import { FilesystemToolError, filesystemError } from './errors.js';
import {
  activity,
  assertRegularFile,
  booleanArg,
  decodeUtf8,
  DEFAULT_READ_LIMIT_BYTES,
  FILESYSTEM_CAPABILITIES,
  FILESYSTEM_PERMISSIONS,
  integerArg,
  MAX_DIRECTORY_PAGE,
  MAX_READ_LIMIT_BYTES,
  mimeType,
  progress,
  READ_TIMEOUT_MS,
  sha256,
  stringArg,
  ioError
} from './io.js';
import { resolveFilesystemPath } from './scope.js';

export const readFileTool: AxisTool = {
  definition: {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside an authorized session root, optionally by line or byte range.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rootId', 'path'],
      properties: {
        rootId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 },
        startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
        startByte: { type: 'integer', minimum: 0 }, endByte: { type: 'integer', minimum: 1 },
        maxBytes: { type: 'integer', minimum: 1, maximum: MAX_READ_LIMIT_BYTES }
      }
    },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.read],
    requiredPermissions: [FILESYSTEM_PERMISSIONS.read],
    effect: 'read', mutationRisk: 'none', retryOnFailure: 'safe', timeoutMs: READ_TIMEOUT_MS
  },
  async execute(context) {
    const args = context.call.arguments;
    const rootId = stringArg(args, 'rootId', { required: true });
    const relativePath = stringArg(args, 'path', { required: true });
    const maxBytes = integerArg(args, 'maxBytes', DEFAULT_READ_LIMIT_BYTES, 1, MAX_READ_LIMIT_BYTES);
    const startLine = args.startLine === undefined ? undefined : integerArg(args, 'startLine', 1, 1, Number.MAX_SAFE_INTEGER);
    const endLine = args.endLine === undefined ? undefined : integerArg(args, 'endLine', 1, 1, Number.MAX_SAFE_INTEGER);
    const startByte = args.startByte === undefined ? undefined : integerArg(args, 'startByte', 0, 0, Number.MAX_SAFE_INTEGER);
    const endByte = args.endByte === undefined ? undefined : integerArg(args, 'endByte', 1, 1, Number.MAX_SAFE_INTEGER);
    if ((startLine !== undefined || endLine !== undefined) && (startByte !== undefined || endByte !== undefined)) {
      filesystemError('filesystem_invalid_arguments', 'Line ranges and byte ranges are mutually exclusive.');
    }
    if (endLine !== undefined && startLine !== undefined && endLine < startLine) filesystemError('filesystem_invalid_arguments', 'endLine must be greater than or equal to startLine.');
    if (endByte !== undefined && startByte !== undefined && endByte <= startByte) filesystemError('filesystem_invalid_arguments', 'endByte must be greater than startByte.');

    progress(context, `Reading ${relativePath}`, { rootId, path: relativePath });
    throwIfCancelled(context.signal);
    const resolved = await resolveFilesystemPath(context.session, rootId, relativePath, { access: 'read', mustExist: true });
    const stat = await assertRegularFile(resolved);
    if (stat.size > maxBytes) filesystemError('filesystem_too_large', `File exceeds configured read limit (${maxBytes} bytes): ${relativePath}`, { sizeBytes: stat.size, maxBytes });
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(resolved.targetPath, { signal: context.signal });
    } catch (error) {
      ioError(error, 'read', relativePath);
    }
    throwIfCancelled(context.signal);
    const fullSha256 = sha256(bytes!);
    let selected = bytes!;
    let byteRange: { start: number; end: number } | undefined;
    if (startByte !== undefined || endByte !== undefined) {
      const start = startByte ?? 0;
      const end = Math.min(endByte ?? selected.byteLength, selected.byteLength);
      selected = selected.subarray(start, end);
      byteRange = { start, end };
    }
    let content = decodeUtf8(selected, relativePath);
    let lineRange: { start: number; end: number; total: number } | undefined;
    let lines: Array<{ number: number; text: string }> | undefined;
    if (startLine !== undefined || endLine !== undefined) {
      const allLines = content.split(/\r?\n/);
      const start = startLine ?? 1;
      const end = Math.min(endLine ?? allLines.length, allLines.length);
      lines = allLines.slice(start - 1, end).map((text, index) => ({ number: start + index, text }));
      content = lines.map((line) => line.text).join('\n');
      lineRange = { start, end, total: allLines.length };
    }
    activity(context, 'read', `Read ${relativePath}`, { rootId, path: relativePath, sizeBytes: stat.size, sha256: fullSha256 });
    progress(context, `Read ${relativePath}`, { rootId, path: relativePath }, 1, 1);
    return {
      output: {
        rootId, path: relativePath, content, lines, lineRange, byteRange,
        encoding: 'utf-8', sizeBytes: stat.size, mtimeMs: stat.mtimeMs, sha256: fullSha256
      },
      metadata: { rootId, path: relativePath, sha256: fullSha256, sizeBytes: stat.size }
    };
  }
};

export const listDirectoryTool: AxisTool = {
  definition: {
    name: 'list_directory',
    description: 'List one directory inside an authorized session root with bounded pagination and symlink safety.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rootId'],
      properties: {
        rootId: { type: 'string', minLength: 1 }, path: { type: 'string' }, includeHidden: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_DIRECTORY_PAGE }
      }
    },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.read], requiredPermissions: [FILESYSTEM_PERMISSIONS.read],
    effect: 'read', mutationRisk: 'none', retryOnFailure: 'safe', timeoutMs: READ_TIMEOUT_MS
  },
  async execute(context) {
    const args = context.call.arguments;
    const rootId = stringArg(args, 'rootId', { required: true });
    const relativePath = stringArg(args, 'path', { allowEmpty: true, defaultValue: '.' }) || '.';
    const includeHidden = booleanArg(args, 'includeHidden', false);
    const offset = integerArg(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integerArg(args, 'limit', 200, 1, MAX_DIRECTORY_PAGE);
    progress(context, `Listing ${relativePath}`, { rootId, path: relativePath });
    const resolved = await resolveFilesystemPath(context.session, rootId, relativePath, { access: 'read', allowRoot: true, mustExist: true });
    const stat = await fs.stat(resolved.targetPath);
    if (!stat.isDirectory()) filesystemError('filesystem_not_directory', `Expected a directory: ${relativePath}`);
    let directoryEntries: Dirent[];
    try {
      directoryEntries = await fs.readdir(resolved.targetPath, { withFileTypes: true });
    } catch (error) {
      ioError(error, 'list directory', relativePath);
    }
    directoryEntries!.sort((left, right) => left.name.localeCompare(right.name));
    let hiddenIgnored = 0;
    const entries: Array<Record<string, unknown>> = [];
    for (const entry of directoryEntries!) {
      throwIfCancelled(context.signal);
      if (!includeHidden && entry.name.startsWith('.')) { hiddenIgnored += 1; continue; }
      const entryRelative = relativePath === '.' ? entry.name : `${relativePath.replace(/[\\/]+$/g, '')}/${entry.name}`;
      const lexical = path.join(resolved.targetPath, entry.name);
      const lstat = await fs.lstat(lexical);
      let symlinkEscapesRoot = false;
      let targetType: 'file' | 'directory' | 'other' | undefined;
      if (lstat.isSymbolicLink()) {
        try {
          const safe = await resolveFilesystemPath(context.session, rootId, entryRelative, { access: 'read', mustExist: true });
          const targetStat = await fs.stat(safe.targetPath);
          targetType = targetStat.isFile() ? 'file' : targetStat.isDirectory() ? 'directory' : 'other';
        } catch (error) {
          if (error instanceof FilesystemToolError && error.code === 'filesystem_symlink_escape') symlinkEscapesRoot = true;
          else throw error;
        }
      }
      entries.push({
        name: entry.name, path: entryRelative,
        type: lstat.isSymbolicLink() ? 'symlink' : lstat.isFile() ? 'file' : lstat.isDirectory() ? 'directory' : 'other',
        targetType, symlinkEscapesRoot, hidden: entry.name.startsWith('.'), sizeBytes: lstat.size, mtimeMs: lstat.mtimeMs
      });
    }
    const page = entries.slice(offset, offset + limit);
    const nextOffset = offset + page.length < entries.length ? offset + page.length : undefined;
    activity(context, 'read', `Listed ${relativePath}`, { rootId, path: relativePath, returned: page.length, total: entries.length });
    return { output: { rootId, path: relativePath, entries: page, offset, limit, nextOffset, total: entries.length, ignored: { hidden: hiddenIgnored } } };
  }
};

export const statFileTool: AxisTool = {
  definition: {
    name: 'stat_file',
    description: 'Return safe metadata for a file or directory inside an authorized session root, including hash/encoding for bounded regular files.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['rootId', 'path'], properties: { rootId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, maxHashBytes: { type: 'integer', minimum: 0, maximum: MAX_READ_LIMIT_BYTES } } },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.read], requiredPermissions: [FILESYSTEM_PERMISSIONS.read],
    effect: 'read', mutationRisk: 'none', retryOnFailure: 'safe', timeoutMs: READ_TIMEOUT_MS
  },
  async execute(context) {
    const args = context.call.arguments;
    const rootId = stringArg(args, 'rootId', { required: true });
    const relativePath = stringArg(args, 'path', { required: true });
    const maxHashBytes = integerArg(args, 'maxHashBytes', DEFAULT_READ_LIMIT_BYTES, 0, MAX_READ_LIMIT_BYTES);
    const resolved = await resolveFilesystemPath(context.session, rootId, relativePath, { access: 'read', mustExist: true });
    throwIfCancelled(context.signal);
    const lstat = await fs.lstat(path.resolve(resolved.realPath, relativePath.replace(/[\\/]+/g, path.sep)));
    const stat = await fs.stat(resolved.targetPath);
    const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
    let hash: string | undefined;
    let encoding: 'utf-8' | 'binary' | undefined;
    if (stat.isFile() && stat.size <= maxHashBytes) {
      const content = await fs.readFile(resolved.targetPath, { signal: context.signal });
      hash = sha256(content);
      try { decodeUtf8(content.subarray(0, Math.min(content.length, 8192)), relativePath); encoding = 'utf-8'; }
      catch (error) { if (error instanceof FilesystemToolError && error.code === 'filesystem_binary_file') encoding = 'binary'; else throw error; }
    }
    activity(context, 'read', `Stat ${relativePath}`, { rootId, path: relativePath, type, sizeBytes: stat.size });
    return { output: { rootId, path: relativePath, type, symlink: lstat.isSymbolicLink(), sizeBytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode, permissions: (stat.mode & 0o777).toString(8).padStart(3, '0'), mimeType: mimeType(relativePath), encoding, sha256: hash } };
  }
};
