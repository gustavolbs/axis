import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LocalCoderConfig } from './config.js';
import { discoverWorkspace } from './discovery.js';
import { readWorkspaceFile, resolveWorkspace, resolveWorkspacePath } from './workspace.js';

const INDEX_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'css', 'scss',
  'html', 'yml', 'yaml', 'toml', 'graphql', 'gql', 'sql', 'py', 'go', 'rs', 'java',
  'kt', 'swift', 'sh'
];

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'using', 'use', 'add',
  'create', 'update', 'change', 'implement', 'fix', 'existing', 'should', 'must', 'code',
  'file', 'files', 'feature', 'component', 'task', 'make', 'when', 'where', 'what', 'como',
  'para', 'com', 'uma', 'um', 'que', 'dos', 'das', 'por', 'criar', 'implementar', 'alterar'
]);

interface RepoIndexEntry {
  path: string;
  mtimeMs: number;
  size: number;
  terms: string[];
  imports: string[];
  exports: string[];
}

interface RepoIndex {
  workspace: string;
  generatedAt: string;
  files: RepoIndexEntry[];
  packageManager?: string;
  packageScripts?: string[];
}

export interface ContextEvidence {
  startLine: number;
  endLine: number;
  content: string;
}

export interface ContextCapsuleFile {
  path: string;
  score: number;
  reasons: string[];
  evidence: ContextEvidence[];
}

export interface ContextCapsule {
  workspace: string;
  indexedFiles: number;
  indexReusedFiles: number;
  queryTerms: string[];
  relevantFiles: ContextCapsuleFile[];
  packageManager?: string;
  validationCandidates: string[];
  truncated: boolean;
  guidance: string;
}

function tokenize(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z_][a-z0-9_-]{2,}/g) ?? [];
  return [...new Set(matches.filter((term) => !STOP_WORDS.has(term)))];
}

function extractTerms(content: string): string[] {
  return tokenize(content).slice(0, 1_200);
}

function extractImports(content: string): string[] {
  const imports = new Set<string>();
  const regex = /(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(regex)) {
    if (match[1]) imports.add(match[1]);
    if (imports.size >= 100) break;
  }
  return [...imports];
}

function extractExports(content: string): string[] {
  const exports = new Set<string>();
  const regex = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:type|interface|class|function|const|let|var|enum)?\s*([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(regex)) {
    if (match[1]) exports.add(match[1]);
    if (exports.size >= 100) break;
  }
  return [...exports];
}

function indexFileName(baseDirectory: string, workspace: string): string {
  const key = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
  return path.join(baseDirectory, `${key}.json`);
}

async function loadExisting(filePath: string): Promise<RepoIndex | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as RepoIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export class RepoIndexStore {
  constructor(private readonly baseDirectory: string) {}

  async refresh(
    workspaceInput: string,
    config: LocalCoderConfig,
    options: { maxFiles?: number; maxDepth?: number } = {}
  ): Promise<{ index: RepoIndex; reusedFiles: number }> {
    const workspace = await resolveWorkspace(workspaceInput);
    const maxFiles = Math.max(10, Math.min(options.maxFiles ?? 2_000, 5_000));
    const discovery = await discoverWorkspace(workspace, {
      maxDepth: options.maxDepth ?? 12,
      maxEntries: maxFiles,
      extensions: INDEX_EXTENSIONS
    });
    const filePath = indexFileName(this.baseDirectory, workspace);
    const existing = await loadExisting(filePath);
    const oldByPath = new Map((existing?.files ?? []).map((entry) => [entry.path, entry]));
    const files: RepoIndexEntry[] = [];
    let reusedFiles = 0;

    for (const relativePath of discovery.files.slice(0, maxFiles)) {
      const absolutePath = resolveWorkspacePath(workspace, relativePath);
      let stat;
      try {
        stat = await fs.stat(absolutePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > config.maxFileBytes) continue;

      const previous = oldByPath.get(relativePath);
      if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
        files.push(previous);
        reusedFiles += 1;
        continue;
      }

      try {
        const snapshot = await readWorkspaceFile(workspace, relativePath, config.maxFileBytes);
        if (snapshot.content === null) continue;
        files.push({
          path: relativePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          terms: extractTerms(snapshot.content),
          imports: extractImports(snapshot.content),
          exports: extractExports(snapshot.content)
        });
      } catch {
        // Keep the index useful when one file is unreadable or non-textual.
      }
    }

    const index: RepoIndex = {
      workspace,
      generatedAt: new Date().toISOString(),
      files,
      packageManager: discovery.packageManager,
      packageScripts: discovery.packageScripts
    };

    await fs.mkdir(this.baseDirectory, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(index), 'utf8');
    return { index, reusedFiles };
  }
}

function scoreEntry(entry: RepoIndexEntry, queryTerms: string[]): { score: number; reasons: string[] } {
  const lowerPath = entry.path.toLowerCase();
  const terms = new Set(entry.terms);
  const exports = new Set(entry.exports.map((value) => value.toLowerCase()));
  let score = 0;
  const reasons: string[] = [];

  for (const term of queryTerms) {
    let termScore = 0;
    if (lowerPath.includes(term)) termScore += 6;
    if (terms.has(term)) termScore += 2;
    if (exports.has(term)) termScore += 5;
    if (entry.imports.some((value) => value.toLowerCase().includes(term))) termScore += 1;
    if (termScore > 0) {
      score += termScore;
      reasons.push(`${term}:${termScore}`);
    }
  }

  if (/\.(test|spec)\.[^.]+$/i.test(entry.path)) score += 1;
  return { score, reasons: reasons.slice(0, 8) };
}

function evidenceFor(content: string, queryTerms: string[], maxChars: number): ContextEvidence[] {
  const lines = content.split(/\r?\n/);
  const hits: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLowerCase();
    if (queryTerms.some((term) => lower.includes(term))) hits.push(index);
    if (hits.length >= 4) break;
  }

  const anchors = hits.length > 0 ? hits : [0];
  const evidence: ContextEvidence[] = [];
  let usedChars = 0;

  for (const anchor of anchors) {
    const start = Math.max(0, anchor - 2);
    const end = Math.min(lines.length - 1, anchor + 4);
    const text = lines.slice(start, end + 1).join('\n').slice(0, Math.max(0, maxChars - usedChars));
    if (!text) break;
    evidence.push({ startLine: start + 1, endLine: start + text.split(/\r?\n/).length, content: text });
    usedChars += text.length;
    if (usedChars >= maxChars || evidence.length >= 2) break;
  }

  return evidence;
}

export async function prepareContextCapsule(
  indexStore: RepoIndexStore,
  config: LocalCoderConfig,
  input: {
    workspace: string;
    task: string;
    hints?: string[];
    maxFiles?: number;
    maxCharsPerFile?: number;
  }
): Promise<ContextCapsule> {
  const queryTerms = [...new Set([...tokenize(input.task), ...(input.hints ?? []).flatMap(tokenize)])].slice(0, 16);
  const { index, reusedFiles } = await indexStore.refresh(input.workspace, config);
  const maxFiles = Math.max(2, Math.min(input.maxFiles ?? 8, 16));
  const maxCharsPerFile = Math.max(300, Math.min(input.maxCharsPerFile ?? 1_200, 3_000));

  const ranked = index.files
    .map((entry) => ({ entry, ...scoreEntry(entry, queryTerms) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, maxFiles);

  const relevantFiles: ContextCapsuleFile[] = [];
  for (const candidate of ranked) {
    try {
      const snapshot = await readWorkspaceFile(index.workspace, candidate.entry.path, config.maxFileBytes);
      if (snapshot.content === null) continue;
      relevantFiles.push({
        path: candidate.entry.path,
        score: candidate.score,
        reasons: candidate.reasons,
        evidence: evidenceFor(snapshot.content, queryTerms, maxCharsPerFile)
      });
    } catch {
      // Ignore files that changed between indexing and capsule creation.
    }
  }

  const scripts = new Set(index.packageScripts ?? []);
  const preferredScripts = ['test', 'typecheck', 'lint', 'check', 'build'];
  const validationCandidates = preferredScripts.filter((script) => scripts.has(script));

  return {
    workspace: index.workspace,
    indexedFiles: index.files.length,
    indexReusedFiles: reusedFiles,
    queryTerms,
    relevantFiles,
    packageManager: index.packageManager,
    validationCandidates,
    truncated: ranked.length >= maxFiles,
    guidance:
      'Use these ranked file:line excerpts as a compact starting point. Verify any architectural or high-risk assumption by reading the cited file before deciding.'
  };
}
