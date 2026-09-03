import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { throwIfCancelled } from '../../cancellation.js';
import type { ToolExecutionContext } from '../../agent-runtime/index.js';
import { FilesystemToolError, filesystemError } from './errors.js';
import { ioError } from './io.js';
import { resolveFilesystemPath, toRootRelative, type ResolvedFilesystemPath } from './scope.js';

interface IgnoreRule {
  readonly negated: boolean;
  readonly regex: RegExp;
}

export function globRegex(patternInput: string, options: { directoryPrefix?: boolean } = {}): RegExp {
  let pattern = patternInput.trim().replace(/\\/g, '/');
  if (!pattern) filesystemError('filesystem_invalid_arguments', 'Glob patterns must not be empty.');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  const hasSlash = pattern.includes('/');
  if (!hasSlash) pattern = `**/${pattern}`;

  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}${options.directoryPrefix ? '(?:/.*)?' : ''}$`);
}

async function ignoreRulesForDirectory(
  rootRealPath: string,
  absoluteDirectory: string,
  inherited: readonly IgnoreRule[],
  signal: AbortSignal
): Promise<IgnoreRule[]> {
  throwIfCancelled(signal);
  const rules = [...inherited];
  const ignorePath = path.join(absoluteDirectory, '.gitignore');
  let content: string;
  try {
    content = await fs.readFile(ignorePath, { encoding: 'utf8', signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return rules;
    ioError(error, 'read .gitignore in', toRootRelative(rootRealPath, absoluteDirectory));
  }

  const base = toRootRelative(rootRealPath, absoluteDirectory);
  for (const rawLine of content!.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);
    if (!line) continue;
    const directoryOnly = line.endsWith('/');
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    const scoped = base === '.'
      ? line
      : anchored || line.includes('/')
        ? `${base}/${line}`
        : `${base}/**/${line}`;
    rules.push({ negated, regex: globRegex(scoped, { directoryPrefix: directoryOnly }) });
  }
  return rules;
}

function isIgnored(relativePath: string, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(relativePath)) ignored = !rule.negated;
  }
  return ignored;
}

export interface WalkFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly symlink: boolean;
}

export async function walkFiles(
  context: ToolExecutionContext,
  options: {
    rootId: string;
    directory: string;
    includeHidden: boolean;
    includeIgnored: boolean;
    respectGitignore: boolean;
    maxFiles: number;
  }
): Promise<{ files: WalkFile[]; skipped: { hidden: number; ignored: number; symlinkDirectories: number } }> {
  const start = await resolveFilesystemPath(context.session, options.rootId, options.directory, {
    access: 'read', allowRoot: true, mustExist: true
  });
  const startStat = await fs.stat(start.targetPath);
  if (!startStat.isDirectory()) filesystemError('filesystem_not_directory', `Expected a directory: ${options.directory}`);
  const files: WalkFile[] = [];
  const skipped = { hidden: 0, ignored: 0, symlinkDirectories: 0 };

  async function visit(directoryPath: string, inheritedRules: readonly IgnoreRule[]): Promise<void> {
    throwIfCancelled(context.signal);
    if (files.length >= options.maxFiles) return;
    const rules = options.respectGitignore
      ? await ignoreRulesForDirectory(start.realPath, directoryPath, inheritedRules, context.signal)
      : [...inheritedRules];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      ioError(error, 'list directory', toRootRelative(start.realPath, directoryPath));
    }
    entries!.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries!) {
      throwIfCancelled(context.signal);
      if (files.length >= options.maxFiles) return;
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = toRootRelative(start.realPath, absolutePath);
      if (!options.includeHidden && entry.name.startsWith('.')) {
        if (entry.name !== '.gitignore') skipped.hidden += 1;
        if (entry.name !== '.gitignore') continue;
      }
      if (!options.includeIgnored && isIgnored(relativePath, rules)) {
        skipped.ignored += 1;
        continue;
      }
      if (entry.name === '.gitignore' && !options.includeHidden) continue;

      if (entry.isSymbolicLink()) {
        let safeTarget: ResolvedFilesystemPath;
        try {
          safeTarget = await resolveFilesystemPath(context.session, options.rootId, relativePath, {
            access: 'read', mustExist: true
          });
        } catch (error) {
          if (error instanceof FilesystemToolError && error.code === 'filesystem_symlink_escape') {
            skipped.symlinkDirectories += 1;
            continue;
          }
          throw error;
        }
        const stat = await fs.stat(safeTarget.targetPath);
        if (stat.isDirectory()) {
          skipped.symlinkDirectories += 1;
          continue;
        }
        if (stat.isFile()) {
          files.push({
            absolutePath: safeTarget.targetPath,
            relativePath,
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
            symlink: true
          });
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, rules);
        continue;
      }
      if (entry.isFile()) {
        const stat = await fs.stat(absolutePath);
        files.push({
          absolutePath,
          relativePath,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          symlink: false
        });
      }
    }
  }

  await visit(start.targetPath, []);
  return { files, skipped };
}
