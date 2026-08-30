import os from 'node:os';
import path from 'node:path';

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
  requestTimeoutMs: number;
  validationTimeoutMs: number;
  maxFileBytes: number;
  maxContextBytes: number;
  allowedValidationCommands: Set<string>;
  telemetryEnabled: boolean;
  telemetryPath: string;
  runStorePath: string;
  contextIndexPath: string;
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
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
    // workstation-safe ceiling; callers should pass focused context instead of repos.
    ollamaNumCtx: parsePositiveInt(env.LOCAL_CODER_NUM_CTX, 16_384),
    fastModelKeepAlive: env.LOCAL_CODER_FAST_KEEP_ALIVE ?? '90s',
    strongModelKeepAlive: env.LOCAL_CODER_STRONG_KEEP_ALIVE ?? '30s',
    requestTimeoutMs: parsePositiveInt(env.LOCAL_CODER_TIMEOUT_MS, 180_000),
    validationTimeoutMs: parsePositiveInt(env.LOCAL_CODER_VALIDATION_TIMEOUT_MS, 180_000),
    maxFileBytes: parsePositiveInt(env.LOCAL_CODER_MAX_FILE_BYTES, 120_000),
    // v0.6 allowed 600 KB. Adaptive execution intentionally fails early instead of
    // letting oversized local prompts create memory pressure/swap on developer laptops.
    maxContextBytes: parsePositiveInt(env.LOCAL_CODER_MAX_CONTEXT_BYTES, 96_000),
    allowedValidationCommands: parseCommandSet(env.LOCAL_CODER_ALLOWED_COMMANDS),
    telemetryEnabled: parseBoolean(env.LOCAL_CODER_TELEMETRY_ENABLED, true),
    telemetryPath: env.LOCAL_CODER_TELEMETRY_PATH ?? path.join(localCoderHome, 'telemetry.jsonl'),
    runStorePath: env.LOCAL_CODER_RUN_STORE_PATH ?? path.join(localCoderHome, 'runs'),
    contextIndexPath: env.LOCAL_CODER_CONTEXT_INDEX_PATH ?? path.join(localCoderHome, 'indexes')
  };
}
