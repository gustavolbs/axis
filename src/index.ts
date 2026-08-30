import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { classifyTask } from './classifier.js';
import { loadConfig } from './config.js';
import { discoverWorkspace, searchWorkspace } from './discovery.js';
import { createExecutionRuntime } from './execution-runtime.js';
import { registerLocalEngineerTools } from './local-engineer-tools.js';
import { OllamaClient } from './ollama.js';
import { buildTaskPrompt, LOCAL_CODER_SYSTEM_PROMPT } from './prompt.js';
import { TelemetryStore, type TelemetryEvent } from './telemetry.js';
import { registerTokenKillerTools } from './token-killer-tools.js';

const config = loadConfig();
const ollama = new OllamaClient(config);
const runtime = createExecutionRuntime(config, ollama);
const telemetry = new TelemetryStore(config.telemetryPath, config.telemetryEnabled);

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
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
  command: z.string().min(1).describe('Executable name from the configured validation allowlist.'),
  args: z.array(z.string()).max(40).optional().describe('Arguments passed without a shell.')
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
      'Set true only after Claude has resolved auth/credential/permission/security behavior and only bounded implementation remains.'
    )
});

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'local-coder-mcp', version: '0.10.0' },
    {
      instructions:
        'Claude is the user interface, but local-coder should own as much normal engineering work as possible. For an open-ended repository goal prefer local_engineer: it retrieves persistent evidence-backed repo intelligence, verifies current source, performs high-effort local investigation/planning, coding, deterministic validation, adversarial review, bounded repair, and learns reusable source-backed facts after successful work. Current source/tests always override remembered repo facts. If local_engineer returns needs-claude/escalated, Claude should resolve only the exact escalation questions or external research requests, then call local_engineer again with claudeGuidance. Keep existing bounded compact executors for already-known changes. In strict remote mode never silently move heavy work back to the Mac.'
    }
  );

  server.registerTool(
    'local_coder_health',
    {
      title: 'Local Coder Health',
      description:
        'Check configured execution mode and either local Ollama health or authenticated remote-worker health, including the worker queue when available.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async () => {
      try {
        const health = await runtime.health();
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
        'Classify an already-scoped implementation as deterministic, local, local-supervised, or Claude. For broad/open-ended repository goals prefer local_engineer instead of forcing Claude to decompose first.',
      inputSchema: z.object({
        task: z.string().min(1),
        solutionKnown: z.boolean().optional(),
        requiresDiscovery: z.boolean().default(false),
        requiresArchitecture: z.boolean().default(false),
        estimatedFiles: z.number().int().min(0).max(1000).optional(),
        validationKnown: z.boolean().optional(),
        riskTags: z.array(z.string().min(1)).max(20).optional(),
        sensitiveDecisionResolved: z
          .boolean()
          .optional()
          .describe('True only after Claude has resolved the sensitive behavior/contract.')
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
        'List a bounded safe view of the Mac/control-plane workspace and root package scripts without following symlinks.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        maxDepth: z.number().int().min(1).max(12).default(4),
        maxEntries: z.number().int().min(1).max(5000).default(400),
        extensions: z.array(z.string().min(1)).max(50).optional()
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
      description: 'Literal bounded text/code search inside the control-plane workspace.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        query: z.string().min(1).max(500),
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
      title: 'Delegate Read-only Code Task',
      description:
        'Ask the configured execution model for bounded code/analysis text without modifying repository files. In remote mode the generation runs on the Windows worker.',
      inputSchema: z.object({
        task: z.string().min(1),
        context: z.string().optional(),
        constraints: z.array(z.string().min(1)).max(30).optional(),
        language: z.string().optional(),
        output: z.enum(['implementation', 'patch', 'analysis']).default('implementation')
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
        const result = await runtime.chat.chat(LOCAL_CODER_SYSTEM_PROMPT, prompt);
        const metadata = {
          executor: runtime.mode === 'remote' ? 'remote-worker' : 'ollama',
          executionMode: runtime.mode,
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
            { type: 'text' as const, text: `\n[local-coder metadata]\n${JSON.stringify(metadata)}` }
          ],
          structuredContent: { output: result.content, ...metadata }
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
      title: 'Execute Code Task',
      description:
        'Compatibility full-result executor using the configured local/remote backend. Prefer execute_local_code_task_compact for routing preflight and supervised-sensitive review enforcement.',
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
        rollbackOnFailure: z.boolean().default(true)
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
        const result = await runtime.execution.executeTask(input);
        const promptTokens = result.generations.reduce(
          (sum, generation) => sum + (generation.promptTokens ?? 0),
          0
        );
        const completionTokens = result.generations.reduce(
          (sum, generation) => sum + (generation.completionTokens ?? 0),
          0
        );
        const generationDurationMs = result.generations.reduce(
          (sum, generation) => sum + durationNsToMs(generation.totalDurationNs),
          0
        );
        const validationDurationMs = result.validation.reduce(
          (sum, validation) => sum + validation.durationMs,
          0
        );
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
      title: 'Execute Large Feature Plan',
      description:
        'Compatibility full-result orchestrator using the configured local/remote backend. Prefer the compact orchestrator when Claude already owns a detailed plan; prefer local_engineer for an open-ended goal.',
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
        const result = await runtime.execution.executePlan(input);
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

  registerTokenKillerTools(server, {
    config,
    execution: runtime.execution,
    recordTelemetry
  });

  registerLocalEngineerTools(server, {
    config,
    execution: runtime.execution
  });

  server.registerTool(
    'local_coder_telemetry',
    {
      title: 'Local Coder Telemetry',
      description:
        'Aggregate privacy-preserving routing/execution/orchestration telemetry. In remote mode the Mac summary records returned execution metadata; worker-local inference telemetry remains on the worker.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(3650).default(30)
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
console.error(
  `local-coder-mcp v0.10.0 ready (mode: ${runtime.mode}, model: ${config.model}, worker: ${config.remoteWorkerUrl ?? 'none'})`
);
