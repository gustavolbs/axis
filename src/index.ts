import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { classifyTask } from './classifier.js';
import { loadConfig } from './config.js';
import { discoverWorkspace, searchWorkspace } from './discovery.js';
import { executeAgenticCodeTask } from './executor.js';
import { OllamaClient } from './ollama.js';
import { buildTaskPrompt, LOCAL_CODER_SYSTEM_PROMPT } from './prompt.js';
import { TelemetryStore, type TelemetryEvent } from './telemetry.js';

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

function createServer(): McpServer {
  const server = new McpServer({
    name: 'local-coder-mcp',
    version: '0.3.0'
  });

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
        'Delegate an already-reasoned coding task to the local model. The MCP reads only explicitly listed repository files, lets the model modify only explicitly listed editable files, runs caller-supplied allowlisted validation commands, retries locally, and returns the exact invocation diff for Claude review. Failed tasks escalate and roll back by default.',
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
          .array(
            z.object({
              command: z
                .string()
                .min(1)
                .describe('Executable name from the configured validation allowlist.'),
              args: z.array(z.string()).max(40).optional().describe('Arguments passed without a shell.')
            })
          )
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
    'local_coder_telemetry',
    {
      title: 'Local Coder Telemetry',
      description:
        'Return aggregate local routing/execution telemetry without storing prompts or source code. Includes success/escalation rates, retries, tokens, local generation time, validation time, and local API cost scope.',
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
console.error(`local-coder-mcp v0.3.0 ready (model: ${config.model})`);
