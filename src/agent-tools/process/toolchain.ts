import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  AxisTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutput
} from '../../agent-runtime/index.js';
import { resolveWindowsNodeCli } from '../../platform-command.js';
import { PROCESS_EXEC_CAPABILITY, PROCESS_EXEC_PERMISSION } from './exec-tool.js';

export const PROCESS_WHICH_TOOL_NAME = 'process_which';

export interface ExecutableResolution {
  readonly command: string;
  readonly found: boolean;
  readonly executablePath?: string;
  readonly resolution?: 'path' | 'windows-node-cli';
  readonly requiresShell: boolean;
  readonly pathEntryCount: number;
  readonly shell?: string;
  readonly diagnostic: string;
}

function assertCommandName(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('command must be a non-empty executable name.');
  if (trimmed.includes('\0')) throw new Error('command must not contain NUL bytes.');
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('process_which accepts an executable name, not a filesystem path.');
  }
  return trimmed;
}

function windowsExtensions(command: string, env: NodeJS.ProcessEnv): string[] {
  if (path.extname(command)) return [''];
  return (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
}

async function usableFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    await fs.access(candidate, process.platform === 'win32' ? 0 : 1);
    return true;
  } catch {
    return false;
  }
}

function shellRequired(candidate: string): boolean {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidate);
}

/**
 * Resolve the executable using the exact PATH visible to Axis. On packaged macOS
 * this PATH has already been enriched by desktop/user-executable-path.mjs, so
 * diagnostics match the command environment without sourcing arbitrary dotfiles.
 */
export async function resolveProcessExecutable(
  rawCommand: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ExecutableResolution> {
  const command = assertCommandName(rawCommand);
  const pathValue = env.PATH ?? env.Path ?? '';
  const entries = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  if (process.platform === 'win32' && ['npm', 'pnpm', 'yarn'].includes(command.toLowerCase())) {
    const cli = resolveWindowsNodeCli(command.toLowerCase(), { env });
    if (cli) {
      return {
        command,
        found: true,
        executablePath: cli,
        resolution: 'windows-node-cli',
        requiresShell: false,
        pathEntryCount: entries.length,
        shell: env.COMSPEC,
        diagnostic: `${command} resolves to its JavaScript CLI and can run without cmd.exe.`
      };
    }
  }

  const extensions = process.platform === 'win32' ? windowsExtensions(command, env) : [''];
  for (const directory of entries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (!await usableFile(candidate)) continue;
      const needsShell = shellRequired(candidate);
      return {
        command,
        found: true,
        executablePath: candidate,
        resolution: 'path',
        requiresShell: needsShell,
        pathEntryCount: entries.length,
        shell: process.platform === 'win32' ? env.COMSPEC : env.SHELL,
        diagnostic: needsShell
          ? `${command} exists on Axis PATH but is a shell script wrapper; process_exec intentionally refuses implicit shell execution.`
          : `${command} is available on the exact PATH used by Axis process tools.`
      };
    }
  }

  return {
    command,
    found: false,
    requiresShell: false,
    pathEntryCount: entries.length,
    shell: process.platform === 'win32' ? env.COMSPEC : env.SHELL,
    diagnostic:
      `${command} was not found on the PATH visible to Axis. ` +
      (process.platform === 'darwin'
        ? 'Axis enriches Finder/Dock PATH with common Homebrew and user toolchain locations without sourcing shell dotfiles.'
        : 'Compare this process environment with the terminal or service that launches Axis; no shell fallback is performed implicitly.')
  };
}

export interface ProcessWhichToolOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

export class ProcessWhichTool implements AxisTool {
  readonly definition: ToolDefinition = {
    name: PROCESS_WHICH_TOOL_NAME,
    description:
      'Diagnose whether an executable is available on the exact PATH used by Axis process tools, without invoking a shell.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: { command: { type: 'string', minLength: 1 } }
    },
    requiredCapabilities: [PROCESS_EXEC_CAPABILITY],
    requiredPermissions: [PROCESS_EXEC_PERMISSION],
    effect: 'read',
    mutationRisk: 'none',
    retryOnFailure: 'safe',
    timeoutMs: 5_000
  };

  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: ProcessWhichToolOptions = {}) {
    this.environment = options.environment ?? process.env;
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const command = typeof context.call.arguments.command === 'string'
      ? context.call.arguments.command
      : '';
    const resolution = await resolveProcessExecutable(command, this.environment);
    return {
      output: resolution,
      mutationStatus: 'not-applicable',
      retry: 'safe',
      metadata: {
        command: resolution.command,
        found: resolution.found,
        resolution: resolution.resolution,
        pathEntryCount: resolution.pathEntryCount,
        requiresShell: resolution.requiresShell
      }
    };
  }
}
