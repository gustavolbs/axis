export interface LocalCoderConfig {
  ollamaBaseUrl: string;
  model: string;
  requestTimeoutMs: number;
  validationTimeoutMs: number;
  maxFileBytes: number;
  maxContextBytes: number;
  allowedValidationCommands: Set<string>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCommandSet(value: string | undefined): Set<string> {
  const raw = value ?? 'npm,pnpm,yarn,bun,npx,node';
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LocalCoderConfig {
  return {
    ollamaBaseUrl: (env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: env.LOCAL_CODER_MODEL ?? 'qwen2.5-coder:14b',
    requestTimeoutMs: parsePositiveInt(env.LOCAL_CODER_TIMEOUT_MS, 180_000),
    validationTimeoutMs: parsePositiveInt(env.LOCAL_CODER_VALIDATION_TIMEOUT_MS, 180_000),
    maxFileBytes: parsePositiveInt(env.LOCAL_CODER_MAX_FILE_BYTES, 120_000),
    maxContextBytes: parsePositiveInt(env.LOCAL_CODER_MAX_CONTEXT_BYTES, 600_000),
    allowedValidationCommands: parseCommandSet(env.LOCAL_CODER_ALLOWED_COMMANDS)
  };
}
