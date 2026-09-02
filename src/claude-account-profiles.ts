import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateMcpName, validateRemoteMcpInput } from './mcp-connectors.js';

export interface ClaudeAccountProfile {
  id: string;
  name: string;
  configDir: string;
  organizationLabel?: string;
}

export interface CreateClaudeAccountProfileInput {
  id: string;
  name: string;
  organizationLabel?: string;
}

interface PersistedClaudeAccountProfile {
  id: string;
  name: string;
  organizationLabel?: string;
}

interface ClaudeAccountProfilesFile {
  version: 1;
  profiles: PersistedClaudeAccountProfile[];
  updatedAt: string;
}

export interface ClaudeRuntimeDiscovery {
  installed: boolean;
  usable: boolean;
  version?: string;
  error?: string;
}

export interface ClaudeAccountStatus extends ClaudeRuntimeDiscovery {
  profileId: string;
  authenticated: boolean;
  email?: string;
  authMethod?: string;
  organization?: string;
  subscriptionType?: string;
}

export interface ClaudeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ClaudeInvokeOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowedTools?: string[];
  /** Official Claude Code print-mode structured output. */
  jsonSchema?: Record<string, unknown>;
}

export interface ClaudeRuntimeOptions {
  claudeBinary?: string;
  /** Test-only prefix for invoking a fixture through process.execPath. */
  commandPrefixArgs?: string[];
  baseEnv?: NodeJS.ProcessEnv;
  terminationGraceMs?: number;
  outputLimit?: number;
}

const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_NAME_LENGTH = 160;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_OUTPUT_LIMIT = 256_000;
const SAFE_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'HOME',
  'USER',
  'LOGNAME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy'
]);
const SENSITIVE_ENV_NAME = /(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|COOKIE|AUTH)/i;
const SENSITIVE_ASSIGNMENT = /\b(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN_FILE)\s*=\s*[^\s\r\n]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi;
const ANTHROPIC_TOKEN = /\bsk-ant-[A-Za-z0-9._-]{8,}/gi;

function profileId(value: string): string {
  const trimmed = value.trim();
  if (!SAFE_PROFILE_ID.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error('Claude account profile id must be 1-64 safe filename characters.');
  }
  return trimmed;
}

function displayLabel(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH || /[\0\r\n]/.test(trimmed)) {
    throw new Error(`${field} must be 1-${MAX_NAME_LENGTH} characters without line breaks.`);
  }
  return trimmed;
}

function optionalDisplayLabel(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return displayLabel(value, field);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function claudeAccountProfilesRoot(): string {
  return process.env.LOCAL_CODER_CLAUDE_PROFILES_DIR?.trim() ||
    path.join(os.homedir(), '.local-coder-mcp', 'claude-profiles');
}

export class ClaudeAccountProfileStore {
  private readonly root: string;
  private readonly metadataFile: string;

  constructor(root = claudeAccountProfilesRoot()) {
    this.root = path.resolve(root);
    this.metadataFile = path.join(this.root, 'profiles.json');
  }

  create(input: CreateClaudeAccountProfileInput): ClaudeAccountProfile {
    const id = profileId(input.id);
    const state = this.read();
    if (state.profiles.some((profile) => profile.id === id)) {
      throw new Error(`Claude account profile already exists: ${id}`);
    }

    const persisted: PersistedClaudeAccountProfile = {
      id,
      name: displayLabel(input.name, 'Claude account profile name'),
      organizationLabel: optionalDisplayLabel(input.organizationLabel, 'Claude organization label')
    };
    const configDir = this.configDir(id);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(configDir, 0o700); } catch { /* best effort on non-POSIX */ }

    state.profiles.push(persisted);
    state.profiles.sort((left, right) => left.id.localeCompare(right.id));
    state.updatedAt = new Date().toISOString();
    this.write(state);
    return this.materialize(persisted);
  }

  get(id: string): ClaudeAccountProfile {
    const safeId = profileId(id);
    const match = this.read().profiles.find((profile) => profile.id === safeId);
    if (!match) throw new Error(`Unknown Claude account profile: ${safeId}`);
    return this.materialize(match);
  }

  list(): ClaudeAccountProfile[] {
    return this.read().profiles.map((profile) => this.materialize(profile));
  }

  metadataPath(): string {
    return this.metadataFile;
  }

  private configDir(id: string): string {
    const candidate = path.resolve(this.root, profileId(id));
    if (!isInsideRoot(this.root, candidate)) {
      throw new Error('Claude account profile path escaped the profiles root.');
    }
    return candidate;
  }

  private materialize(profile: PersistedClaudeAccountProfile): ClaudeAccountProfile {
    return {
      id: profile.id,
      name: profile.name,
      configDir: this.configDir(profile.id),
      organizationLabel: profile.organizationLabel
    };
  }

  private read(): ClaudeAccountProfilesFile {
    if (!fs.existsSync(this.metadataFile)) {
      return { version: 1, profiles: [], updatedAt: new Date(0).toISOString() };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.metadataFile, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Could not read Claude account profiles: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Claude account profiles file must be a JSON object.');
    }
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.profiles)) {
      throw new Error(`Unsupported Claude account profiles version: ${String(value.version)}`);
    }

    const profiles: PersistedClaudeAccountProfile[] = [];
    const seen = new Set<string>();
    for (const raw of value.profiles) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid Claude account profile metadata.');
      }
      const entry = raw as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.name !== 'string') {
        throw new Error('Claude account profile metadata requires string id and name.');
      }
      const id = profileId(entry.id);
      if (seen.has(id)) throw new Error(`Duplicate Claude account profile id: ${id}`);
      seen.add(id);
      profiles.push({
        id,
        name: displayLabel(entry.name, 'Claude account profile name'),
        organizationLabel: typeof entry.organizationLabel === 'string'
          ? optionalDisplayLabel(entry.organizationLabel, 'Claude organization label')
          : undefined
      });
    }

    return {
      version: 1,
      profiles,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString()
    };
  }

  private write(state: ClaudeAccountProfilesFile): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.root, 0o700); } catch { /* best effort on non-POSIX */ }
    const temp = `${this.metadataFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, this.metadataFile);
      try { fs.chmodSync(this.metadataFile, 0o600); } catch { /* best effort on non-POSIX */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }
}

function sensitiveValues(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SENSITIVE_ENV_NAME.test(name)) continue;
    values.push(value);
  }
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function redactLiteral(input: string, value: string): string {
  if (!value) return input;
  return input.split(value).join('[REDACTED]');
}

export function sanitizeClaudeOutput(input: string, knownSensitiveValues: string[] = []): string {
  let output = input;
  for (const value of knownSensitiveValues.filter((entry) => entry.length >= 8)) {
    output = redactLiteral(output, value);
  }
  return output
    .replace(SENSITIVE_ASSIGNMENT, (match) => `${match.slice(0, match.indexOf('=') + 1)}[REDACTED]`)
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(ANTHROPIC_TOKEN, '[REDACTED]');
}

function buildSafeBaseEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function statusSummary(raw: string): Pick<ClaudeAccountStatus, 'email' | 'authMethod' | 'organization' | 'subscriptionType'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const value = parsed as Record<string, unknown>;
  const stringField = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
    return undefined;
  };
  return {
    email: stringField('email', 'accountEmail'),
    authMethod: stringField('authMethod', 'method', 'provider'),
    organization: stringField('organization', 'organizationName', 'orgName'),
    subscriptionType: stringField('subscriptionType', 'subscription', 'plan')
  };
}

export class ClaudeRuntimeNotFoundError extends Error {
  readonly binary: string;

  constructor(binary: string) {
    super(`Claude Code runtime not found: ${binary}`);
    this.name = 'ClaudeRuntimeNotFoundError';
    this.binary = binary;
  }
}

function appendBounded(current: string, chunk: Buffer | string, limit: number): string {
  if (current.length >= limit) return current;
  return `${current}${String(chunk)}`.slice(0, limit);
}

export class ClaudeAccountRuntime {
  private readonly profiles: ClaudeAccountProfileStore;
  private readonly claudeBinary: string;
  private readonly commandPrefixArgs: string[];
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly knownSensitiveValues: string[];
  private readonly terminationGraceMs: number;
  private readonly outputLimit: number;

  constructor(
    profiles = new ClaudeAccountProfileStore(),
    options: ClaudeRuntimeOptions = {}
  ) {
    this.profiles = profiles;
    this.claudeBinary = options.claudeBinary?.trim() || 'claude';
    this.commandPrefixArgs = [...(options.commandPrefixArgs ?? [])];
    this.baseEnv = options.baseEnv ?? process.env;
    this.knownSensitiveValues = sensitiveValues(this.baseEnv);
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  }

  async discover(): Promise<ClaudeRuntimeDiscovery> {
    try {
      const result = await this.run(['--version'], {
        env: buildSafeBaseEnv(this.baseEnv),
        timeoutMs: 10_000
      });
      const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0]?.trim();
      return {
        installed: true,
        usable: result.exitCode === 0 && !result.timedOut && !result.cancelled,
        version: version || undefined,
        error: result.exitCode === 0 ? undefined : (result.stderr || 'Claude runtime returned a non-zero exit code.')
      };
    } catch (error) {
      if (error instanceof ClaudeRuntimeNotFoundError) {
        return { installed: false, usable: false, error: error.message };
      }
      return { installed: true, usable: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(profileId: string): Promise<ClaudeAccountStatus> {
    const profile = this.profiles.get(profileId);
    const discovery = await this.discover();
    if (!discovery.installed || !discovery.usable) {
      return { ...discovery, profileId: profile.id, authenticated: false };
    }

    try {
      const result = await this.run(['auth', 'status'], {
        env: this.profileEnv(profile),
        timeoutMs: 15_000
      });
      return {
        ...discovery,
        ...statusSummary(result.stdout),
        profileId: profile.id,
        authenticated: result.exitCode === 0 && !result.timedOut && !result.cancelled
      };
    } catch (error) {
      if (error instanceof ClaudeRuntimeNotFoundError) {
        return {
          installed: false,
          usable: false,
          profileId: profile.id,
          authenticated: false,
          error: error.message
        };
      }
      throw error;
    }
  }

  async login(
    profileId: string,
    options: { sso?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<ClaudeCommandResult> {
    const profile = this.profiles.get(profileId);
    const args = ['auth', 'login'];
    if (options.sso) args.push('--sso');
    return await this.run(args, {
      env: this.profileEnv(profile),
      timeoutMs: options.timeoutMs ?? 15 * 60_000,
      signal: options.signal,
      stdio: 'inherit'
    });
  }

  async openInteractive(
    profileId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<ClaudeCommandResult> {
    const profile = this.profiles.get(profileId);
    return await this.run([], {
      env: this.profileEnv(profile),
      timeoutMs: options.timeoutMs ?? 24 * 60 * 60_000,
      signal: options.signal,
      stdio: 'inherit'
    });
  }

  async invoke(profileId: string, prompt: string, options: ClaudeInvokeOptions = {}): Promise<ClaudeCommandResult> {
    const profile = this.profiles.get(profileId);
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || /\0/.test(cleanPrompt)) {
      throw new Error('Claude prompt must be non-empty and cannot contain NUL bytes.');
    }
    const args = [
      '-p',
      cleanPrompt,
      '--output-format',
      'text',
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk'
    ];
    if (options.jsonSchema) {
      const serialized = JSON.stringify(options.jsonSchema);
      if (serialized.length > 256_000) throw new Error('Claude JSON schema is too large.');
      args.push('--json-schema', serialized);
    }
    const allowedTools = [...new Set((options.allowedTools ?? []).map((tool) => tool.trim()).filter(Boolean))];
    if (allowedTools.length > 0) args.push('--allowedTools', ...allowedTools);

    return await this.run(args, {
      cwd: options.cwd,
      env: this.profileEnv(profile),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal
    });
  }

  async listMcp(profileId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ClaudeCommandResult> {
    const profile = this.profiles.get(profileId);
    return await this.run(['mcp', 'list'], {
      env: this.profileEnv(profile),
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal
    });
  }

  async addRemoteMcp(
    profileId: string,
    input: { name: string; url: string },
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<ClaudeCommandResult> {
    const profile = this.profiles.get(profileId);
    const connector = validateRemoteMcpInput(input.name, input.url);
    return await this.run(['mcp', 'add', '--transport', 'http', '--scope', 'user', connector.name, connector.url], {
      env: this.profileEnv(profile),
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal
    });
  }

  async removeMcp(
    profileId: string,
    nameValue: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<ClaudeCommandResult> {
    const profile = this.profiles.get(profileId);
    const name = validateMcpName(nameValue);
    return await this.run(['mcp', 'remove', '--scope', 'user', name], {
      env: this.profileEnv(profile),
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal
    });
  }

  async loginMcp(
    profileId: string,
    nameValue: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<ClaudeCommandResult> {
    const profile = this.profiles.get(profileId);
    const name = validateMcpName(nameValue);
    return await this.run(['mcp', 'login', name], {
      env: this.profileEnv(profile),
      timeoutMs: options.timeoutMs ?? 15 * 60_000,
      signal: options.signal,
      stdio: 'inherit'
    });
  }

  private profileEnv(profile: ClaudeAccountProfile): NodeJS.ProcessEnv {
    return {
      ...buildSafeBaseEnv(this.baseEnv),
      CLAUDE_CONFIG_DIR: profile.configDir
    };
  }

  private async run(
    args: string[],
    options: {
      cwd?: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
      signal?: AbortSignal;
      stdio?: 'pipe' | 'inherit';
    }
  ): Promise<ClaudeCommandResult> {
    const startedAt = Date.now();
    const stdio = options.stdio ?? 'pipe';
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      shell: false,
      env: options.env,
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    };

    return await new Promise<ClaudeCommandResult>((resolve, reject) => {
      const child = spawn(this.claudeBinary, [...this.commandPrefixArgs, ...args], spawnOptions);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          stdout: sanitizeClaudeOutput(stdout.trim(), this.knownSensitiveValues),
          stderr: sanitizeClaudeOutput(stderr.trim(), this.knownSensitiveValues),
          exitCode,
          signal,
          durationMs: Date.now() - startedAt,
          timedOut,
          cancelled
        });
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const terminate = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, this.terminationGraceMs);
        forceKillTimer.unref?.();
      };
      const onAbort = () => {
        cancelled = true;
        terminate();
      };

      if (stdio === 'pipe') {
        child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk, this.outputLimit); });
        child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk, this.outputLimit); });
      }
      child.once('error', (error) => {
        fail(isMissingExecutableError(error) ? new ClaudeRuntimeNotFoundError(this.claudeBinary) : error);
      });
      child.once('close', finish);

      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
      timeoutTimer.unref?.();
    });
  }
}

function isMissingExecutableError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
