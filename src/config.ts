import os from 'node:os';
import path from 'node:path';

export type LocalCoderExecutionMode = 'local' | 'remote' | 'auto';
export type WorkerBootstrapMode = 'none' | 'auto';

export interface LocalCoderConfig {
  ollamaBaseUrl: string;
  /** Fast/default local model. Kept as `model` for backwards compatibility. */
  model: string;
  /** Strong fallback model used only after a fast-model attempt fails. */
  strongModel?: string;
  adaptiveModelsEnabled?: boolean;
  ollamaNumCtx?: number;
  fastModelKeepAlive?: string;
  strongModelKeepAlive?: string;
  /** Timeout for short/non-streaming Ollama control requests. */
  requestTimeoutMs: number;
  /** Maximum wait for Ollama to return streaming response headers. */
  inferenceHeaderTimeoutMs?: number;
  /** Generous initial window before the first streaming chunk is observed. */
  inferenceFirstChunkTimeoutMs?: number;
  /** Maximum silence between streaming chunks once inference has started. */
  inferenceIdleTimeoutMs?: number;
  /** Hard per-inference safety cap even when the stream remains active. */
  inferenceMaxDurationMs?: number;
  validationTimeoutMs: number;
  maxFileBytes: number;
  maxContextBytes: number;
  allowedValidationCommands: Set<string>;
  telemetryEnabled: boolean;
  telemetryPath: string;
  runStorePath: string;
  contextIndexPath: string;

  executionMode: LocalCoderExecutionMode;
  remoteWorkerUrl?: string;
  remoteWorkerToken?: string;
  remoteWorkerTimeoutMs: number;
  remoteMaxDeltaBytes: number;

  workerHost: string;
  workerPort: number;
  workerToken?: string;
  workerStatePath: string;
  workerMaxBodyBytes: number;
  workerAllowedGitHosts: Set<string>;
  workerBootstrap: WorkerBootstrapMode;
  /**
   * Heavy jobs accepted from independent Claude sessions. Default 1 deliberately
   * queues them; higher values permit separate worktrees to overlap while Ollama
   * inference remains serialized by the machine-wide inference lock.
   */
  workerMaxConcurrentJobs?: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCommandSet(value: string | undefined): Set<string> {
  const raw = value ?? 'npm,pnpm,yarn,bun';
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function parseStringSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function parseExecutionMode(value: string | undefined): LocalCoderExecutionMode {
  if (!value) return 'local';
  if (value === 'local' || value === 'remote' || value === 'auto') return value;
  throw new Error(`Invalid LOCAL_CODER_EXECUTION_MODE: ${value}`);
}

function parseBootstrapMode(value: string | undefined): WorkerBootstrapMode {
  if (!value) return 'none';
  if (value === 'none' || value === 'auto') return value;
  throw new Error(`Invalid LOCAL_CODER_WORKER_BOOTSTRAP: ${value}`);
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LocalCoderConfig {
  const localCoderHome = path.join(os.homedir(), '.local-coder-mcp');
  const adaptiveModelsEnabled = parseBoolean(env.LOCAL_CODER_ADAPTIVE_MODELS, true);

  // In adaptive mode the legacy LOCAL_CODER_MODEL no longer pins every task to the
  // heavyweight model. Use LOCAL_CODER_FAST_MODEL / LOCAL_CODER_STRONG_MODEL instead.
  const fastModel = adaptiveModelsEnabled
    ? env.LOCAL_CODER_FAST_MODEL ?? 'qwen2.5-coder:7b'
    : env.LOCAL_CODER_MODEL ?? env.LOCAL_CODER_FAST_MODEL ?? 'qwen2.5-coder:14b';

  return {
    ollamaBaseUrl: (env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: fastModel,
    strongModel: env.LOCAL_CODER_STRONG_MODEL ?? 'qwen2.5-coder:14b',
    adaptiveModelsEnabled,
    // Larger context windows increase Ollama memory pressure. 16k is a deliberate
    // workstation-safe default; callers should pass focused context instead of repos.
    ollamaNumCtx: parsePositiveInt(env.LOCAL_CODER_NUM_CTX, 16_384),
    fastModelKeepAlive: env.LOCAL_CODER_FAST_KEEP_ALIVE ?? '90s',
    strongModelKeepAlive: env.LOCAL_CODER_STRONG_KEEP_ALIVE ?? '30s',
    requestTimeoutMs: parsePositiveInt(env.LOCAL_CODER_TIMEOUT_MS, 180_000),
    // Streaming inference uses liveness-aware timeouts instead of a single absolute
    // request timeout. The initial windows are deliberately generous for a cold 27B
    // model on a workstation; once chunks arrive, only prolonged silence is fatal.
    inferenceHeaderTimeoutMs: parsePositiveInt(
      env.LOCAL_CODER_INFERENCE_HEADER_TIMEOUT_MS,
      180_000
    ),
    inferenceFirstChunkTimeoutMs: parsePositiveInt(
      env.LOCAL_CODER_INFERENCE_FIRST_CHUNK_TIMEOUT_MS,
      600_000
    ),
    inferenceIdleTimeoutMs: parsePositiveInt(
      env.LOCAL_CODER_INFERENCE_IDLE_TIMEOUT_MS,
      300_000
    ),
    inferenceMaxDurationMs: parsePositiveInt(
      env.LOCAL_CODER_INFERENCE_MAX_DURATION_MS,
      1_800_000
    ),
    validationTimeoutMs: parsePositiveInt(env.LOCAL_CODER_VALIDATION_TIMEOUT_MS, 180_000),
    maxFileBytes: parsePositiveInt(env.LOCAL_CODER_MAX_FILE_BYTES, 120_000),
    maxContextBytes: parsePositiveInt(env.LOCAL_CODER_MAX_CONTEXT_BYTES, 96_000),
    allowedValidationCommands: parseCommandSet(env.LOCAL_CODER_ALLOWED_COMMANDS),
    telemetryEnabled: parseBoolean(env.LOCAL_CODER_TELEMETRY_ENABLED, true),
    telemetryPath: env.LOCAL_CODER_TELEMETRY_PATH ?? path.join(localCoderHome, 'telemetry.jsonl'),
    runStorePath: env.LOCAL_CODER_RUN_STORE_PATH ?? path.join(localCoderHome, 'runs'),
    contextIndexPath: env.LOCAL_CODER_CONTEXT_INDEX_PATH ?? path.join(localCoderHome, 'indexes'),

    executionMode: parseExecutionMode(env.LOCAL_CODER_EXECUTION_MODE),
    remoteWorkerUrl: trimTrailingSlash(env.LOCAL_CODER_REMOTE_WORKER_URL),
    remoteWorkerToken: env.LOCAL_CODER_REMOTE_WORKER_TOKEN?.trim() || undefined,
    remoteWorkerTimeoutMs: parsePositiveInt(env.LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS, 1_800_000),
    remoteMaxDeltaBytes: parsePositiveInt(env.LOCAL_CODER_REMOTE_MAX_DELTA_BYTES, 8_000_000),

    workerHost: env.LOCAL_CODER_WORKER_HOST?.trim() || '127.0.0.1',
    workerPort: parsePositiveInt(env.LOCAL_CODER_WORKER_PORT, 7337),
    workerToken: env.LOCAL_CODER_WORKER_TOKEN?.trim() || undefined,
    workerStatePath:
      env.LOCAL_CODER_WORKER_STATE_PATH ?? path.join(localCoderHome, 'worker'),
    workerMaxBodyBytes: parsePositiveInt(env.LOCAL_CODER_WORKER_MAX_BODY_BYTES, 12_000_000),
    workerAllowedGitHosts: parseStringSet(env.LOCAL_CODER_WORKER_ALLOWED_GIT_HOSTS),
    workerBootstrap: parseBootstrapMode(env.LOCAL_CODER_WORKER_BOOTSTRAP),
    workerMaxConcurrentJobs: Math.min(
      8,
      parsePositiveInt(env.LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS, 1)
    )
  };
}
