import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { loadConfig } from './config.js';
import { executeAgenticCodeTask } from './executor.js';
import { OllamaClient } from './ollama.js';
import { buildTaskPrompt, LOCAL_CODER_SYSTEM_PROMPT } from './prompt.js';

const config = loadConfig();
const ollama = new OllamaClient(config);

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'local-coder-mcp',
    version: '0.2.0'
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
console.error(`local-coder-mcp v0.2.0 ready (model: ${config.model})`);
