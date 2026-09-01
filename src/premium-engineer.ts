import * as z from 'zod/v4';

import {
  prepareContextCapsule,
  RepoIndexStore,
  type ContextCapsule
} from './context-capsule.js';
import type { LocalCoderConfig } from './config.js';
import { discoverWorkspace, searchWorkspace } from './discovery.js';
import type {
  LocalEngineerEscalation,
  LocalEngineerExecution,
  LocalEngineerInput,
  LocalEngineerResult
} from './local-engineer.js';
import type { OllamaClient, OllamaGeneration } from './ollama.js';
import { reportProgress } from './progress-context.js';
import { executeLocalEngineerWithRepoIntelligence } from './repo-intelligence.js';
import {
  readWorkspaceFile,
  resolveWorkspace,
  resolveWorkspacePath
} from './workspace.js';

type PremiumEngineerInput = LocalEngineerInput & { repoMemoryScopeKey?: string };
type EngineerModel = Pick<OllamaClient, 'chat'>;
type SearchHit = { path: string; line: number; preview: string };

const investigatorSchema = z.object({
  summary: z.string().min(1),
  searchQueries: z.array(z.string().min(1).max(200)).max(8).default([]),
  fileHints: z.array(z.string().min(1).max(500)).max(16).default([]),
  researchRequests: z.array(z.string().min(1).max(700)).max(8).default([])
});

const reportSchema = z.object({
  summary: z.string().min(1).max(5000),
  confidence: z.number().min(0).max(1),
  findings: z
    .array(
      z.object({
        claim: z.string().min(1).max(2000),
        evidence: z.array(z.string().min(1).max(500)).max(8).default([])
      })
    )
    .max(16)
    .default([]),
  userActions: z.array(z.string().min(1).max(1500)).max(16).default([]),
  constraints: z.array(z.string().min(1).max(1500)).max(16).default([]),
  unresolvedQuestions: z.array(z.string().min(1).max(1500)).max(10).default([]),
  researchRequests: z.array(z.string().min(1).max(1000)).max(8).default([])
});

const investigatorFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'searchQueries', 'fileHints', 'researchRequests'],
  properties: {
    summary: { type: 'string' },
    searchQueries: { type: 'array', maxItems: 8, items: { type: 'string' } },
    fileHints: { type: 'array', maxItems: 16, items: { type: 'string' } },
    researchRequests: { type: 'array', maxItems: 8, items: { type: 'string' } }
  }
} satisfies Record<string, unknown>;

const reportFormat = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'confidence',
    'findings',
    'userActions',
    'constraints',
    'unresolvedQuestions',
    'researchRequests'
  ],
  properties: {
    summary: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    findings: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence'],
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'array', maxItems: 8, items: { type: 'string' } }
        }
      }
    },
    userActions: { type: 'array', maxItems: 16, items: { type: 'string' } },
    constraints: { type: 'array', maxItems: 16, items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', maxItems: 10, items: { type: 'string' } },
    researchRequests: { type: 'array', maxItems: 8, items: { type: 'string' } }
  }
} satisfies Record<string, unknown>;

const RESEARCH_INVESTIGATOR_SYSTEM_PROMPT = `You are the investigation stage of a local software-engineering agent.
This request is explicitly read-only. Do not design implementation tasks and do not edit code.
Identify the exact repository searches/files needed to answer the user's question from source evidence.
researchRequests is ONLY for genuinely external/current provider, library or platform facts that cannot exist in the local repository.
Never put "read the rest of file X", "inspect symbol Y", "read docs/test X", a local file path, or another repository lookup in researchRequests. Put symbols in searchQueries and paths in fileHints instead; the host will complete those reads automatically.
Prefer exact symbols, routes, flags, scopes, environment variables and file paths over broad searches.
Return only the required JSON.`;

const RESEARCH_REPORTER_SYSTEM_PROMPT = `You are a read-only repository research reporter.
Answer the user's operational/technical question from verified repository evidence plus explicit external guidance supplied through the Local Coder app, if any.
Do not invent current external provider behavior. researchRequests is ONLY for genuinely external/current facts that cannot be answered by reading more local source code, tests or docs.
If more local evidence is required, put the exact missing local reads/searches in researchRequests anyway; the host will intercept those requests, read them locally, and rerun you before any external guidance request.
Produce an actionable report: exact commands/flags/routes/scopes where evidenced, evidence references, user actions, constraints, and unresolved questions.
Do not propose code changes unless the user asked for implementation; this path is read-only.
Return only the required JSON.`;

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function isReadOnlyEngineerRequest(input: LocalEngineerInput): boolean {
  const text = [input.goal, ...(input.constraints ?? [])].join('\n').toLowerCase();
  return [
    /\bread[- ]?only\b/,
    /\bdo not (?:modify|edit|change|implement|write)\b/,
    /\bwithout (?:modifying|editing|changing)\b/,
    /\bn[aã]o alter(?:ar|e|e o|e a)?\b/,
    /\bn[aã]o implemente\b/,
    /\bsem alterar\b/,
    /\bsomente (?:investig|analis|document)/,
    /\binvestiga[cç][aã]o read-only\b/
  ].some((pattern) => pattern.test(text));
}

function capsuleText(capsule: ContextCapsule): string {
  const files = capsule.relevantFiles
    .map((file) => {
      const evidence = file.evidence
        .map((item) => `${file.path}:${item.startLine}-${item.endLine}\n${item.content}`)
        .join('\n\n');
      return `## ${file.path}\nscore=${file.score}; reasons=${file.reasons.join(', ')}\n${evidence}`;
    })
    .join('\n\n');
  return [
    `packageManager=${capsule.packageManager ?? 'unknown'}`,
    `validationCandidates=${capsule.validationCandidates.join(', ') || '[none]'}`,
    `queryTerms=${capsule.queryTerms.join(', ')}`,
    files || '[no ranked evidence]'
  ].join('\n\n');
}

function discoveryText(discovery: Awaited<ReturnType<typeof discoverWorkspace>>): string {
  return [
    `packageManager=${discovery.packageManager ?? 'unknown'}`,
    `packageScripts=${(discovery.packageScripts ?? []).join(', ') || '[none]'}`,
    `truncated=${String(discovery.truncated)}`,
    '# FILE MAP',
    discovery.files.slice(0, 300).join('\n') || '[empty]'
  ].join('\n');
}

async function collectSearchEvidence(
  workspace: string,
  queries: string[],
  config: LocalCoderConfig
): Promise<{ text: string; matchedFiles: string[]; hits: SearchHit[] }> {
  const sections: string[] = [];
  const matchedFiles: string[] = [];
  const hits: SearchHit[] = [];
  for (const query of dedupe(queries).slice(0, 12)) {
    try {
      const result = await searchWorkspace(workspace, query, {
        maxResults: 16,
        maxFiles: 1_200,
        maxDepth: 12,
        maxFileBytes: config.maxFileBytes
      });
      sections.push(
        `## SEARCH ${JSON.stringify(query)}\n${result.matches
          .map((match) => `${match.path}:${match.line} ${match.preview}`)
          .join('\n') || '[no matches]'}`
      );
      for (const match of result.matches) {
        matchedFiles.push(match.path);
        hits.push({ path: match.path, line: match.line, preview: match.preview });
      }
    } catch (error) {
      sections.push(
        `## SEARCH ${JSON.stringify(query)}\n[search failed: ${error instanceof Error ? error.message : String(error)}]`
      );
    }
  }
  return { text: sections.join('\n\n'), matchedFiles: dedupe(matchedFiles), hits };
}

function lineWindows(content: string, lines: number[], maxChars: number): string {
  const source = content.split(/\r?\n/);
  if (source.length === 0) return '';
  const ranges: Array<[number, number]> = [];
  for (const line of dedupe(lines.filter((value) => Number.isFinite(value) && value > 0)).slice(0, 8)) {
    const start = Math.max(1, line - 45);
    const end = Math.min(source.length, line + 70);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1] + 10) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  let output = '';
  for (const [start, end] of ranges) {
    const block = source
      .slice(start - 1, end)
      .map((value, index) => `${start + index}: ${value}`)
      .join('\n');
    const next = `${output}${output ? '\n\n' : ''}[lines ${start}-${end}]\n${block}`;
    if (next.length > maxChars) break;
    output = next;
  }
  return output;
}

function boundedFileEvidence(content: string, hitLines: number[], maxChars: number): string {
  if (content.length <= maxChars) return content;
  const windows = lineWindows(content, hitLines, maxChars);
  if (windows.length >= 400) return windows;
  const half = Math.max(1, Math.floor((maxChars - 120) / 2));
  return `${content.slice(0, half)}\n\n[... middle omitted; no targeted search hit ...]\n\n${content.slice(-half)}`;
}

async function collectFullEvidence(
  workspace: string,
  files: string[],
  config: LocalCoderConfig,
  hits: SearchHit[] = []
): Promise<{ text: string; files: string[] }> {
  const sections: string[] = [];
  const included: string[] = [];
  let used = 0;
  const budget = Math.min(config.maxContextBytes, 44_000);
  const hitsByFile = new Map<string, number[]>();
  for (const hit of hits) {
    const lines = hitsByFile.get(hit.path) ?? [];
    lines.push(hit.line);
    hitsByFile.set(hit.path, lines);
  }

  for (const file of dedupe(files).slice(0, 14)) {
    try {
      resolveWorkspacePath(workspace, file);
      const snapshot = await readWorkspaceFile(workspace, file, config.maxFileBytes);
      if (snapshot.content === null) continue;
      const remaining = Math.max(0, budget - used);
      if (remaining < 700) break;
      const perFile = Math.min(9_000, remaining);
      const content = boundedFileEvidence(snapshot.content, hitsByFile.get(file) ?? [], perFile);
      sections.push(`## FILE ${file}\n${content}`);
      included.push(file);
      used += content.length;
    } catch {
      // Model-produced hints are untrusted. Invalid or blocked paths are ignored.
    }
  }
  return { text: sections.join('\n\n'), files: included };
}

const LOCAL_PATH_PATTERN = /(?:^|[\s`'"(])((?:apps|packages|src|lib|docs|test|tests|scripts|config)\/[A-Za-z0-9_./@-]+\.[A-Za-z0-9_-]+)/gi;
const LOCAL_READ_PATTERN = /\b(?:read|inspect|open|continue|rest of|remaining|ler|leia|restante|arquivo|linhas?|line|symbol|fun[cç][aã]o|teste|test)\b/i;

function localEvidenceRequest(request: string): boolean {
  LOCAL_PATH_PATTERN.lastIndex = 0;
  return LOCAL_PATH_PATTERN.test(request) ||
    (LOCAL_READ_PATTERN.test(request) && /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|cs|yml|yaml)\b/i.test(request));
}

function extractLocalEvidenceHints(requests: string[]): { paths: string[]; queries: string[] } {
  const paths: string[] = [];
  const queries: string[] = [];
  for (const request of requests) {
    LOCAL_PATH_PATTERN.lastIndex = 0;
    for (const match of request.matchAll(LOCAL_PATH_PATTERN)) paths.push(match[1]);
    const backticks = [...request.matchAll(/`([^`]{2,100})`/g)].map((match) => match[1]);
    const identifiers = request.match(/\b[A-Za-z_$][A-Za-z0-9_$]{3,}\b/g) ?? [];
    queries.push(
      ...backticks.filter((value) => !value.includes('/')),
      ...identifiers.filter((value) => /[A-Z]/.test(value.slice(1)) || /(?:sync|tenant|redirect|authorization|calendar|connection|provider|validate)/i.test(value))
    );
  }
  return { paths: dedupe(paths).slice(0, 16), queries: dedupe(queries).slice(0, 12) };
}

function partitionResearchRequests(requests: string[]): { local: string[]; external: string[] } {
  const local: string[] = [];
  const external: string[] = [];
  for (const request of dedupe(requests)) {
    (localEvidenceRequest(request) ? local : external).push(request);
  }
  return { local, external };
}

function evidenceRefs(capsule: ContextCapsule, searchText: string): string[] {
  const cited = capsule.relevantFiles.flatMap((file) =>
    file.evidence.map((item) => `${file.path}:${item.startLine}-${item.endLine}`)
  );
  const searched = searchText
    .split(/\r?\n/)
    .filter((line) => /:\d+\s/.test(line))
    .slice(0, 20);
  return dedupe([...cited, ...searched]).slice(0, 24);
}

function escalation(reason: string, requests: string[], evidence: string[]): LocalEngineerEscalation {
  return {
    kind: 'external-research',
    reason,
    questions: ['Resolve only the listed external facts from authoritative sources; do not redo repository analysis.'],
    researchRequests: requests,
    evidence: evidence.slice(0, 12),
    resumeWith:
      'Resume the job with userGuidance containing the resolved decision or research evidence.'
  };
}

function generationMeta(
  stage: 'investigation' | 'planning',
  generation: OllamaGeneration
): LocalEngineerResult['modelCalls'][number] {
  return {
    stage,
    model: generation.model,
    promptTokens: generation.promptTokens,
    completionTokens: generation.completionTokens,
    totalDurationNs: generation.totalDurationNs
  };
}

function renderReport(report: z.infer<typeof reportSchema>): string {
  const sections = [report.summary.trim()];
  if (report.findings.length) {
    sections.push(
      `Findings:\n${report.findings
        .map((finding, index) => `${index + 1}. ${finding.claim}${finding.evidence.length ? ` [${finding.evidence.join('; ')}]` : ''}`)
        .join('\n')}`
    );
  }
  if (report.userActions.length) sections.push(`User actions:\n${report.userActions.map((item) => `- ${item}`).join('\n')}`);
  if (report.constraints.length) sections.push(`Constraints:\n${report.constraints.map((item) => `- ${item}`).join('\n')}`);
  if (report.unresolvedQuestions.length) sections.push(`Unresolved questions:\n${report.unresolvedQuestions.map((item) => `- ${item}`).join('\n')}`);
  sections.push(`Confidence: ${report.confidence.toFixed(2)}`);
  return sections.join('\n\n');
}

async function executeReadOnlyResearch(
  model: EngineerModel,
  config: LocalCoderConfig,
  input: PremiumEngineerInput
): Promise<LocalEngineerExecution> {
  const workspace = await resolveWorkspace(input.workspace);
  reportProgress({
    phase: 'investigation',
    action: 'Read-only request detected; implementation pipeline is disabled',
    detail: input.goal,
    reasoningSummary: 'This job will complete local repository evidence before considering any external guidance request.',
    completedSteps: ['workspace']
  });

  const discovery = await discoverWorkspace(workspace, { maxDepth: 7, maxEntries: 1_200 });
  const index = new RepoIndexStore(config.contextIndexPath);
  const initialCapsule = await prepareContextCapsule(index, config, {
    workspace,
    task: input.goal,
    maxFiles: 10,
    maxCharsPerFile: 1_800
  });

  const investigationGeneration = await model.chat(
    RESEARCH_INVESTIGATOR_SYSTEM_PROMPT,
    [
      `# GOAL\n${input.goal}`,
      input.context ? `# CONTEXT\n${input.context}` : '',
      input.userGuidance ? `# RESOLVED GUIDANCE\n${input.userGuidance}` : '',
      `# REPOSITORY MAP\n${discoveryText(discovery)}`,
      `# INITIAL EVIDENCE\n${capsuleText(initialCapsule)}`
    ].filter(Boolean).join('\n\n'),
    investigatorFormat,
    {
      model: config.model,
      numCtx: config.ollamaNumCtx ?? 16_384,
      keepAlive: config.fastModelKeepAlive ?? '90s',
      think: 'medium'
    }
  );
  const investigation = investigatorSchema.parse(JSON.parse(investigationGeneration.content) as unknown);
  const initialPartition = partitionResearchRequests(investigation.researchRequests);
  const localHints = extractLocalEvidenceHints(initialPartition.local);
  const effectiveQueries = dedupe([...investigation.searchQueries, ...localHints.queries]);

  let searchEvidence = await collectSearchEvidence(workspace, effectiveQueries, config);
  const focusedCapsule = await prepareContextCapsule(index, config, {
    workspace,
    task: input.goal,
    hints: effectiveQueries,
    maxFiles: 10,
    maxCharsPerFile: 1_500
  });
  let evidenceFiles = dedupe([
    ...investigation.fileHints,
    ...localHints.paths,
    ...searchEvidence.matchedFiles,
    ...focusedCapsule.relevantFiles.map((file) => file.path)
  ]);
  let fullEvidence = await collectFullEvidence(workspace, evidenceFiles, config, searchEvidence.hits);
  let refs = evidenceRefs(focusedCapsule, searchEvidence.text);
  const modelCalls: LocalEngineerResult['modelCalls'] = [generationMeta('investigation', investigationGeneration)];

  if (initialPartition.local.length > 0) {
    reportProgress({
      phase: 'investigation',
      action: 'Completing repository evidence locally',
      detail: initialPartition.local.join(' | '),
      reasoningSummary: 'Requests that only require reading source/tests/docs are being resolved locally, not escalated as external research.'
    });
  }

  if (initialPartition.external.length > 0 && !input.userGuidance?.trim()) {
    return {
      result: {
        status: 'needs-guidance',
        phase: 'investigation',
        workspace,
        goal: input.goal,
        summary: investigation.summary,
        investigation: {
          searchQueries: effectiveQueries,
          evidenceFiles: fullEvidence.files,
          researchRequests: initialPartition.external
        },
        repairRounds: 0,
        changedFiles: [],
        diff: '',
        validation: [],
        escalation: escalation(investigation.summary, initialPartition.external, refs),
        modelCalls
      },
      changes: []
    };
  }

  let report: z.infer<typeof reportSchema> | undefined;
  for (let evidenceRound = 0; evidenceRound < 2; evidenceRound += 1) {
    const reportGeneration = await model.chat(
      RESEARCH_REPORTER_SYSTEM_PROMPT,
      [
        `# GOAL\n${input.goal}`,
        input.context ? `# USER / PROJECT CONTEXT\n${input.context}` : '',
        input.constraints?.length ? `# CONSTRAINTS\n${input.constraints.map((item) => `- ${item}`).join('\n')}` : '',
        input.userGuidance ? `# AUTHORITATIVE EXTERNAL GUIDANCE\n${input.userGuidance}` : '',
        `# INVESTIGATION SUMMARY\n${investigation.summary}`,
        `# SEARCH EVIDENCE\n${searchEvidence.text || '[none]'}`,
        `# RANKED EVIDENCE\n${capsuleText(focusedCapsule)}`,
        `# VERIFIED FILE CONTENT\n${fullEvidence.text || '[none]'}`
      ].filter(Boolean).join('\n\n'),
      reportFormat,
      {
        model: config.model,
        numCtx: config.ollamaNumCtx ?? 16_384,
        keepAlive: config.fastModelKeepAlive ?? '90s',
        think: 'medium'
      }
    );
    modelCalls.push(generationMeta('planning', reportGeneration));
    report = reportSchema.parse(JSON.parse(reportGeneration.content) as unknown);
    const partition = partitionResearchRequests(report.researchRequests);

    if (partition.local.length > 0 && evidenceRound === 0) {
      const more = extractLocalEvidenceHints(partition.local);
      reportProgress({
        phase: 'investigation',
        action: 'Reporter requested more local evidence; resolving it automatically',
        detail: partition.local.join(' | '),
        reasoningSummary: 'The host is expanding targeted source windows instead of returning needs-guidance for unread local files.'
      });
      const moreSearch = await collectSearchEvidence(workspace, more.queries, config);
      searchEvidence = {
        text: [searchEvidence.text, moreSearch.text].filter(Boolean).join('\n\n'),
        matchedFiles: dedupe([...searchEvidence.matchedFiles, ...moreSearch.matchedFiles]),
        hits: [...searchEvidence.hits, ...moreSearch.hits]
      };
      evidenceFiles = dedupe([...evidenceFiles, ...more.paths, ...moreSearch.matchedFiles]);
      fullEvidence = await collectFullEvidence(workspace, evidenceFiles, config, searchEvidence.hits);
      refs = evidenceRefs(focusedCapsule, searchEvidence.text);
      if (partition.external.length === 0) continue;
    }

    if (partition.external.length > 0 && !input.userGuidance?.trim()) {
      return {
        result: {
          status: 'needs-guidance',
          phase: 'investigation',
          workspace,
          goal: input.goal,
          summary: report.summary,
          investigation: {
            searchQueries: effectiveQueries,
            evidenceFiles: fullEvidence.files,
            researchRequests: partition.external
          },
          repairRounds: 0,
          changedFiles: [],
          diff: '',
          validation: [],
          escalation: escalation(report.summary, partition.external, refs),
          modelCalls
        },
        changes: []
      };
    }
    break;
  }

  if (!report) throw new Error('Read-only reporter did not produce a result.');
  const remaining = partitionResearchRequests(report.researchRequests);
  if (remaining.local.length > 0 && !input.userGuidance?.trim()) {
    return {
      result: {
        status: 'needs-guidance',
        phase: 'investigation',
        workspace,
        goal: input.goal,
        summary: `${report.summary} Local evidence completion did not converge within the bounded two-pass budget.`,
        investigation: {
          searchQueries: effectiveQueries,
          evidenceFiles: fullEvidence.files,
          researchRequests: []
        },
        repairRounds: 0,
        changedFiles: [],
        diff: '',
        validation: [],
        escalation: {
          kind: 'decision',
          reason: 'The local agent exhausted its bounded local-evidence expansion loop; this is not external research.',
          questions: remaining.local,
          researchRequests: [],
          evidence: refs.slice(0, 12),
          resumeWith: 'Resume the job with userGuidance containing the resolved decision or research evidence.'
        },
        modelCalls
      },
      changes: []
    };
  }

  reportProgress({
    phase: 'complete',
    action: 'Read-only repository research completed',
    detail: report.summary,
    reasoningSummary: 'The local agent completed local evidence expansion and produced the final report without entering implementation.',
    completedSteps: ['workspace', 'investigation', 'report', 'complete']
  });

  return {
    result: {
      status: 'success',
      phase: 'complete',
      workspace,
      goal: input.goal,
      summary: renderReport(report),
      investigation: {
        searchQueries: effectiveQueries,
        evidenceFiles: fullEvidence.files,
        researchRequests: []
      },
      repairRounds: 0,
      changedFiles: [],
      diff: '',
      validation: [],
      modelCalls
    },
    changes: []
  };
}

export async function executePremiumLocalEngineer(
  model: EngineerModel,
  config: LocalCoderConfig,
  input: PremiumEngineerInput
): Promise<LocalEngineerExecution> {
  if (isReadOnlyEngineerRequest(input)) return await executeReadOnlyResearch(model, config, input);
  return await executeLocalEngineerWithRepoIntelligence(model, config, input);
}
