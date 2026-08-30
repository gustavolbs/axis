export interface LocalCoderConfig {
  ollamaBaseUrl: string;
  model: string;
  requestTimeoutMs: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LocalCoderConfig {
  return {
    ollamaBaseUrl: (env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: env.LOCAL_CODER_MODEL ?? 'qwen2.5-coder:14b',
    requestTimeoutMs: parsePositiveInt(env.LOCAL_CODER_TIMEOUT_MS, 180_000)
  };
}
