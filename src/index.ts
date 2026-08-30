import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { loadConfig } from './config.js';
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
    version: '0.1.0'
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
      title: 'Delegate Code Task to Local Model',
      description:
        'Delegate a bounded, well-specified coding task to the local Ollama model. This v0.1 tool is read-only: it returns implementation/code/patch text but does not edit repository files or run commands. Use it for straightforward implementation after the main Claude agent has already decided the approach.',
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

  return server;
}

void serveStdio(createServer);
console.error(`local-coder-mcp v0.1.0 ready (model: ${config.model})`);
