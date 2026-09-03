import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentProviderProtocolError,
  OperationCancelledError,
  type AgentProviderAdapter,
  type AgentProviderAdapterCapabilities,
  type AgentProviderControl,
  type AgentProviderRequest,
  type AgentProviderResponse
} from '../agent-runtime/index.js';
import { ClaudeAccountProfileStore } from '../claude-account-profiles.js';
import { ProviderError } from '../providers/types.js';
import {
  assertExpectedProviderFamily,
  assertProviderBinding,
  normalizeProviderBinding,
  type AgentProviderBinding
} from './common.js';
import {
  AXIS_AGENT_TURN_SCHEMA,
  buildStructuredAgentPrompt,
  parseStructuredAgentResponse
} from './structured-protocol.js';

export interface ClaudeAccountAgentAdapterOptions {
  readonly profiles: ClaudeAccountProfileStore;
  readonly profileId: string;
  readonly binding: AgentProviderBinding;
  readonly claudeBinary?: string;
  /** Test-only prefix used to execute a fixture through process.execPath. */
  readonly commandPrefixArgs?: readonly string[];
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly outputLimit?: number;
}

interface ClaudeAgentCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  timedOut: boolean;
}

const SAFE_ENV_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TERM', 'COLORTERM', 'NO_COLOR',
  'FORCE_COLOR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY',
  'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'
]);
const DEFAULT_OUTPUT_LIMIT = 512_000;
const SENSITIVE_ASSIGNMENT = /\b(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN_FILE)\s*=\s*[^\s\r\n]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi;
const ANTHROPIC_TOKEN = /\bsk-ant-[A-Za-z0-9._-]{8,}/gi;

function safeEnvironment(source: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: configDir };
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function redact(input: string): string {
  return input
    .replace(SENSITIVE_ASSIGNMENT, (match) => `${match.slice(0, match.indexOf('=') + 1)}[REDACTED]`)
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(ANTHROPIC_TOKEN, '[REDACTED]');
}

function appendBounded(current: string, chunk: Buffer | string, limit: number): string {
  if (current.length >= limit) return current;
  return `${current}${String(chunk)}`.slice(0, limit);
}

function servedModel(stdout: string): { content: string; model?: string; responseId?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return { content: stdout };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { content: stdout };
  const envelope = parsed as Record<string, unknown>;
  if (envelope.type !== 'result') return { content: stdout };

  let model: string | undefined;
  let highestCost = Number.NEGATIVE_INFINITY;
  const usage = envelope.modelUsage;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    for (const [key, raw] of Object.entries(usage as Record<string, unknown>)) {
      const details = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      const candidate = typeof details.canonicalModel === 'string' && details.canonicalModel.trim()
        ? details.canonicalModel.trim()
        : key;
      const cost = typeof details.costUSD === 'number' ? details.costUSD : 0;
      if (cost > highestCost) {
        model = candidate;
        highestCost = cost;
      }
    }
  }

  const structured = envelope.structured_output ?? envelope.structuredOutput;
  const content = structured !== undefined
    ? JSON.stringify(structured)
    : typeof envelope.result === 'string'
      ? envelope.result
      : stdout;
  const responseId = typeof envelope.session_id === 'string'
    ? envelope.session_id
    : typeof envelope.id === 'string'
      ? envelope.id
      : undefined;
  return { content, model, responseId };
}

function modelMatchesSelection(selected: string, served: string): boolean {
  const requested = selected.trim().toLowerCase();
  const actual = served.trim().toLowerCase();
  if (requested === actual) return true;
  if (['opus', 'sonnet', 'haiku', 'fable'].includes(requested)) {
    return actual.includes(`-${requested}-`) || actual.endsWith(`-${requested}`);
  }
  return false;
}

/**
 * Claude Account adapter that executes Claude Code strictly as a model
 * transport. `--bare` removes project/user extensions and MCP loading,
 * `--tools ''` removes built-in tools, and `--disallowedTools mcp__*` is a
 * defense-in-depth MCP deny rule. Axis remains the only tool host.
 */
export class ClaudeAccountAgentAdapter implements AgentProviderAdapter {
  readonly connectionId: string;
  readonly providerFamily: string;
  readonly modelId: string;
  readonly capabilities: AgentProviderAdapterCapabilities = Object.freeze({
    streaming: false,
    toolProtocol: 'structured-fallback'
  });

  private readonly profiles: ClaudeAccountProfileStore;
  private readonly profileId: string;
  private readonly binding: AgentProviderBinding;
  private readonly claudeBinary: string;
  private readonly commandPrefixArgs: readonly string[];
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly outputLimit: number;

  constructor(options: ClaudeAccountAgentAdapterOptions) {
    assertExpectedProviderFamily(options.binding, 'anthropic');
    this.binding = normalizeProviderBinding(options.binding);
    this.connectionId = this.binding.connectionId;
    this.providerFamily = this.binding.providerFamily;
    this.modelId = this.binding.modelId;
    this.profiles = options.profiles;
    this.profileId = options.profileId.trim();
    if (!this.profileId) throw new AgentProviderProtocolError('Claude account profile id must not be empty.');
    this.claudeBinary = options.claudeBinary?.trim() || 'claude';
    this.commandPrefixArgs = [...(options.commandPrefixArgs ?? [])];
    this.baseEnv = options.baseEnv ?? process.env;
    this.outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  }

  async invoke(
    request: AgentProviderRequest,
    control: AgentProviderControl
  ): Promise<AgentProviderResponse> {
    assertProviderBinding(this.binding, request);
    if (control.signal.aborted) throw new OperationCancelledError();
    const profile = this.profiles.get(this.profileId);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-claude-agent-'));
    control.reportProgress({
      phase: 'provider',
      state: 'waiting-response',
      metadata: { connectionId: this.connectionId, modelId: this.modelId }
    });

    try {
      const prompt = buildStructuredAgentPrompt(request);
      const args = [
        ...this.commandPrefixArgs,
        '--bare',
        '--tools', '',
        '--disallowedTools', 'mcp__*',
        '-p', prompt,
        '--output-format', 'json',
        '--no-session-persistence',
        '--permission-mode', 'dontAsk',
        '--model', this.modelId,
        '--json-schema', JSON.stringify(AXIS_AGENT_TURN_SCHEMA)
      ];
      const result = await this.run(args, cwd, profile.configDir, request.timeoutMs, control.signal);
      if (result.cancelled) throw new OperationCancelledError('Claude account invocation was cancelled.');
      if (result.timedOut) {
        throw new ProviderError(this.connectionId, `Claude account invocation timed out after ${request.timeoutMs} ms.`, {
          code: 'claude_account_timeout',
          retryable: true
        });
      }
      if (result.exitCode !== 0) {
        throw new ProviderError(
          this.connectionId,
          result.stderr.trim() || result.stdout.trim() || 'Claude account invocation failed.',
          { code: 'claude_account_error', retryable: false }
        );
      }

      const envelope = servedModel(result.stdout);
      if (!envelope.model) {
        throw new AgentProviderProtocolError(
          `Claude Account did not report the served model for exact selection ${this.modelId}.`
        );
      }
      if (!modelMatchesSelection(this.modelId, envelope.model)) {
        throw new AgentProviderProtocolError(
          `Claude Account served model ${envelope.model}, not exact selected model ${this.modelId}. Axis will not accept provider fallback.`
        );
      }
      control.reportProgress({
        phase: 'provider',
        state: 'generating',
        completed: envelope.content.length,
        metadata: { connectionId: this.connectionId, model: envelope.model }
      });
      return parseStructuredAgentResponse(request, envelope.content, {
        responseId: envelope.responseId,
        providerStopReason: 'complete'
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  private async run(
    args: readonly string[],
    cwd: string,
    configDir: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<ClaudeAgentCommandResult> {
    return await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let cancelled = false;
      let timedOut = false;
      let settled = false;
      const child = spawn(this.claudeBinary, args, {
        cwd,
        env: safeEnvironment(this.baseEnv, configDir),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
      const finish = (exitCode: number | null, childSignal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve({
          stdout: redact(stdout),
          stderr: redact(stderr),
          exitCode,
          signal: childSignal,
          cancelled,
          timedOut
        });
      };
      const terminate = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
      };
      const onAbort = (): void => {
        cancelled = true;
        terminate();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, Math.max(1, timeoutMs));

      child.stdout?.on('data', (chunk) => {
        stdout = appendBounded(stdout, chunk, this.outputLimit);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = appendBounded(stderr, chunk, this.outputLimit);
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.once('close', finish);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}
