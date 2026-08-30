import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { classifyTask } from './classifier.js';
import { loadConfig } from './config.js';
import { discoverWorkspace, searchWorkspace } from './discovery.js';
import { executeAgenticCodeTask } from './executor.js';
import { OllamaClient } from './ollama.js';
import { executeLocalCodePlan } from './orchestrator.js';
import { buildTaskPrompt, LOCAL_CODER_SYSTEM_PROMPT } from './prompt.js';
import { TelemetryStore, type TelemetryEvent } from './telemetry.js';
import { registerTokenKillerTools } from './token-killer-tools.js';

const config = loadConfig();
const ollama = new OllamaClient(config);
const telemetry = new TelemetryStore(config.telemetryPath, config.telemetryEnabled);

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true
  };
}

async function recordTelemetry(event: Omit<TelemetryEvent, 'timestamp'>): Promise<void> {
  try {
    await telemetry.record(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`local-coder telemetry write failed: ${message}`);
  }
}

function durationNsToMs(value: number | undefined): number {
  return value ? value / 1_000_000 : 0;
}

const validationSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Executable name from the configured validation allowlist.'),
  args: z.array(z.string()).max(40).optional().describe('Arguments passed without a shell.')
});

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'local-coder-mcp',
      version: '0.5.0'
    },
    {
      instructions:
        'Local coding execution and token-saving context tools. Prefer prepare_local_context before broad repository reads; use compact task/plan executors for bounded implementation and get_local_run only when more review detail is necessary. Claude owns architecture, ambiguity, security-sensitive decisions, decomposition of large features, and final review.'
    }
  );

  server.registerTool(
    'local_coder_health',
    {
      title: 'Local Coder Health',
      description:
        'Check whether the local Ollama server is reachable and whether the configured local coding model is installed.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async () => {
      try {
        const health = await ollama.health();

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(health, null, 2) }],
          structuredContent: health
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'classify_local_code_task',
    {
      title: 'Classify Coding Task Route',
      description:
        'Deterministically classify a coding task as deterministic-tool work, safe bounded local-model work, or Claude work. Use this when routing is not obvious before spending model tokens on implementation.',
      inputSchema: z.object({
        task: z.string().min(1).describe('Task/request to classify.'),
        solutionKnown: z.boolean().optional().describe('Whether Claude already knows the implementation approach.'),
        requiresDiscovery: z.boolean().default(false).describe('Whether root-cause/repository discovery is still required.'),
        requiresArchitecture: z.boolean().default(false).describe('Whether architecture/design decisions are still required.'),
        estimatedFiles: z.number().int().min(0).max(1000).optional().describe('Estimated number of files that need edits.'),
        validationKnown: z.boolean().optional().describe('Whether concrete validation commands/checks are already known.'),
        riskTags: z.array(z.string().min(1)).max(20).optional().describe('Optional risk tags such as auth, migration, concurrency, or production-infra.')
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
        const result = classifyTask(input);
        await recordTelemetry({ kind: 'classification', route: result.route });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'discover_local_workspace',
    {
      title: 'Discover Local Workspace',
      description:
        'Safely list a bounded view of a local workspace without following symlinks or entering generated/dependency directories. Also reports detected package manager and root package scripts when available.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Absolute workspace path.'),
        maxDepth: z.number().int().min(1).max(12).default(4),
        maxEntries: z.number().int().min(1).max(5000).default(400),
        extensions: z.array(z.string().min(1)).max(50).optional().describe('Optional extension filter such as ts, tsx, json.')
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
        const result = await discoverWorkspace(input.workspace, input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'search_local_workspace',
    {
      title: 'Search Local Workspace',
      description:
        'Search bounded text/code files inside a local workspace using a literal case-insensitive query. Does not follow symlinks and skips dependency/build directories and blocked secret paths.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Absolute workspace path.'),
        query: z.string().min(1).max(500).describe('Literal text to search for.'),
        extensions: z.array(z.string().min(1)).max(50).optional(),
        maxResults: z.number().int().min(1).max(200).default(50),
        maxFiles: z.number().int().min(1).max(2000).default(500),
        maxDepth: z.number().int().min(1).max(12).default(8)
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
        const result = await searchWorkspace(input.workspace, input.query, input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'delegate_code_task',
    {
      title: 'Delegate Read-only Code Task to Local Model',
      description:
        'Ask the local Ollama coding model for bounded implementation, patch, or analysis text without modifying repository files. Useful for cheap drafting or read-only delegation.',
      inputSchema: z.object({
        task: z.string().min(1).describe('Precise implementation task for the local coding model.'),
        context: z
          .string()
          .optional()
          .describe(
            'Only the relevant code, interfaces, patterns, errors, or repository context needed to execute the task.'
          ),
        constraints: z
          .array(z.string().min(1))
          .max(30)
          .optional()
          .describe('Hard constraints the local model must follow.'),
        language: z
          .string()
          .optional()
          .describe('Language/framework hint, e.g. TypeScript + React + Vitest.'),
        output: z
          .enum(['implementation', 'patch', 'analysis'])
          .default('implementation')
          .describe('Preferred shape of the local model response.')
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
        const prompt = buildTaskPrompt(input);
        const result = await ollama.chat(LOCAL_CODER_SYSTEM_PROMPT, prompt);
        const metadata = {
          executor: 'ollama-local',
          model: result.model,
          doneReason: result.doneReason,
          totalDurationNs: result.totalDurationNs,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens
        };
        await recordTelemetry({
          kind: 'delegation',
          status: 'success',
          model: result.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          generationDurationMs: durationNsToMs(result.totalDurationNs)
        });

        return {
          content: [
            { type: 'text' as const, text: result.content },
            {
              type: 'text' as const,
              text: `\n[local-coder metadata]\n${JSON.stringify(metadata)}`
            }
          ],
          structuredContent: {
            output: result.content,
            ...metadata
          }
        };
      } catch (error) {
        await recordTelemetry({ kind: 'delegation', status: 'error', model: config.model });
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'execute_local_code_task',
    {
      title: 'Execute Code Task Locally',
      description:
        'Compatibility full-result executor. Prefer execute_local_code_task_compact to reduce Claude context usage.',
      inputSchema: z.object({
        workspace: z
          .string()
          .min(1)
          .describe('Absolute path to the repository/workspace on the local machine.'),
        task: z.string().min(1).describe('Precise implementation objective decided by Claude.'),
        editableFiles: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .describe('Workspace-relative files the local model is explicitly allowed to modify.'),
        contextFiles: z
          .array(z.string().min(1))
          .max(40)
          .optional()
          .describe('Additional workspace-relative read-only files to supply as local context.'),
        context: z
          .string()
          .optional()
          .describe('Planner context, invariants, existing decisions, or acceptance criteria.'),
        constraints: z
          .array(z.string().min(1))
          .max(30)
          .optional()
          .describe('Hard implementation constraints.'),
        language: z.string().optional().describe('Language/framework hint.'),
        validation: z
          .array(validationSchema)
          .max(8)
          .optional()
          .describe('Validation commands to run sequentially after local edits.'),
        maxAttempts: z
          .number()
          .int()
          .min(1)
          .max(3)
          .default(2)
          .describe('Maximum local implementation attempts before escalating to Claude.'),
        rollbackOnFailure: z
          .boolean()
          .default(true)
          .describe('Restore all editable files to their invocation snapshot if local execution fails.')
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
        const result = await executeAgenticCodeTask(ollama, config, input);
        const promptTokens = result.generations.reduce((sum, generation) => sum + (generation.promptTokens ?? 0), 0);
        const completionTokens = result.generations.reduce((sum, generation) => sum + (generation.completionTokens ?? 0), 0);
        const generationDurationMs = result.generations.reduce(
          (sum, generation) => sum + durationNsToMs(generation.totalDurationNs),
          0
        );
        const validationDurationMs = result.validation.reduce((sum, validation) => sum + validation.durationMs, 0);
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

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        await recordTelemetry({ kind: 'execution', status: 'error', model: config.model });
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'execute_local_code_plan',
    {
      title: 'Execute Large Feature Plan Locally',
      description:
        'Compatibility full-result large-feature orchestrator. Prefer execute_local_code_plan_compact to reduce Claude context usage.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Absolute repository/workspace path.'),
        goal: z
          .string()
          .min(1)
          .describe('Overall feature goal already understood and planned by Claude.'),
        context: z
          .string()
          .optional()
          .describe('Shared architecture decisions, invariants, acceptance criteria, and planner context.'),
        language: z.string().optional().describe('Default language/framework for plan tasks.'),
        sharedContextFiles: z
          .array(z.string().min(1))
          .max(60)
          .optional()
          .describe('Read-only files useful to multiple subtasks. Keep this minimal.'),
        sharedConstraints: z
          .array(z.string().min(1))
          .max(60)
          .optional()
          .describe('Hard constraints inherited by every subtask.'),
        tasks: z
          .array(
            z.object({
              id: z
                .string()
                .min(1)
                .max(80)
                .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
                .describe('Stable task identifier used by dependencies.'),
              task: z
                .string()
                .min(1)
                .describe('One bounded implementation objective whose solution is already decided.'),
              dependsOn: z
                .array(z.string().min(1).max(80))
                .max(30)
                .optional()
                .describe('Task ids that must complete before this task.'),
              editableFiles: z
                .array(z.string().min(1))
                .min(1)
                .max(12)
                .describe('Exact workspace-relative files this subtask may modify.'),
              contextFiles: z
                .array(z.string().min(1))
                .max(24)
                .optional()
                .describe('Additional workspace-relative read-only context for this subtask.'),
              context: z
                .string()
                .optional()
                .describe('Task-specific acceptance criteria or planner decisions.'),
              constraints: z.array(z.string().min(1)).max(30).optional(),
              language: z.string().optional(),
              validation: z
                .array(validationSchema)
                .max(8)
                .optional()
                .describe('Targeted validation after this subtask.'),
              maxAttempts: z.number().int().min(1).max(3).default(2),
              routing: z
                .object({
                  solutionKnown: z.boolean().default(true),
                  requiresDiscovery: z.boolean().default(false),
                  requiresArchitecture: z.boolean().default(false),
                  validationKnown: z.boolean().optional(),
                  riskTags: z.array(z.string().min(1)).max(20).optional()
                })
                .optional()
                .describe('Optional classifier hints. Architecture/discovery tasks will be rejected from local execution.')
            })
          )
          .min(1)
          .max(30)
          .describe('Claude-decomposed bounded subtasks. Do not pass one giant feature as a single task.'),
        finalValidation: z
          .array(validationSchema)
          .max(12)
          .optional()
          .describe('Integration-level checks after all subtasks succeed.'),
        rollbackPlanOnFailure: z
          .boolean()
          .default(true)
          .describe('Restore every plan-editable file to its pre-plan snapshot if any subtask or final validation fails.')
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
        const lastModel = result.taskResults
          .flatMap((task) => task.execution.generations)
          .at(-1)?.model;
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

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        await recordTelemetry({
          kind: 'orchestration',
          status: 'error',
          model: config.model,
          tasks: input.tasks.length,
          completedTasks: 0
        });
        return errorResult(error);
      }
    }
  );

  registerTokenKillerTools(server, { config, ollama, recordTelemetry });

  server.registerTool(
    'local_coder_telemetry',
    {
      title: 'Local Coder Telemetry',
      description:
        'Return aggregate local routing/execution/orchestration telemetry without storing prompts or source code. Includes success/escalation rates, plan completion, retries, tokens, local generation time, validation time, and local API cost scope.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(3650).default(30).describe('Lookback window in days.')
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
        const result = await telemetry.summary(input.days);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}

void serveStdio(createServer);
console.error(`local-coder-mcp v0.5.0 ready (model: ${config.model})`);
