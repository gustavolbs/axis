import fs from 'node:fs/promises';

import { throwIfCancelled } from '../../cancellation.js';
import type { AxisTool } from '../../agent-runtime/index.js';
import { FilesystemToolError, filesystemError } from './errors.js';
import {
  activity,
  booleanArg,
  decodeUtf8,
  DEFAULT_SEARCH_FILE_BYTES,
  FILESYSTEM_CAPABILITIES,
  FILESYSTEM_PERMISSIONS,
  integerArg,
  ioError,
  MAX_READ_LIMIT_BYTES,
  MAX_SEARCH_RESULTS,
  progress,
  SEARCH_TIMEOUT_MS,
  stringArg,
  stringArrayArg
} from './io.js';
import { globRegex, walkFiles } from './search-support.js';

export const searchFilesTool: AxisTool = {
  definition: {
    name: 'search_files', description: 'Search file names/paths by glob inside an authorized session root without traversing symlink directories.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['rootId'], properties: { rootId: { type: 'string', minLength: 1 }, path: { type: 'string' }, globs: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 }, includeHidden: { type: 'boolean' }, includeIgnored: { type: 'boolean' }, respectGitignore: { type: 'boolean' }, maxResults: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS } } },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.read], requiredPermissions: [FILESYSTEM_PERMISSIONS.read],
    effect: 'read', mutationRisk: 'none', retryOnFailure: 'safe', timeoutMs: SEARCH_TIMEOUT_MS
  },
  async execute(context) {
    const args = context.call.arguments;
    const rootId = stringArg(args, 'rootId', { required: true });
    const directory = stringArg(args, 'path', { allowEmpty: true, defaultValue: '.' }) || '.';
    const globs = stringArrayArg(args, 'globs', ['**/*']);
    const matchers = globs.map((glob) => globRegex(glob));
    const maxResults = integerArg(args, 'maxResults', 200, 1, MAX_SEARCH_RESULTS);
    progress(context, `Searching files in ${directory}`, { rootId, path: directory });
    const walked = await walkFiles(context, {
      rootId, directory,
      includeHidden: booleanArg(args, 'includeHidden', false), includeIgnored: booleanArg(args, 'includeIgnored', false),
      respectGitignore: booleanArg(args, 'respectGitignore', true), maxFiles: Math.max(maxResults * 20, 2000)
    });
    const matches = walked.files.filter((file) => matchers.some((matcher) => matcher.test(file.relativePath))).slice(0, maxResults);
    activity(context, 'read', `Searched files in ${directory}`, { rootId, matches: matches.length });
    return { output: { rootId, path: directory, globs, matches: matches.map((file) => ({ path: file.relativePath, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, symlink: file.symlink })), truncated: matches.length >= maxResults, skipped: walked.skipped } };
  }
};

export const searchTextTool: AxisTool = {
  definition: {
    name: 'search_text', description: 'Search UTF-8 text with literal or regular-expression matching inside an authorized session root, with bounded results and context.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['rootId', 'query'], properties: { rootId: { type: 'string', minLength: 1 }, path: { type: 'string' }, query: { type: 'string', minLength: 1 }, regex: { type: 'boolean' }, caseSensitive: { type: 'boolean' }, globs: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 }, contextLines: { type: 'integer', minimum: 0, maximum: 5 }, maxResults: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS }, maxFileBytes: { type: 'integer', minimum: 1, maximum: MAX_READ_LIMIT_BYTES }, includeHidden: { type: 'boolean' }, includeIgnored: { type: 'boolean' }, respectGitignore: { type: 'boolean' } } },
    requiredCapabilities: [FILESYSTEM_CAPABILITIES.read], requiredPermissions: [FILESYSTEM_PERMISSIONS.read],
    effect: 'read', mutationRisk: 'none', retryOnFailure: 'safe', timeoutMs: SEARCH_TIMEOUT_MS
  },
  async execute(context) {
    const args = context.call.arguments;
    const rootId = stringArg(args, 'rootId', { required: true });
    const directory = stringArg(args, 'path', { allowEmpty: true, defaultValue: '.' }) || '.';
    const query = stringArg(args, 'query', { required: true });
    const regexMode = booleanArg(args, 'regex', false);
    const caseSensitive = booleanArg(args, 'caseSensitive', false);
    const contextLines = integerArg(args, 'contextLines', 0, 0, 5);
    const maxResults = integerArg(args, 'maxResults', 100, 1, MAX_SEARCH_RESULTS);
    const maxFileBytes = integerArg(args, 'maxFileBytes', DEFAULT_SEARCH_FILE_BYTES, 1, MAX_READ_LIMIT_BYTES);
    const globs = stringArrayArg(args, 'globs', ['**/*']);
    const globMatchers = globs.map((glob) => globRegex(glob));
    let matcher: RegExp;
    try {
      matcher = regexMode
        ? new RegExp(query, `${caseSensitive ? '' : 'i'}g`)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), `${caseSensitive ? '' : 'i'}g`);
    } catch (error) {
      filesystemError('filesystem_invalid_regex', `Invalid search regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }

    const walked = await walkFiles(context, {
      rootId, directory,
      includeHidden: booleanArg(args, 'includeHidden', false), includeIgnored: booleanArg(args, 'includeIgnored', false),
      respectGitignore: booleanArg(args, 'respectGitignore', true), maxFiles: 20_000
    });
    const candidates = walked.files.filter((file) => file.sizeBytes <= maxFileBytes && globMatchers.some((glob) => glob.test(file.relativePath)));
    const matches: Array<Record<string, unknown>> = [];
    let skippedBinary = 0;
    const skippedLarge = walked.files.filter((file) => file.sizeBytes > maxFileBytes).length;
    for (let fileIndex = 0; fileIndex < candidates.length && matches.length < maxResults; fileIndex += 1) {
      throwIfCancelled(context.signal);
      if (fileIndex % 25 === 0) progress(context, `Searching text (${fileIndex}/${candidates.length})`, { rootId, path: directory }, fileIndex, candidates.length);
      const file = candidates[fileIndex]!;
      let bytes: Buffer;
      try { bytes = await fs.readFile(file.absolutePath, { signal: context.signal }); }
      catch (error) { ioError(error, 'search', file.relativePath); }
      let content: string;
      try { content = decodeUtf8(bytes!, file.relativePath); }
      catch (error) { if (error instanceof FilesystemToolError && error.code === 'filesystem_binary_file') { skippedBinary += 1; continue; } throw error; }
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length && matches.length < maxResults; lineIndex += 1) {
        const line = lines[lineIndex]!;
        matcher!.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = matcher!.exec(line)) !== null && matches.length < maxResults) {
          matches.push({
            path: file.relativePath, line: lineIndex + 1, column: match.index + 1, match: match[0], text: line,
            before: contextLines ? lines.slice(Math.max(0, lineIndex - contextLines), lineIndex) : undefined,
            after: contextLines ? lines.slice(lineIndex + 1, lineIndex + 1 + contextLines) : undefined
          });
          if (match[0] === '') matcher!.lastIndex += 1;
        }
      }
    }
    activity(context, 'read', `Searched text in ${directory}`, { rootId, matches: matches.length, files: candidates.length });
    progress(context, 'Text search complete', { rootId, path: directory }, candidates.length, candidates.length);
    return { output: { rootId, path: directory, query, regex: regexMode, caseSensitive, globs, matches, truncated: matches.length >= maxResults, skipped: { ...walked.skipped, binary: skippedBinary, large: skippedLarge } } };
  }
};
