import os from 'node:os';
import path from 'node:path';

export interface LocalCoderConfig {
  ollamaBaseUrl: string;
  model: string;
  requestTimeoutMs: number;
  validationTimeoutMs: number;
  maxFileBytes: number;
  maxContextBytes: number;
  allowedValidationCommands: Set<string>;
  telemetryEnabled: boolean;
  telemetryPath: string;
  runStorePath?: string;
  contextIndexPath?: string;
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

  return {
    ollamaBaseUrl: (env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: env.LOCAL_CODER_MODEL ?? 'qwen2.5-coder:14b',
    requestTimeoutMs: parsePositiveInt(env.LOCAL_CODER_TIMEOUT_MS, 180_000),
    validationTimeoutMs: parsePositiveInt(env.LOCAL_CODER_VALIDATION_TIMEOUT_MS, 180_000),
    maxFileBytes: parsePositiveInt(env.LOCAL_CODER_MAX_FILE_BYTES, 120_000),
    maxContextBytes: parsePositiveInt(env.LOCAL_CODER_MAX_CONTEXT_BYTES, 600_000),
    allowedValidationCommands: parseCommandSet(env.LOCAL_CODER_ALLOWED_COMMANDS),
    telemetryEnabled: parseBoolean(env.LOCAL_CODER_TELEMETRY_ENABLED, true),
    telemetryPath: env.LOCAL_CODER_TELEMETRY_PATH ?? path.join(localCoderHome, 'telemetry.jsonl'),
    runStorePath: env.LOCAL_CODER_RUN_STORE_PATH ?? path.join(localCoderHome, 'runs'),
    contextIndexPath: env.LOCAL_CODER_CONTEXT_INDEX_PATH ?? path.join(localCoderHome, 'indexes')
  };
}
