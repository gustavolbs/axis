import fs from 'node:fs/promises';

import type { AxisTool } from '../../agent-runtime/index.js';
import { filesystemError } from './errors.js';
import {
  activity,
  assertExpectedHash,
  assertRegularFile,
  atomicWrite,
  booleanArg,
  countOccurrences,
  decodeUtf8,
  FILESYSTEM_CAPABILITIES,
  FILESYSTEM_PERMISSIONS,
  ioError,
  MAX_READ_LIMIT_BYTES,
  optionalString,
  progress,
  replaceAllLiteral,
  sha256,
  stringArg,
  WRITE_TIMEOUT_MS
} from './io.js';
import { resolveFilesystemPath } from './scope.js';

export const createFileTool: AxisTool = {
  definition: {
    name: 'create_file', description: 'Create a new UTF-8 file atomically inside a writable authorized session root. Parent directories are created as needed.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['rootId', 'path', 'content'], properties: { rootId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, content: { type: 'string' } } },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.write], requiredPermissions: [FILESYSTEM_PERMISSIONS.write],
    effect: 'mutation', mutationRisk: 'definite', retryOnFailure: 'after-confirmation', timeoutMs: WRITE_TIMEOUT_MS
  },
  async execute(context) {
    const rootId = stringArg(context.call.arguments, 'rootId', { required: true });
    const relativePath = stringArg(context.call.arguments, 'path', { required: true });
    const content = stringArg(context.call.arguments, 'content', { required: true, allowEmpty: true });
    activity(context, 'mutation', `Creating ${relativePath}`, { rootId, path: relativePath });
    progress(context, `Creating ${relativePath}`, { rootId, path: relativePath });
    const result = await atomicWrite(context.session, rootId, relativePath, content, context.signal, { mustExist: false, mustNotExist: true });
    progress(context, `Created ${relativePath}`, { rootId, path: relativePath, sha256: result.afterSha256 }, 1, 1);
    return { output: { rootId, path: relativePath, ...result }, mutationStatus: 'committed', retry: 'after-confirmation', metadata: { rootId, path: relativePath, sha256: result.afterSha256 } };
  }
};

export const writeFileTool: AxisTool = {
  definition: {
    name: 'write_file', description: 'Atomically replace an existing UTF-8 file inside a writable authorized session root, with optional SHA-256 conflict detection.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['rootId', 'path', 'content'], properties: { rootId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, content: { type: 'string' }, expectedSha256: { type: 'string', minLength: 64, maxLength: 64 } } },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.write], requiredPermissions: [FILESYSTEM_PERMISSIONS.write],
    effect: 'mutation', mutationRisk: 'definite', retryOnFailure: 'after-confirmation', timeoutMs: WRITE_TIMEOUT_MS
  },
  async execute(context) {
    const args = context.call.arguments;
    const rootId = stringArg(args, 'rootId', { required: true });
    const relativePath = stringArg(args, 'path', { required: true });
    const content = stringArg(args, 'content', { required: true, allowEmpty: true });
    const expectedSha256 = optionalString(args, 'expectedSha256');
    activity(context, 'mutation', `Writing ${relativePath}`, { rootId, path: relativePath });
    const result = await atomicWrite(context.session, rootId, relativePath, content, context.signal, { mustExist: true, mustNotExist: false, expectedSha256 });
    return { output: { rootId, path: relativePath, ...result }, mutationStatus: 'committed', retry: 'after-confirmation', metadata: { rootId, path: relativePath, sha256: result.afterSha256 } };
  }
};

export const editFileTool: AxisTool = {
  definition: {
    name: 'edit_file', description: 'Apply an exact text replacement to an existing UTF-8 file and commit it atomically, with optional SHA-256 conflict detection.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['rootId', 'path', 'oldText', 'newText'], properties: { rootId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' }, replaceAll: { type: 'boolean' }, expectedSha256: { type: 'string', minLength: 64, maxLength: 64 } } },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.read, FILESYSTEM_CAPABILITIES.write], requiredPermissions: [FILESYSTEM_PERMISSIONS.read, FILESYSTEM_PERMISSIONS.write],
    effect: 'mutation', mutationRisk: 'definite', retryOnFailure: 'after-confirmation', timeoutMs: WRITE_TIMEOUT_MS
  },
  async execute(context) {
    const args = context.call.arguments;
    const rootId = stringArg(args, 'rootId', { required: true });
    const relativePath = stringArg(args, 'path', { required: true });
    const oldText = stringArg(args, 'oldText', { required: true });
    const newText = stringArg(args, 'newText', { required: true, allowEmpty: true });
    const replaceAll = booleanArg(args, 'replaceAll', false);
    const expectedSha256 = optionalString(args, 'expectedSha256');
    progress(context, `Reading ${relativePath} for edit`, { rootId, path: relativePath });
    const resolved = await resolveFilesystemPath(context.session, rootId, relativePath, { access: 'write', mustExist: true });
    const stat = await assertRegularFile(resolved);
    if (stat.size > MAX_READ_LIMIT_BYTES) filesystemError('filesystem_too_large', `File exceeds edit limit (${MAX_READ_LIMIT_BYTES} bytes): ${relativePath}`);
    await assertExpectedHash(resolved, expectedSha256, context.signal);
    let bytes: Buffer;
    try { bytes = await fs.readFile(resolved.targetPath, { signal: context.signal }); }
    catch (error) { ioError(error, 'read for edit', relativePath); }
    const content = decodeUtf8(bytes!, relativePath);
    const occurrences = countOccurrences(content, oldText);
    if (occurrences === 0) filesystemError('filesystem_edit_not_found', `oldText was not found in ${relativePath}.`);
    if (!replaceAll && occurrences > 1) filesystemError('filesystem_edit_ambiguous', `oldText occurs ${occurrences} times in ${relativePath}; set replaceAll=true or provide more context.`);
    const updated = replaceAll ? replaceAllLiteral(content, oldText, newText) : content.replace(oldText, newText);
    activity(context, 'mutation', `Editing ${relativePath}`, { rootId, path: relativePath, replacements: replaceAll ? occurrences : 1 });
    const result = await atomicWrite(context.session, rootId, relativePath, updated, context.signal, { mustExist: true, mustNotExist: false, expectedSha256: expectedSha256 ?? sha256(bytes!) });
    return { output: { rootId, path: relativePath, replacements: replaceAll ? occurrences : 1, ...result }, mutationStatus: 'committed', retry: 'after-confirmation', metadata: { rootId, path: relativePath, sha256: result.afterSha256 } };
  }
};
