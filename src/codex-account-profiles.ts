import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexAccountProfile {
  id: string;
  name: string;
  configDir: string;
  organizationLabel?: string;
}

export interface CreateCodexAccountProfileInput {
  id: string;
  name: string;
  organizationLabel?: string;
}

interface PersistedCodexAccountProfile {
  id: string;
  name: string;
  organizationLabel?: string;
}

interface CodexAccountProfilesFile {
  version: 1;
  profiles: PersistedCodexAccountProfile[];
  updatedAt: string;
}

export interface CodexRuntimeDiscovery {
  installed: boolean;
  usable: boolean;
  version?: string;
  error?: string;
}

export interface CodexAccountStatus extends CodexRuntimeDiscovery {
  profileId: string;
  authenticated: boolean;
  authMethod?: 'chatgpt' | 'api-key' | 'agent-identity' | 'unknown';
  detail?: string;
}

export interface CodexCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface CodexMcpPolicy {
  serverId: string;
  toolNames: string[];
}

export interface CodexInvokeOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  model?: string;
  mcpPolicies?: CodexMcpPolicy[];
}

export interface CodexRuntimeOptions {
  codexBinary?: string;
  /** Test-only prefix for invoking a fixture through process.execPath. */
  commandPrefixArgs?: string[];
  baseEnv?: NodeJS.ProcessEnv;
  terminationGraceMs?: number;
  outputLimit?: number;
}

const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_NAME_LENGTH = 160;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_OUTPUT_LIMIT = 512_000;
const SAFE_ENV_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot', 'SYSTEMROOT',
  'WINDIR', 'COMSPEC', 'PATHEXT', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy'
]);
const SENSITIVE_ENV_NAME = /(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|COOKIE|AUTH)/i;
const SENSITIVE_ASSIGNMENT = /\b(?:OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN)\s*=\s*[^\s\r\n]+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi;
const OPENAI_TOKEN = /\bsk-(?:proj-)?[A-Za-z0-9._-]{12,}/gi;

function profileId(value: string): string {
  const trimmed = value.trim();
  if (!SAFE_PROFILE_ID.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error('Codex account profile id must be 1-64 safe filename characters.');
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

export function codexAccountProfilesRoot(): string {
  return process.env.LOCAL_CODER_CODEX_PROFILES_DIR?.trim() ||
    path.join(os.homedir(), '.local-coder-mcp', 'codex-profiles');
}

export class CodexAccountProfileStore {
  private readonly root: string;
  private readonly metadataFile: string;

  constructor(root = codexAccountProfilesRoot()) {
    this.root = path.resolve(root);
    this.metadataFile = path.join(this.root, 'profiles.json');
  }

  create(input: CreateCodexAccountProfileInput): CodexAccountProfile {
    const id = profileId(input.id);
    const state = this.read();
    if (state.profiles.some((profile) => profile.id === id)) {
      throw new Error(`Codex account profile already exists: ${id}`);
    }
    const persisted: PersistedCodexAccountProfile = {
      id,
      name: displayLabel(input.name, 'Codex account profile name'),
      organizationLabel: optionalDisplayLabel(input.organizationLabel, 'Codex organization label')
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

  get(id: string): CodexAccountProfile {
    const safeId = profileId(id);
    const match = this.read().profiles.find((profile) => profile.id === safeId);
    if (!match) throw new Error(`Unknown Codex account profile: ${safeId}`);
    return this.materialize(match);
  }

  list(): CodexAccountProfile[] {
    return this.read().profiles.map((profile) => this.materialize(profile));
  }

  metadataPath(): string {
    return this.metadataFile;
  }

  private configDir(id: string): string {
    const candidate = path.resolve(this.root, profileId(id));
    if (!isInsideRoot(this.root, candidate)) throw new Error('Codex account profile path escaped the profiles root.');
    return candidate;
  }

  private materialize(profile: PersistedCodexAccountProfile): CodexAccountProfile {
    return { ...profile, configDir: this.configDir(profile.id) };
  }

  private read(): CodexAccountProfilesFile {
    if (!fs.existsSync(this.metadataFile)) {
      return { version: 1, profiles: [], updatedAt: new Date(0).toISOString() };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.metadataFile, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Could not read Codex account profiles: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Codex account profiles file must be a JSON object.');
    }
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.profiles)) {
      throw new Error(`Unsupported Codex account profiles version: ${String(value.version)}`);
    }
    const seen = new Set<string>();
    const profiles: PersistedCodexAccountProfile[] = value.profiles.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Codex account profile metadata.');
      const entry = raw as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.name !== 'string') {
        throw new Error('Codex account profile metadata requires string id and name.');
      }
      const id = profileId(entry.id);
      if (seen.has(id)) throw new Error(`Duplicate Codex account profile id: ${id}`);
      seen.add(id);
      return {
        id,
        name: displayLabel(entry.name, 'Codex account profile name'),
        organizationLabel: typeof entry.organizationLabel === 'string'
          ? optionalDisplayLabel(entry.organizationLabel, 'Codex organization label')
          : undefined
      };
    });
    return {
      version: 1,
      profiles,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString()
    };
  }

  private write(state: CodexAccountProfilesFile): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.root, 0o700); } catch { /* best effort */ }
    const temp = `${this.metadataFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, this.metadataFile);
      try { fs.chmodSync(this.metadataFile, 0o600); } catch { /* best effort */ }
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
  return value ? input.split(value).join('[REDACTED]') : input;
}

export function sanitizeCodexOutput(input: string, knownSensitiveValues: string[] = []): string {
  let output = input;
  for (const value of knownSensitiveValues.filter((entry) => entry.length >= 8)) output = redactLiteral(output, value);
  return output
    .replace(SENSITIVE_ASSIGNMENT, (match) => `${match.slice(0, match.indexOf('=') + 1)}[REDACTED]`)
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(OPENAI_TOKEN, '[REDACTED]');
}

function buildSafeBaseEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

function statusMethod(output: string): CodexAccountStatus['authMethod'] | undefined {
  if (/logged in using chatgpt/i.test(output)) return 'chatgpt';
  if (/logged in using an api key/i.test(output)) return 'api-key';
  if (/logged in using agent identity/i.test(output)) return 'agent-identity';
  if (/logged in/i.test(output)) return 'unknown';
  return undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function mcpConfigArgs(policies: CodexMcpPolicy[]): string[] {
  const result: string[] = [];
  for (const policy of policies) {
    const serverId = policy.serverId.trim();
    const tools = [...new Set(policy.toolNames.map((tool) => tool.trim()).filter(Boolean))];
    if (!serverId || tools.length === 0) continue;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(serverId)) throw new Error(`Unsafe Codex MCP server id: ${serverId}`);
    const key = `mcp_servers.${tomlString(serverId)}`;
    result.push('-c', `${key}.enabled_tools=[${tools.map(tomlString).join(',')}]`);
    result.push('-c', `${key}.default_tools_approval_mode="approve"`);
  }
  return result;
}

export class CodexRuntimeNotFoundError extends Error {
  readonly binary: string;
  constructor(binary: string) {
    super(`Codex runtime not found: ${binary}`);
    this.name = 'CodexRuntimeNotFoundError';
    this.binary = binary;
  }
}

function appendBounded(current: string, chunk: Buffer | string, limit: number): string {
  if (current.length >= limit) return current;
  return `${current}${String(chunk)}`.slice(0, limit);
}

export class CodexAccountRuntime {
  private readonly profiles: CodexAccountProfileStore;
  private readonly codexBinary: string;
  private readonly commandPrefixArgs: string[];
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly knownSensitiveValues: string[];
  private readonly terminationGraceMs: number;
  private readonly outputLimit: number;

  constructor(profiles = new CodexAccountProfileStore(), options: CodexRuntimeOptions = {}) {
    this.profiles = profiles;
    this.codexBinary = options.codexBinary?.trim() || 'codex';
    this.commandPrefixArgs = [...(options.commandPrefixArgs ?? [])];
    this.baseEnv = options.baseEnv ?? process.env;
    this.knownSensitiveValues = sensitiveValues(this.baseEnv);
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  }

  async discover(): Promise<CodexRuntimeDiscovery> {
    try {
      const result = await this.run(['--version'], { env: buildSafeBaseEnv(this.baseEnv), timeoutMs: 10_000 });
      const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0]?.trim();
      return {
        installed: true,
        usable: result.exitCode === 0 && !result.timedOut && !result.cancelled,
        version: version || undefined,
        error: result.exitCode === 0 ? undefined : result.stderr || 'Codex returned a non-zero exit code.'
      };
    } catch (error) {
      if (error instanceof CodexRuntimeNotFoundError) return { installed: false, usable: false, error: error.message };
      return { installed: true, usable: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(profileIdValue: string): Promise<CodexAccountStatus> {
    const profile = this.profiles.get(profileIdValue);
    const discovery = await this.discover();
    if (!discovery.installed || !discovery.usable) {
      return { ...discovery, profileId: profile.id, authenticated: false };
    }
    try {
      const result = await this.run(['login', 'status'], { env: this.profileEnv(profile), timeoutMs: 15_000 });
      const detail = (result.stdout || result.stderr).trim();
      const authMethod = statusMethod(detail);
      return {
        ...discovery,
        profileId: profile.id,
        authenticated: result.exitCode === 0 && Boolean(authMethod),
        authMethod,
        detail: detail ? sanitizeCodexOutput(detail, this.knownSensitiveValues).slice(0, 500) : undefined
      };
    } catch (error) {
      if (error instanceof CodexRuntimeNotFoundError) {
        return { installed: false, usable: false, profileId: profile.id, authenticated: false, error: error.message };
      }
      throw error;
    }
  }

  async login(
    profileIdValue: string,
    options: { deviceAuth?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<CodexCommandResult> {
    const profile = this.profiles.get(profileIdValue);
    const args = ['login'];
    if (options.deviceAuth) args.push('--device-auth');
    return await this.run(args, {
      env: this.profileEnv(profile),
      timeoutMs: options.timeoutMs ?? 15 * 60_000,
      signal: options.signal,
      stdio: 'inherit'
    });
  }

  async listMcp(profileIdValue: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CodexCommandResult> {
    const profile = this.profiles.get(profileIdValue);
    return await this.run(['mcp', 'list'], {
      env: this.profileEnv(profile),
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal
    });
  }

  async invoke(profileIdValue: string, prompt: string, options: CodexInvokeOptions = {}): Promise<CodexCommandResult> {
    const profile = this.profiles.get(profileIdValue);
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || /\0/.test(cleanPrompt)) throw new Error('Codex prompt must be non-empty and cannot contain NUL bytes.');
    const args = [
      '-a', 'never',
      ...mcpConfigArgs(options.mcpPolicies ?? []),
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral'
    ];
    if (options.model?.trim() && options.model !== 'default') args.push('--model', options.model.trim());
    args.push(cleanPrompt);
    return await this.run(args, {
      cwd: options.cwd,
      env: this.profileEnv(profile),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal
    });
  }

  private profileEnv(profile: CodexAccountProfile): NodeJS.ProcessEnv {
    return { ...buildSafeBaseEnv(this.baseEnv), CODEX_HOME: profile.configDir };
  }

  private async run(
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; stdio?: 'pipe' | 'inherit' }
  ): Promise<CodexCommandResult> {
    const startedAt = Date.now();
    const stdio = options.stdio ?? 'pipe';
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      shell: false,
      env: options.env,
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    };
    return await new Promise<CodexCommandResult>((resolve, reject) => {
      const child = spawn(this.codexBinary, [...this.commandPrefixArgs, ...args], spawnOptions);
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
          stdout: sanitizeCodexOutput(stdout.trim(), this.knownSensitiveValues),
          stderr: sanitizeCodexOutput(stderr.trim(), this.knownSensitiveValues),
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
      const onAbort = () => { cancelled = true; terminate(); };
      if (stdio === 'pipe') {
        child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk, this.outputLimit); });
        child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk, this.outputLimit); });
      }
      child.once('error', (error) => fail(isMissingExecutableError(error) ? new CodexRuntimeNotFoundError(this.codexBinary) : error));
      child.once('close', finish);
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
      const timeoutTimer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
      timeoutTimer.unref?.();
    });
  }
}

function isMissingExecutableError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}
