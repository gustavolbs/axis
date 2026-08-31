import os from 'node:os';
import path from 'node:path';

import { readControlPlaneConfig, type ControlPlaneConfigFile } from './control-plane-config.js';
import { MacOSKeychainSecretStore } from './secret-store.js';

export type LocalCoderExecutionMode = 'local' | 'remote' | 'auto';
export type WorkerBootstrapMode = 'none' | 'auto';
export type CognitiveMode = 'adaptive' | 'fast' | 'deep' | 'max';

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
  /** Stage-specific wall-clock budgets. These cap runaway reasoning before the global safety cap. */
  investigationMaxDurationMs?: number;
  planningMaxDurationMs?: number;
  reviewMaxDurationMs?: number;
  reportMaxDurationMs?: number;
  repoLearningMaxDurationMs?: number;
  /** Stage-specific generation budgets (Ollama num_predict). */
  investigationMaxTokens?: number;
  planningMaxTokens?: number;
  reviewMaxTokens?: number;
  reportMaxTokens?: number;
  repoLearningMaxTokens?: number;
  /** Adaptive test-time-compute policy for the local agent. */
  cognitiveMode?: CognitiveMode;
  maxDeliberationPasses?: number;
  qualityGateMinScore?: number;
  /** Local-first external research. Microsoft Learn works without tenant credentials. */
  researchEnabled?: boolean;
  microsoftLearnResearchEnabled?: boolean;
  microsoftLearnMcpUrl?: string;
  /** Optional self-hosted SearXNG base URL for non-Microsoft web discovery. */
  searxngUrl?: string;
  researchTimeoutMs?: number;
  researchMaxResults?: number;
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
  /** Total control-plane envelope for queueing plus a complete remote job. */
  remoteWorkerTimeoutMs: number;
  remoteMaxDeltaBytes: number;

  workerHost: string;
  workerPort: number;
  workerToken?: string;
  workerStatePath: string;
  workerMaxBodyBytes: number;
  workerAllowedGitHosts: Set<string>;
  workerBootstrap: WorkerBootstrapMode;
  /** Heavy jobs accepted from independent UI/MCP sessions. */
  workerMaxConcurrentJobs?: number;

  /** Standalone Mac control-plane UI. Loopback-only by default. */
  consoleHost?: string;
  consolePort?: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCommandSet(value: string | undefined): Set<string> {
  const raw = value ?? 'npm,pnpm,yarn,bun';
  return new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean));
}

function parseStringSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
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

function parseCognitiveMode(value: string | undefined): CognitiveMode {
  if (!value) return 'adaptive';
  if (value === 'adaptive' || value === 'fast' || value === 'deep' || value === 'max') return value;
  throw new Error(`Invalid LOCAL_CODER_COGNITIVE_MODE: ${value}`);
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/$/, '');
}

function resolveRemoteWorkerToken(
  env: NodeJS.ProcessEnv,
  shared: ControlPlaneConfigFile | undefined
): string | undefined {
  const explicit = env.LOCAL_CODER_REMOTE_WORKER_TOKEN?.trim();
  if (explicit) return explicit;

  const credentialRef =
    env.LOCAL_CODER_REMOTE_WORKER_CREDENTIAL_REF?.trim() || shared?.remoteWorkerCredentialRef;
  if (credentialRef && process.platform === 'darwin') {
    const keychain = new MacOSKeychainSecretStore();
    if (keychain.isAvailable()) {
      const stored = keychain.get(credentialRef)?.trim();
      if (stored) return stored;
    }
  }

  // Backwards compatibility for v0.14 installations. New Local Coder writers never
  // persist this field, but existing configs remain usable until the installer migrates them.
  return shared?.remoteWorkerToken || undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LocalCoderConfig {
  const localCoderHome = path.join(os.homedir(), '.local-coder-mcp');
  const shared = readControlPlaneConfig();
  const executionMode = parseExecutionMode(env.LOCAL_CODER_EXECUTION_MODE ?? shared?.executionMode);
  const adaptiveModelsEnabled = parseBoolean(
    env.LOCAL_CODER_ADAPTIVE_MODELS,
    executionMode === 'remote' ? false : true
  );
  const sharedModel = shared?.model || undefined;

  // Environment always wins. The shared control-plane file is the canonical fallback
  // for plain-shell standalone use so Claude and the Console cannot silently drift.
  const fastModel = adaptiveModelsEnabled
    ? env.LOCAL_CODER_FAST_MODEL ?? sharedModel ?? 'qwen2.5-coder:7b'
    : env.LOCAL_CODER_MODEL ?? env.LOCAL_CODER_FAST_MODEL ?? sharedModel ?? 'qwen2.5-coder:14b';

  return {
    ollamaBaseUrl: (env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: fastModel,
    strongModel: env.LOCAL_CODER_STRONG_MODEL ?? sharedModel ?? 'qwen2.5-coder:14b',
    adaptiveModelsEnabled,
    ollamaNumCtx: parsePositiveInt(env.LOCAL_CODER_NUM_CTX, 16_384),
    fastModelKeepAlive: env.LOCAL_CODER_FAST_KEEP_ALIVE ?? '90s',
    strongModelKeepAlive: env.LOCAL_CODER_STRONG_KEEP_ALIVE ?? '30s',
    requestTimeoutMs: parsePositiveInt(env.LOCAL_CODER_TIMEOUT_MS, 180_000),
    inferenceHeaderTimeoutMs: parsePositiveInt(env.LOCAL_CODER_INFERENCE_HEADER_TIMEOUT_MS, 180_000),
    inferenceFirstChunkTimeoutMs: parsePositiveInt(env.LOCAL_CODER_INFERENCE_FIRST_CHUNK_TIMEOUT_MS, 600_000),
    inferenceIdleTimeoutMs: parsePositiveInt(env.LOCAL_CODER_INFERENCE_IDLE_TIMEOUT_MS, 300_000),
    inferenceMaxDurationMs: parsePositiveInt(env.LOCAL_CODER_INFERENCE_MAX_DURATION_MS, 1_800_000),
    investigationMaxDurationMs: parsePositiveInt(env.LOCAL_CODER_INVESTIGATION_MAX_DURATION_MS, 300_000),
    planningMaxDurationMs: parsePositiveInt(env.LOCAL_CODER_PLANNING_MAX_DURATION_MS, 600_000),
    reviewMaxDurationMs: parsePositiveInt(env.LOCAL_CODER_REVIEW_MAX_DURATION_MS, 600_000),
    reportMaxDurationMs: parsePositiveInt(env.LOCAL_CODER_REPORT_MAX_DURATION_MS, 480_000),
    repoLearningMaxDurationMs: parsePositiveInt(env.LOCAL_CODER_REPO_LEARNING_MAX_DURATION_MS, 300_000),
    investigationMaxTokens: parsePositiveInt(env.LOCAL_CODER_INVESTIGATION_MAX_TOKENS, 2_048),
    planningMaxTokens: parsePositiveInt(env.LOCAL_CODER_PLANNING_MAX_TOKENS, 3_072),
    reviewMaxTokens: parsePositiveInt(env.LOCAL_CODER_REVIEW_MAX_TOKENS, 3_072),
    reportMaxTokens: parsePositiveInt(env.LOCAL_CODER_REPORT_MAX_TOKENS, 3_072),
    repoLearningMaxTokens: parsePositiveInt(env.LOCAL_CODER_REPO_LEARNING_MAX_TOKENS, 2_048),
    cognitiveMode: parseCognitiveMode(env.LOCAL_CODER_COGNITIVE_MODE),
    maxDeliberationPasses: Math.min(4, parsePositiveInt(env.LOCAL_CODER_MAX_DELIBERATION_PASSES, 3)),
    qualityGateMinScore: Math.min(100, parsePositiveInt(env.LOCAL_CODER_QUALITY_GATE_MIN_SCORE, 80)),
    researchEnabled: parseBoolean(env.LOCAL_CODER_RESEARCH_ENABLED, true),
    microsoftLearnResearchEnabled: parseBoolean(env.LOCAL_CODER_MICROSOFT_LEARN_RESEARCH_ENABLED, true),
    microsoftLearnMcpUrl:
      env.LOCAL_CODER_MICROSOFT_LEARN_MCP_URL?.trim() ||
      'https://learn.microsoft.com/api/mcp?maxTokenBudget=2400',
    searxngUrl: trimTrailingSlash(env.LOCAL_CODER_SEARXNG_URL),
    researchTimeoutMs: parsePositiveInt(env.LOCAL_CODER_RESEARCH_TIMEOUT_MS, 45_000),
    researchMaxResults: Math.min(12, parsePositiveInt(env.LOCAL_CODER_RESEARCH_MAX_RESULTS, 6)),
    validationTimeoutMs: parsePositiveInt(env.LOCAL_CODER_VALIDATION_TIMEOUT_MS, 180_000),
    maxFileBytes: parsePositiveInt(env.LOCAL_CODER_MAX_FILE_BYTES, 120_000),
    maxContextBytes: parsePositiveInt(env.LOCAL_CODER_MAX_CONTEXT_BYTES, 96_000),
    allowedValidationCommands: parseCommandSet(env.LOCAL_CODER_ALLOWED_COMMANDS),
    telemetryEnabled: parseBoolean(env.LOCAL_CODER_TELEMETRY_ENABLED, true),
    telemetryPath: env.LOCAL_CODER_TELEMETRY_PATH ?? path.join(localCoderHome, 'telemetry.jsonl'),
    runStorePath: env.LOCAL_CODER_RUN_STORE_PATH ?? path.join(localCoderHome, 'runs'),
    contextIndexPath: env.LOCAL_CODER_CONTEXT_INDEX_PATH ?? path.join(localCoderHome, 'indexes'),

    executionMode,
    remoteWorkerUrl: trimTrailingSlash(env.LOCAL_CODER_REMOTE_WORKER_URL ?? shared?.remoteWorkerUrl),
    remoteWorkerToken: resolveRemoteWorkerToken(env, shared),
    remoteWorkerTimeoutMs: parsePositiveInt(env.LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS, 7_200_000),
    remoteMaxDeltaBytes: parsePositiveInt(env.LOCAL_CODER_REMOTE_MAX_DELTA_BYTES, 8_000_000),

    workerHost: env.LOCAL_CODER_WORKER_HOST?.trim() || '127.0.0.1',
    workerPort: parsePositiveInt(env.LOCAL_CODER_WORKER_PORT, 7337),
    workerToken: env.LOCAL_CODER_WORKER_TOKEN?.trim() || undefined,
    workerStatePath: env.LOCAL_CODER_WORKER_STATE_PATH ?? path.join(localCoderHome, 'worker'),
    workerMaxBodyBytes: parsePositiveInt(env.LOCAL_CODER_WORKER_MAX_BODY_BYTES, 12_000_000),
    workerAllowedGitHosts: parseStringSet(env.LOCAL_CODER_WORKER_ALLOWED_GIT_HOSTS),
    workerBootstrap: parseBootstrapMode(env.LOCAL_CODER_WORKER_BOOTSTRAP),
    workerMaxConcurrentJobs: Math.min(8, parsePositiveInt(env.LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS, 1)),

    consoleHost: env.LOCAL_CODER_CONSOLE_HOST?.trim() || '127.0.0.1',
    consolePort: parsePositiveInt(env.LOCAL_CODER_CONSOLE_PORT, 7557)
  };
}
