import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { LocalCoderConfig } from './config.js';
import type { ExecutionBackend } from './execution-runtime.js';
import type { LocalEngineerInput, LocalEngineerResult } from './local-engineer.js';
import type {
  PremiumDecisionRequest,
  PremiumEngineerResult
} from './premium-agent.js';
import type { RepoIntelligenceRunSummary } from './repo-intelligence.js';
import { RunStore } from './run-store.js';
import { TelemetryStore } from './telemetry.js';

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function durationNsToMs(value: number | undefined): number {
  return value ? value / 1_000_000 : 0;
}

function reasoningStats(result: LocalEngineerResult) {
  const modelCalls = result.modelCalls ?? [];
  return {
    calls: modelCalls.length,
    promptTokens: modelCalls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0),
    completionTokens: modelCalls.reduce(
      (sum, call) => sum + (call.completionTokens ?? 0),
      0
    ),
    durationMs: modelCalls.reduce(
      (sum, call) => sum + durationNsToMs(call.totalDurationNs),
      0
    )
  };
}

function premiumResult(result: LocalEngineerResult): PremiumEngineerResult {
  return result as PremiumEngineerResult;
}

function compactDecisionRequest(
  decisionRequest: PremiumDecisionRequest | undefined
): Record<string, unknown> | undefined {
  if (!decisionRequest) return undefined;
  return {
    message: decisionRequest.message,
    questions: decisionRequest.questions.map((question) => ({
      id: question.id,
      question: question.question,
      rationale: question.rationale,
      recommendedOptionId: question.recommendedOptionId,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        tradeoff: option.tradeoff
      }))
    }))
  };
}

function compactResult(result: LocalEngineerResult): Record<string, unknown> {
  const localReasoning = reasoningStats(result);
  const validationPassed = result.validation.every((item) => item.ok);
  const repoIntelligence = (
    result as LocalEngineerResult & { repoIntelligence?: RepoIntelligenceRunSummary }
  ).repoIntelligence;
  const premium = premiumResult(result);
  const decisionRequest = compactDecisionRequest(premium.decisionRequest);

  return {
    status: result.status,
    phase: result.phase,
    summary: result.summary,
    preflight: premium.preflight,
    decisionRequest,
    repoIntelligence: repoIntelligence
      ? {
          enabled: repoIntelligence.enabled,
          familiarity: repoIntelligence.familiarity,
          retrievedFacts: repoIntelligence.retrievedFacts,
          learnedFacts: repoIntelligence.learnedFacts,
          gitChangesDetected: repoIntelligence.gitChangesDetected,
          reason: repoIntelligence.reason
        }
      : undefined,
    plan: result.plan
      ? {
          confidence: result.plan.confidence,
          tasks: result.plan.tasks.length,
          taskIds: result.plan.tasks.map((task) => task.id).slice(0, 12),
          riskTags: result.plan.riskTags,
          sensitiveDecisionRequired: result.plan.sensitiveDecisionRequired
        }
      : undefined,
    changedFiles: {
      count: result.changedFiles.length,
      sample: result.changedFiles.slice(0, 12)
    },
    validation: {
      passed: validationPassed,
      checks: result.validation.length,
      failed: result.validation
        .filter((item) => !item.ok)
        .map((item) => `${item.command} ${item.args.join(' ')}`)
    },
    review: result.review
      ? {
          verdict: result.review.verdict,
          confidence: result.review.confidence,
          issues: result.review.issues.length,
          highSeverityIssues: result.review.issues.filter((issue) => issue.severity === 'high').length
        }
      : undefined,
    repairRounds: result.repairRounds,
    localReasoning,
    escalation: result.escalation,
    nextAction:
      result.status === 'success'
        ? 'The local agent completed the requested work. Do not redo broad reasoning or implementation in Claude. Fetch run details lazily only when detailed evidence is needed.'
        : decisionRequest
          ? 'A material user preference is required. If direct MCP elicitation was unavailable, ask the user only the structured decisionRequest, then call local_engineer again with claudeGuidance containing the selected option(s). Do not decide the preference in Claude and do not redo repository analysis.'
          : result.escalation?.kind === 'external-research'
            ? 'The local research broker could not resolve only the remaining external facts. Resolve exactly those researchRequests from authoritative sources, then call local_engineer again with claudeGuidance. Do not redo repository analysis or implementation in Claude.'
            : 'Resolve only the exact escalation gap, then call local_engineer again with claudeGuidance. Do not restart the whole implementation in Claude unless the escalation explicitly requires premium-only judgment.'
  };
}

type ElicitationResult = {
  action?: 'accept' | 'decline' | 'cancel' | string;
  content?: Record<string, unknown>;
};

type ElicitationContext = {
  mcpReq?: {
    elicitInput?: (request: {
      mode: 'form';
      message: string;
      requestedSchema: Record<string, unknown>;
    }) => Promise<ElicitationResult>;
  };
};

function elicitationSchema(request: PremiumDecisionRequest): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: request.questions.map((question) => question.id),
    properties: Object.fromEntries(
      request.questions.map((question) => [
        question.id,
        {
          type: 'string',
          title: question.question,
          description: [
            question.rationale,
            ...question.options.map((option) =>
              `${option.id}: ${option.label}${option.id === question.recommendedOptionId ? ' [recommended]' : ''} — ${option.tradeoff}`
            )
          ].join('\n'),
          enum: question.options.map((option) => option.id)
        }
      ])
    )
  };
}

function renderUserDecisionGuidance(
  request: PremiumDecisionRequest,
  content: Record<string, unknown>
): string | undefined {
  const selected: string[] = [];
  for (const question of request.questions) {
    const optionId = content[question.id];
    if (typeof optionId !== 'string') continue;
    const option = question.options.find((candidate) => candidate.id === optionId);
    if (!option) continue;
    selected.push(
      `- ${question.id}: ${option.id} — ${option.label}. This is an explicit user decision and is authoritative for this run.`
    );
  }
  if (!selected.length) return undefined;
  return ['# USER DECISIONS (authoritative)', ...selected].join('\n');
}

async function executeWithDirectDecisions(
  execution: Pick<ExecutionBackend, 'executeEngineer'>,
  initialInput: LocalEngineerInput,
  context: unknown
): Promise<LocalEngineerResult> {
  let input = initialInput;
  let result = await execution.executeEngineer(input);
  const mcpReq = (context as ElicitationContext | undefined)?.mcpReq;

  for (let round = 0; round < 3; round += 1) {
    const request = premiumResult(result).decisionRequest;
    if (!request?.questions.length || !mcpReq?.elicitInput) break;

    let elicited: ElicitationResult;
    try {
      elicited = await mcpReq.elicitInput({
        mode: 'form',
        message: request.message,
        requestedSchema: elicitationSchema(request)
      });
    } catch {
      // Some MCP clients do not expose elicitation yet. Preserve the structured
      // decisionRequest so the host/Claude can ask only that question as fallback.
      break;
    }

    if (elicited.action !== 'accept' || !elicited.content) break;
    const decisionGuidance = renderUserDecisionGuidance(request, elicited.content);
    if (!decisionGuidance) break;
    input = {
      ...input,
      claudeGuidance: [input.claudeGuidance?.trim(), decisionGuidance]
        .filter(Boolean)
        .join('\n\n')
    };
    result = await execution.executeEngineer(input);
  }

  return result;
}

export function registerLocalEngineerTools(
  server: McpServer,
  deps: {
    config: LocalCoderConfig;
    execution: Pick<ExecutionBackend, 'executeEngineer'>;
  }
): void {
  const runs = new RunStore(deps.config.runStorePath);
  const telemetry = new TelemetryStore(
    deps.config.telemetryPath,
    deps.config.telemetryEnabled
  );

  server.registerTool(
    'local_engineer',
    {
      title: 'Local Software Engineer',
      description:
        'Primary local-first software-engineering agent. It analyzes feature impact, follows repository conventions, researches external facts locally where possible, decomposes work into bounded dependency-ordered tasks, implements, validates, reviews, repairs, and learns repository conventions. Material user preferences are elicited directly when the MCP host supports it; Claude is only a compact fallback bridge for unresolved user decisions, external research, or premium-only judgment.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        goal: z.string().min(1).max(20_000),
        context: z.string().max(20_000).optional(),
        constraints: z.array(z.string().min(1).max(2_000)).max(30).optional(),
        language: z.string().max(500).optional(),
        claudeGuidance: z
          .string()
          .max(30_000)
          .optional()
          .describe(
            'Use only after the local agent requests a material user decision, unresolved authoritative research, or premium judgment. Keep it concise and do not redo repository analysis.'
          ),
        maxRepairRounds: z.number().int().min(0).max(2).default(1)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async (input, context) => {
      try {
        const result = await executeWithDirectDecisions(deps.execution, input, context);
        const localReasoning = reasoningStats(result);
        const execution = result.execution;
        const promptTokens =
          localReasoning.promptTokens + (execution?.totals.promptTokens ?? 0);
        const completionTokens =
          localReasoning.completionTokens + (execution?.totals.completionTokens ?? 0);
        const generationDurationMs =
          localReasoning.durationMs + (execution?.totals.generationDurationMs ?? 0);
        const validationDurationMs = result.validation.reduce(
          (sum, item) => sum + item.durationMs,
          0
        );
        const model =
          result.modelCalls.at(-1)?.model ??
          execution?.taskResults.flatMap((task) => task.execution.generations).at(-1)?.model ??
          deps.config.model;

        await telemetry.record({
          kind: 'engineering',
          status: result.status,
          model,
          repairRounds: result.repairRounds,
          promptTokens,
          completionTokens,
          generationDurationMs,
          validationDurationMs,
          changedFiles: result.changedFiles.length,
          tasks: result.plan?.tasks.length ?? 0,
          completedTasks: execution?.totals.completedTasks ?? 0
        });

        const summary = compactResult(result);
        const runId = await runs.save('engineer', summary, result);
        return toolResult({
          runId,
          ...summary,
          lazyFetch:
            'Use get_local_run(runId, "diff"|"validation"|"full") only when detailed evidence is actually needed.'
        });
      } catch (error) {
        try {
          await telemetry.record({
            kind: 'engineering',
            status: 'error',
            model: deps.config.model
          });
        } catch {
          // Telemetry must never hide the original tool error.
        }
        return errorResult(error);
      }
    }
  );
}