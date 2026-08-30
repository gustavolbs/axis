import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { classifyTask, type TaskClassification } from './classifier.js';
import { prepareContextCapsule, RepoIndexStore } from './context-capsule.js';
import type { LocalCoderConfig } from './config.js';
import { executeAgenticCodeTask } from './executor.js';
import type { OllamaClient } from './ollama.js';
import { executeLocalCodePlan } from './orchestrator.js';
import { buildReviewCapsule } from './review-capsule.js';
import { RunStore } from './run-store.js';
import type { TelemetryEvent } from './telemetry.js';

const validationSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).max(40).optional()
});

const routingSchema = z.object({
  solutionKnown: z.boolean().default(true),
  requiresDiscovery: z.boolean().default(false),
  requiresArchitecture: z.boolean().default(false),
  validationKnown: z.boolean().optional(),
  riskTags: z.array(z.string().min(1)).max(20).optional(),
  sensitiveDecisionResolved: z
    .boolean()
    .optional()
    .describe(
      'Set true only after Claude has explicitly resolved auth/credential/permission/security behavior and only bounded implementation remains.'
    )
});

type TelemetryRecorder = (event: Omit<TelemetryEvent, 'timestamp'>) => Promise<void>;

function durationNsToMs(value: number | undefined): number {
  return value ? value / 1_000_000 : 0;
}

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

function sensitiveConstraint(classification: TaskClassification): string[] {
  return classification.route === 'local-supervised'
    ? [
        'Claude already resolved the sensitive behavior. Implement only the explicitly specified bounded change. Do not redesign authentication, authorization, credential, permission, secret, session, or security contracts.'
      ]
    : [];
}

export function registerTokenKillerTools(
  server: McpServer,
  deps: {
    config: LocalCoderConfig;
    ollama: Pick<OllamaClient, 'chat'>;
    recordTelemetry: TelemetryRecorder;
  }
): void {
  const { config, ollama, recordTelemetry } = deps;
  const runs = new RunStore(config.runStorePath);
  const index = new RepoIndexStore(config.contextIndexPath);

  server.registerTool(
    'prepare_local_context',
    {
      title: 'Prepare Compact Local Context',
      description:
        'Build a compact evidence-first context capsule for a coding task using a persistent local repository index. Prefer this before broad Claude file exploration; verify cited file:line evidence for architectural or risky decisions.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        task: z.string().min(1).max(10_000),
        hints: z.array(z.string().min(1)).max(20).optional(),
        maxFiles: z.number().int().min(2).max(16).default(8),
        maxCharsPerFile: z.number().int().min(300).max(3000).default(1200)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async (input) => {
      try {
        const result = await prepareContextCapsule(index, config, input);
        return toolResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'execute_local_code_task_compact',
    {
      title: 'Execute Local Code Task Compactly',
      description:
        'Preferred bounded local executor. It preflights routing itself. Sensitive auth/credential/permission/security implementation may run as local-supervised only after Claude explicitly resolves the sensitive decision; supervised runs force full-diff Claude review.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        task: z.string().min(1),
        editableFiles: z.array(z.string().min(1)).min(1).max(20),
        contextFiles: z.array(z.string().min(1)).max(40).optional(),
        context: z.string().optional(),
        constraints: z.array(z.string().min(1)).max(30).optional(),
        language: z.string().optional(),
        validation: z.array(validationSchema).max(8).optional(),
        maxAttempts: z.number().int().min(1).max(3).default(2),
        rollbackOnFailure: z.boolean().default(true),
        routing: routingSchema.optional()
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
        const classification = classifyTask({
          task: input.task,
          solutionKnown: input.routing?.solutionKnown ?? true,
          requiresDiscovery: input.routing?.requiresDiscovery ?? false,
          requiresArchitecture: input.routing?.requiresArchitecture ?? false,
          estimatedFiles: input.editableFiles.length,
          validationKnown: input.routing?.validationKnown ?? (input.validation?.length ?? 0) > 0,
          riskTags: input.routing?.riskTags,
          sensitiveDecisionResolved: input.routing?.sensitiveDecisionResolved
        });
        await recordTelemetry({ kind: 'classification', route: classification.route });

        if (classification.route === 'claude' || classification.route === 'deterministic') {
          await recordTelemetry({ kind: 'execution', status: 'escalated', model: config.model });
          return toolResult({
            status: 'escalated',
            phase: 'preflight',
            classification,
            blocker:
              classification.route === 'deterministic'
                ? 'This is deterministic-tool work; use repository tooling instead of a local LLM.'
                : `This work must stay in Claude until its blocking reasoning is resolved: ${classification.reasons.join(' ')}`
          });
        }

        const { routing: _routing, ...executionInput } = input;
        const result = await executeAgenticCodeTask(ollama, config, {
          ...executionInput,
          constraints: [
            ...(input.constraints ?? []),
            ...sensitiveConstraint(classification)
          ]
        });
        const validationPassed = result.validation.every((item) => item.ok);
        const supervised = classification.route === 'local-supervised';
        const review = buildReviewCapsule({
          diff: result.diff,
          changedFiles: result.changedFiles,
          validationPassed,
          forceFullDiff: supervised,
          additionalFlags: supervised ? ['local-supervised-sensitive-change'] : []
        });
        const promptTokens = result.generations.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0);
        const completionTokens = result.generations.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0);
        const generationDurationMs = result.generations.reduce(
          (sum, item) => sum + durationNsToMs(item.totalDurationNs),
          0
        );
        const validationDurationMs = result.validation.reduce((sum, item) => sum + item.durationMs, 0);

        await recordTelemetry({
          kind: 'execution',
          status: result.status,
          model: result.generations.at(-1)?.model ?? config.model,
          attempts: result.attempts,
          promptTokens,
          completionTokens,
          generationDurationMs,
          validationDurationMs,
          changedFiles: result.changedFiles.length
        });

        const summary = {
          status: result.status,
          classification,
          attempts: result.attempts,
          changedFiles: result.changedFiles,
          rolledBack: result.rolledBack,
          summary: result.summary,
          validation: {
            passed: validationPassed,
            checks: result.validation.length,
            failed: result.validation.filter((item) => !item.ok).map((item) => `${item.command} ${item.args.join(' ')}`)
          },
          review,
          localInference: { promptTokens, completionTokens, generationDurationMs },
          lazyFetch: supervised
            ? 'Full diff review by Claude is mandatory. Fetch get_local_run(runId, "diff") before approval.'
            : 'Use get_local_run(runId, view) only if the compact review is insufficient.'
        };
        const runId = await runs.save('task', summary, result);
        return toolResult({ runId, ...summary });
      } catch (error) {
        await recordTelemetry({ kind: 'execution', status: 'error', model: config.model });
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'execute_local_code_plan_compact',
    {
      title: 'Execute Large Feature Plan Compactly',
      description:
        'Preferred large-feature orchestrator. Claude owns planning/decomposition. Already-resolved sensitive subtasks can run as local-supervised; any such task forces full aggregate-diff review by Claude.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        goal: z.string().min(1),
        context: z.string().optional(),
        language: z.string().optional(),
        sharedContextFiles: z.array(z.string().min(1)).max(60).optional(),
        sharedConstraints: z.array(z.string().min(1)).max(60).optional(),
        tasks: z
          .array(
            z.object({
              id: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
              task: z.string().min(1),
              dependsOn: z.array(z.string().min(1).max(80)).max(30).optional(),
              editableFiles: z.array(z.string().min(1)).min(1).max(12),
              contextFiles: z.array(z.string().min(1)).max(24).optional(),
              context: z.string().optional(),
              constraints: z.array(z.string().min(1)).max(30).optional(),
              language: z.string().optional(),
              validation: z.array(validationSchema).max(8).optional(),
              maxAttempts: z.number().int().min(1).max(3).default(2),
              routing: routingSchema.optional()
            })
          )
          .min(1)
          .max(30),
        finalValidation: z.array(validationSchema).max(12).optional(),
        rollbackPlanOnFailure: z.boolean().default(true)
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
        const result = await executeLocalCodePlan(ollama, config, input);
        for (const task of result.preflight) {
          await recordTelemetry({ kind: 'classification', route: task.classification.route });
        }

        const supervisedTaskIds = result.preflight
          .filter((task) => task.classification.route === 'local-supervised')
          .map((task) => task.id);
        const hasSupervisedTasks = supervisedTaskIds.length > 0;
        const finalValidationPassed = result.finalValidation.every((item) => item.ok);
        const taskValidationPassed = result.taskResults.every((task) =>
          task.execution.validation.every((item) => item.ok)
        );
        const validationPassed = result.status === 'success' && finalValidationPassed && taskValidationPassed;
        const review = buildReviewCapsule({
          diff: result.diff,
          changedFiles: result.changedFiles,
          validationPassed,
          forceFullDiff: hasSupervisedTasks && result.changedFiles.length > 0,
          additionalFlags: hasSupervisedTasks ? ['contains-local-supervised-sensitive-task'] : []
        });
        const lastModel = result.taskResults.flatMap((task) => task.execution.generations).at(-1)?.model;

        await recordTelemetry({
          kind: 'orchestration',
          status: result.status,
          model: lastModel ?? config.model,
          attempts: result.totals.totalAttempts,
          promptTokens: result.totals.promptTokens,
          completionTokens: result.totals.completionTokens,
          generationDurationMs: result.totals.generationDurationMs,
          validationDurationMs: result.totals.validationDurationMs,
          changedFiles: result.changedFiles.length,
          tasks: result.totals.tasks,
          completedTasks: result.totals.completedTasks
        });

        const summary = {
          status: result.status,
          phase: result.phase,
          failedTaskId: result.failedTaskId,
          tasks: { planned: result.totals.tasks, completed: result.totals.completedTasks },
          routing: {
            supervisedTaskIds,
            fullDiffReviewRequired: hasSupervisedTasks && result.changedFiles.length > 0
          },
          changedFiles: {
            count: result.changedFiles.length,
            sample: result.changedFiles.slice(0, 12)
          },
          rolledBack: result.rolledBack,
          blockers: result.blockers.slice(0, 4),
          validation: {
            passed: validationPassed,
            finalChecks: result.finalValidation.length,
            failedFinal: result.finalValidation
              .filter((item) => !item.ok)
              .map((item) => `${item.command} ${item.args.join(' ')}`)
          },
          review,
          localInference: {
            promptTokens: result.totals.promptTokens,
            completionTokens: result.totals.completionTokens,
            generationDurationMs: result.totals.generationDurationMs,
            validationDurationMs: result.totals.validationDurationMs
          },
          lazyFetch: hasSupervisedTasks && result.changedFiles.length > 0
            ? 'Full aggregate diff review by Claude is mandatory. Fetch get_local_run(runId, "diff") before approval.'
            : 'Use get_local_run(runId, view) only for suspicious/high-risk details or failed checks.'
        };
        const runId = await runs.save('plan', summary, result);
        return toolResult({ runId, ...summary });
      } catch (error) {
        await recordTelemetry({ kind: 'orchestration', status: 'error', model: config.model });
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'get_local_run',
    {
      title: 'Fetch Local Run Details Lazily',
      description:
        'Fetch a stored local execution result only when Claude needs more detail. Prefer summary first; request diff, validation, or full incrementally with offset/maxChars instead of loading a large result into context at once.',
      inputSchema: z.object({
        runId: z.string().min(1),
        view: z.enum(['summary', 'diff', 'validation', 'full']).default('summary'),
        offset: z.number().int().min(0).default(0),
        maxChars: z.number().int().min(1000).max(50000).default(12000)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async (input) => {
      try {
        const result = await runs.read(input.runId, input.view, input);
        return toolResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
