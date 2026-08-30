import fs from 'node:fs/promises';
import path from 'node:path';

import { readWorkspaceFile, resolveWorkspace, resolveWorkspacePath } from './workspace.js';

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.ssh',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache'
]);

const DEFAULT_TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.css',
  '.scss',
  '.html',
  '.yml',
  '.yaml',
  '.toml',
  '.graphql',
  '.gql',
  '.sql',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.sh'
]);

export interface WorkspaceDiscoveryOptions {
  maxDepth?: number;
  maxEntries?: number;
  extensions?: string[];
}

export interface WorkspaceDiscoveryResult {
  workspace: string;
  files: string[];
  directories: string[];
  truncated: boolean;
  packageManager?: string;
  packageScripts?: string[];
}

export interface WorkspaceSearchResult {
  workspace: string;
  query: string;
  scannedFiles: number;
  matches: Array<{ path: string; line: number; preview: string }>;
  truncated: boolean;
}

function normalizeExtensions(values: string[] | undefined): Set<string> | undefined {
  if (!values?.length) return undefined;
  return new Set(values.map((value) => (value.startsWith('.') ? value : `.${value}`)).map((value) => value.toLowerCase()));
}

function toProtocolPath(value: string): string {
  return value.split(path.sep).join('/');
}

async function detectPackageMetadata(workspace: string): Promise<Pick<WorkspaceDiscoveryResult, 'packageManager' | 'packageScripts'>> {
  const lockfiles: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm']
  ];

  let packageManager: string | undefined;
  for (const [lockfile, manager] of lockfiles) {
    try {
      await fs.access(resolveWorkspacePath(workspace, lockfile));
      packageManager = manager;
      break;
    } catch {
      // Keep probing.
    }
  }

  let packageScripts: string[] | undefined;
  try {
    const snapshot = await readWorkspaceFile(workspace, 'package.json', 200_000);
    if (snapshot.content) {
      const parsed = JSON.parse(snapshot.content) as { packageManager?: string; scripts?: Record<string, unknown> };
      if (parsed.packageManager) packageManager = parsed.packageManager.split('@')[0];
      packageScripts = Object.keys(parsed.scripts ?? {}).sort();
    }
  } catch {
    // Discovery should remain useful for non-Node repositories and malformed manifests.
  }

  return { packageManager, packageScripts };
}

export async function discoverWorkspace(
  workspaceInput: string,
  options: WorkspaceDiscoveryOptions = {}
): Promise<WorkspaceDiscoveryResult> {
  const workspace = await resolveWorkspace(workspaceInput);
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 4, 12));
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 400, 5_000));
  const extensions = normalizeExtensions(options.extensions);
  const files: string[] = [];
  const directories: string[] = [];
  let truncated = false;

  async function walk(relativeDirectory: string, depth: number): Promise<void> {
    if (truncated || depth > maxDepth) return;
    const absoluteDirectory = relativeDirectory
      ? resolveWorkspacePath(workspace, relativeDirectory)
      : workspace;
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });

    for (const entry of entries) {
      if (files.length + directories.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;

      const nativeRelativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const relativePath = toProtocolPath(nativeRelativePath);

      try {
        resolveWorkspacePath(workspace, relativePath);
      } catch {
        continue;
      }

      if (entry.isDirectory()) {
        directories.push(relativePath);
        await walk(relativePath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (extensions && !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(relativePath);
    }
  }

  await walk('', 0);
  const metadata = await detectPackageMetadata(workspace);

  return {
    workspace,
    files: files.sort(),
    directories: directories.sort(),
    truncated,
    ...metadata
  };
}

export async function searchWorkspace(
  workspaceInput: string,
  queryInput: string,
  options: {
    extensions?: string[];
    maxResults?: number;
    maxFiles?: number;
    maxDepth?: number;
    maxFileBytes?: number;
  } = {}
): Promise<WorkspaceSearchResult> {
  const query = queryInput.trim();
  if (!query) throw new Error('query must not be empty.');
  if (query.length > 500) throw new Error('query must be 500 characters or fewer.');

  const maxResults = Math.max(1, Math.min(options.maxResults ?? 50, 200));
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 500, 2_000));
  const extensions = options.extensions?.length ? options.extensions : [...DEFAULT_TEXT_EXTENSIONS];
  const discovery = await discoverWorkspace(workspaceInput, {
    maxDepth: options.maxDepth ?? 8,
    maxEntries: maxFiles,
    extensions
  });
  const normalizedQuery = query.toLowerCase();
  const matches: WorkspaceSearchResult['matches'] = [];
  let scannedFiles = 0;
  let truncated = discovery.truncated;

  for (const file of discovery.files.slice(0, maxFiles)) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }

    let snapshot;
    try {
      snapshot = await readWorkspaceFile(discovery.workspace, file, options.maxFileBytes ?? 120_000);
    } catch {
      continue;
    }
    if (!snapshot.content) continue;
    scannedFiles += 1;

    const lines = snapshot.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(normalizedQuery)) continue;
      matches.push({
        path: file,
        line: index + 1,
        preview: lines[index].trim().slice(0, 300)
      });
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
    }
  }

  return {
    workspace: discovery.workspace,
    query,
    scannedFiles,
    matches,
    truncated
  };
}
