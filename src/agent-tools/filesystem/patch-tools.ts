import fs from 'node:fs/promises';

import type { AxisTool } from '../../agent-runtime/index.js';
import { filesystemError } from './errors.js';
import {
  activity,
  assertRegularFile,
  atomicWrite,
  countOccurrences,
  decodeUtf8,
  FILESYSTEM_CAPABILITIES,
  FILESYSTEM_PERMISSIONS,
  ioError,
  MAX_READ_LIMIT_BYTES,
  optionalString,
  progress,
  sha256,
  stringArg,
  WRITE_TIMEOUT_MS
} from './io.js';
import { resolveFilesystemPath } from './scope.js';

interface PatchHunk {
  readonly oldText: string;
  readonly newText: string;
}

function patchHunks(args: Readonly<Record<string, unknown>>): PatchHunk[] {
  const value = args.patches;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    filesystemError('filesystem_invalid_arguments', 'patches must be an array containing 1-100 exact text hunks.');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      filesystemError('filesystem_invalid_arguments', `patches[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.oldText !== 'string' || !record.oldText) {
      filesystemError('filesystem_invalid_arguments', `patches[${index}].oldText must be a non-empty string.`);
    }
    if (typeof record.newText !== 'string') {
      filesystemError('filesystem_invalid_arguments', `patches[${index}].newText must be a string.`);
    }
    return { oldText: record.oldText, newText: record.newText };
  });
}

export const patchFileTool: AxisTool = {
  definition: {
    name: 'patch_file',
    description: 'Apply one or more exact contextual text hunks to an existing UTF-8 file and commit the result atomically. Each oldText hunk must match exactly once in the evolving file.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rootId', 'path', 'patches'],
      properties: {
        rootId: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
        expectedSha256: { type: 'string', minLength: 64, maxLength: 64 },
        patches: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object', additionalProperties: false, required: ['oldText', 'newText'],
            properties: { oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } }
          }
        }
      }
    },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.read, FILESYSTEM_CAPABILITIES.write],
    requiredPermissions: [FILESYSTEM_PERMISSIONS.read, FILESYSTEM_PERMISSIONS.write],
    effect: 'mutation', mutationRisk: 'definite', retryOnFailure: 'after-confirmation', timeoutMs: WRITE_TIMEOUT_MS
  },
  async execute(context) {
    const args = context.call.arguments;
    const rootId = stringArg(args, 'rootId', { required: true });
    const relativePath = stringArg(args, 'path', { required: true });
    const expectedSha256 = optionalString(args, 'expectedSha256');
    const hunks = patchHunks(args);

    progress(context, `Reading ${relativePath} for patch`, { rootId, path: relativePath });
    const resolved = await resolveFilesystemPath(context.session, rootId, relativePath, { access: 'write', mustExist: true });
    const stat = await assertRegularFile(resolved);
    if (stat.size > MAX_READ_LIMIT_BYTES) {
      filesystemError('filesystem_too_large', `File exceeds patch limit (${MAX_READ_LIMIT_BYTES} bytes): ${relativePath}`);
    }

    let bytes: Buffer;
    try { bytes = await fs.readFile(resolved.targetPath, { signal: context.signal }); }
    catch (error) { ioError(error, 'read for patch', relativePath); }
    const beforeSha256 = sha256(bytes!);
    if (expectedSha256 && expectedSha256 !== beforeSha256) {
      filesystemError('filesystem_conflict', `File changed since it was read: ${relativePath}`, {
        expectedSha256, actualSha256: beforeSha256
      });
    }

    let updated = decodeUtf8(bytes!, relativePath);
    for (let index = 0; index < hunks.length; index += 1) {
      const hunk = hunks[index]!;
      const occurrences = countOccurrences(updated, hunk.oldText);
      if (occurrences === 0) {
        filesystemError('filesystem_edit_not_found', `Patch hunk ${index + 1} did not match ${relativePath}.`);
      }
      if (occurrences > 1) {
        filesystemError('filesystem_edit_ambiguous', `Patch hunk ${index + 1} matches ${occurrences} locations in ${relativePath}; provide more surrounding context.`);
      }
      updated = updated.replace(hunk.oldText, hunk.newText);
      progress(context, `Applied patch hunk ${index + 1}/${hunks.length}`, { rootId, path: relativePath }, index + 1, hunks.length);
    }

    activity(context, 'mutation', `Patching ${relativePath}`, { rootId, path: relativePath, hunks: hunks.length });
    const result = await atomicWrite(context.session, rootId, relativePath, updated, context.signal, {
      mustExist: true, mustNotExist: false, expectedSha256: beforeSha256
    });
    return {
      output: { rootId, path: relativePath, hunksApplied: hunks.length, ...result },
      mutationStatus: 'committed', retry: 'after-confirmation',
      metadata: { rootId, path: relativePath, hunksApplied: hunks.length, sha256: result.afterSha256 }
    };
  }
};
