import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { LocalCoderConfig } from './config.js';
import type { ExecutionBackend } from './execution-runtime.js';
import type { LocalEngineerResult } from './local-engineer.js';
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

function compactResult(result: LocalEngineerResult): Record<string, unknown> {
  const localReasoning = reasoningStats(result);
  const validationPassed = result.validation.every((item) => item.ok);

  return {
    status: result.status,
    phase: result.phase,
    summary: result.summary,
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
        ? 'Local investigation, planning, implementation, deterministic validation, and adversarial review completed. Do not redo the broad implementation in Claude. Fetch run details lazily only if the result is suspicious or the user asks for them.'
        : 'Resolve only the exact escalation questions/research with Claude, then call local_engineer again with the same goal plus claudeGuidance containing the resolved decision/evidence. Do not restart the whole implementation in Claude unless the escalation explicitly requires premium-only execution.'
  };
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
        'Preferred entry point for open-ended repository engineering. The configured local/remote worker performs bounded evidence gathering, high-effort local reasoning/planning, coding, validation, adversarial review, and limited repair. If premium reasoning or external research is needed it returns a compact escalation capsule; Claude should resolve only that gap and call this tool again with claudeGuidance.',
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
            'Use only after this tool escalates: concise Claude-resolved decision, researched external facts, or premium reasoning needed to resume local execution.'
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
    async (input) => {
      try {
        const result = await deps.execution.executeEngineer(input);
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
