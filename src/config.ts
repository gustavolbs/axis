import path from 'node:path';

import { appHomePath, readAppSettings, type AppSettingsFile } from './app-config.js';
import { MacOSKeychainSecretStore } from './secret-store.js';

export type LocalCoderExecutionMode = 'local' | 'remote' | 'auto';
export type WorkerBootstrapMode = 'none' | 'auto';
export type CognitiveMode = 'adaptive' | 'fast' | 'deep' | 'max';

export interface LocalCoderConfig {
  ollamaBaseUrl: string;
  model: string;
  strongModel?: string;
  adaptiveModelsEnabled?: boolean;
  ollamaNumCtx?: number;
  fastModelKeepAlive?: string;
  strongModelKeepAlive?: string;
  requestTimeoutMs: number;
  inferenceHeaderTimeoutMs?: number;
  inferenceFirstChunkTimeoutMs?: number;
  inferenceIdleTimeoutMs?: number;
  inferenceMaxDurationMs?: number;
  investigationMaxDurationMs?: number;
  planningMaxDurationMs?: number;
  reviewMaxDurationMs?: number;
  reportMaxDurationMs?: number;
  repoLearningMaxDurationMs?: number;
  investigationMaxTokens?: number;
  planningMaxTokens?: number;
  reviewMaxTokens?: number;
  reportMaxTokens?: number;
  repoLearningMaxTokens?: number;
  cognitiveMode?: CognitiveMode;
  maxDeliberationPasses?: number;
  qualityGateMinScore?: number;
  researchEnabled?: boolean;
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
  remoteWorkerTimeoutMs: number;
  remoteMaxDeltaBytes: number;

  workerHost: string;
  workerPort: number;
  workerToken?: string;
  workerStatePath: string;
  workerMaxBodyBytes: number;
  workerAllowedGitHosts: Set<string>;
  workerBootstrap: WorkerBootstrapMode;
  workerMaxConcurrentJobs?: number;
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
  return new Set((value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
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

function resolveRemoteWorkerToken(env: NodeJS.ProcessEnv, settings: AppSettingsFile | undefined): string | undefined {
  const explicit = env.LOCAL_CODER_REMOTE_WORKER_TOKEN?.trim();
  if (explicit) return explicit;

  const credentialRef = env.LOCAL_CODER_REMOTE_WORKER_CREDENTIAL_REF?.trim() || settings?.remoteWorkerCredentialRef;
  if (credentialRef && process.platform === 'darwin') {
    const keychain = new MacOSKeychainSecretStore();
    if (keychain.isAvailable()) {
      const stored = keychain.get(credentialRef)?.trim();
      if (stored) return stored;
    }
  }

  return settings?.legacyRemoteWorkerToken || undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LocalCoderConfig {
  const localCoderHome = appHomePath();
  const settings = readAppSettings();
  const executionMode = parseExecutionMode(env.LOCAL_CODER_EXECUTION_MODE ?? settings?.executionMode);
  const adaptiveModelsEnabled = parseBoolean(env.LOCAL_CODER_ADAPTIVE_MODELS, executionMode !== 'remote');
  const configuredModel = settings?.model || undefined;
  const fastModel = adaptiveModelsEnabled
    ? env.LOCAL_CODER_FAST_MODEL ?? configuredModel ?? 'qwen2.5-coder:7b'
    : env.LOCAL_CODER_MODEL ?? env.LOCAL_CODER_FAST_MODEL ?? configuredModel ?? 'qwen2.5-coder:14b';

  return {
    ollamaBaseUrl: (env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, ''),
    model: fastModel,
    strongModel: env.LOCAL_CODER_STRONG_MODEL ?? configuredModel ?? 'qwen2.5-coder:14b',
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
    remoteWorkerUrl: trimTrailingSlash(env.LOCAL_CODER_REMOTE_WORKER_URL ?? settings?.remoteWorkerUrl),
    remoteWorkerToken: resolveRemoteWorkerToken(env, settings),
    remoteWorkerTimeoutMs: parsePositiveInt(env.LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS, 7_200_000),
    remoteMaxDeltaBytes: parsePositiveInt(env.LOCAL_CODER_REMOTE_MAX_DELTA_BYTES, 8_000_000),

    workerHost: env.LOCAL_CODER_WORKER_HOST?.trim() || '127.0.0.1',
    workerPort: parsePositiveInt(env.LOCAL_CODER_WORKER_PORT, 7337),
    workerToken: env.LOCAL_CODER_WORKER_TOKEN?.trim() || undefined,
    workerStatePath: env.LOCAL_CODER_WORKER_STATE_PATH ?? path.join(localCoderHome, 'worker'),
    workerMaxBodyBytes: parsePositiveInt(env.LOCAL_CODER_WORKER_MAX_BODY_BYTES, 12_000_000),
    workerAllowedGitHosts: parseStringSet(env.LOCAL_CODER_WORKER_ALLOWED_GIT_HOSTS),
    workerBootstrap: parseBootstrapMode(env.LOCAL_CODER_WORKER_BOOTSTRAP),
    workerMaxConcurrentJobs: Math.min(8, parsePositiveInt(env.LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS, 1))
  };
}
