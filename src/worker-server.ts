import { timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { isCancellationError, withCancellationSignal } from './cancellation.js';
import { loadConfig } from './config.js';
import { executeAgenticCodeTask } from './executor.js';
import {
  classifyInferenceStage,
  progressAtInferenceStart,
  progressFromInferenceResult,
  WorkerInferenceTracker
} from './inference-status.js';
import { getMachineStatus } from './machine-status.js';
import { OllamaClient } from './ollama.js';
import { preparePromptForInference } from './planning-policy.js';
import { currentProgressJobId } from './progress-context.js';
import { executePremiumLocalAgent, type PremiumEngineerResult } from './premium-agent.js';
import { executeLocalCodePlan } from './orchestrator.js';
import { reportProgress } from './progress-context.js';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  assertProtocolVersion,
  type RemoteChatRequest,
  type RemoteEngineerRequest,
  type RemotePlanRequest,
  type RemoteTaskRequest,
  type RemoteWorkspaceSnapshot
} from './remote-protocol.js';
import { WorkerScheduler } from './worker-scheduler.js';
import { WorkerHistoryStore } from './worker-history.js';
import { withWorkerWorkspace } from './worker-workspace.js';

const WORKER_VERSION = '0.14.0';
const config = loadConfig();
const ollama = new OllamaClient(config);
const scheduler = new WorkerScheduler(config.workerMaxConcurrentJobs ?? 1);
const history = new WorkerHistoryStore(path.join(config.workerStatePath, 'history'), 200);
const inferenceTracker = new WorkerInferenceTracker();
const historyFailure = (error: unknown): void => {
  console.error('local-coder history write failed: ' + (error instanceof Error ? error.message : String(error)));
};

const baseChat = ollama.chat.bind(ollama);
ollama.chat = (async (...args: Parameters<OllamaClient['chat']>) => {
  const [systemPrompt, userPrompt, format, runtime] = args;
  const stage = classifyInferenceStage(systemPrompt);
  const model = runtime?.model ?? config.model;
  const preparedPrompt = preparePromptForInference(
    systemPrompt,
    userPrompt,
    runtime?.numCtx ?? config.ollamaNumCtx ?? 16_384
  );
  const jobId = currentProgressJobId();
  const inferenceId = inferenceTracker.begin(stage, model);
  reportProgress(progressAtInferenceStart(stage, preparedPrompt.userPrompt));
  if (jobId) {
    await history.appendEvent(jobId, {
      type: 'model-input',
      title: stage + ' prompt sent to Qwen',
      stage,
      model,
      systemPrompt,
      userPrompt: preparedPrompt.userPrompt,
      promptTruncated: preparedPrompt.truncated,
      originalUserPromptChars: preparedPrompt.originalUserPromptChars,
      data: { format: format ?? null, thinking: runtime?.think ?? null }
    }).catch(historyFailure);
  }
  try {
    const generation = await baseChat(systemPrompt, userPrompt, format, {
      ...runtime,
      onStreamProgress: (progress) => {
        inferenceTracker.update(inferenceId, progress);
        runtime?.onStreamProgress?.(progress);
      }
    });
    inferenceTracker.complete(inferenceId, 'success', {
      promptTokens: generation.promptTokens,
      completionTokens: generation.completionTokens
    });
    if (jobId) {
      await history.appendEvent(jobId, {
        type: 'model-output',
        title: stage + ' output',
        stage,
        model: generation.model,
        output: generation.content,
        promptTokens: generation.promptTokens,
        completionTokens: generation.completionTokens,
        durationMs: generation.totalDurationNs ? generation.totalDurationNs / 1_000_000 : undefined
      }).catch(historyFailure);
    }
    reportProgress(progressFromInferenceResult(stage, generation.content));
    return generation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    inferenceTracker.complete(inferenceId, 'error', { error: message });
    if (jobId) {
      await history.appendEvent(jobId, {
        type: 'error',
        title: stage + ' inference failed',
        stage,
        model,
        error: message
      }).catch(historyFailure);
    }
    reportProgress({
      phase: stage,
      action: 'Qwen ' + stage + ' call failed',
      detail: message,
      reasoningSummary: 'The current local inference failed before a usable structured result was produced.'
    });
    throw error;
  }
}) as OllamaClient['chat'];

function json(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function authorized(request: IncomingMessage): boolean {
  const token = config.workerToken;
  if (!token) return false;
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    bytes += buffer.byteLength;
    if (bytes > config.workerMaxBodyBytes) {
      throw new Error(`Request body exceeds ${config.workerMaxBodyBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) throw new Error('Request body is required.');
  return JSON.parse(raw) as unknown;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertWorkspace(value: unknown): asserts value is RemoteWorkspaceSnapshot {
  assertObject(value, 'workspace');
  if (typeof value.repositoryUrl !== 'string' || !value.repositoryUrl) {
    throw new Error('workspace.repositoryUrl is required.');
  }
  if (typeof value.baseSha !== 'string' || !/^[0-9a-fA-F]{40,64}$/.test(value.baseSha)) {
    throw new Error('workspace.baseSha must be a Git commit SHA.');
  }
  if (typeof value.workspaceRelativePath !== 'string') {
    throw new Error('workspace.workspaceRelativePath must be a string.');
  }
  if (typeof value.dirtyPatchBase64 !== 'string') {
    throw new Error('workspace.dirtyPatchBase64 must be a string.');
  }
  if (!Array.isArray(value.untrackedFiles) || !Array.isArray(value.expectedFiles)) {
    throw new Error('workspace file payloads must be arrays.');
  }
  if (
    value.memoryScopeKey !== undefined &&
    (typeof value.memoryScopeKey !== 'string' || !/^[a-f0-9]{16,64}$/i.test(value.memoryScopeKey))
  ) {
    throw new Error('workspace.memoryScopeKey must be an opaque hexadecimal key.');
  }
}

function isolationKey(snapshot: RemoteWorkspaceSnapshot): string {
  return snapshot.isolationKey?.trim() || `${snapshot.repositoryUrl}|${snapshot.workspaceRelativePath}`;
}

function repoIntelligenceStatus(): Record<string, unknown> {
  return {
    enabled:
      process.env.LOCAL_CODER_REPO_INTELLIGENCE_ENABLED === undefined ||
      !['0', 'false', 'no', 'off'].includes(
        process.env.LOCAL_CODER_REPO_INTELLIGENCE_ENABLED.trim().toLowerCase()
      ),
    storage: 'worker-local'
  };
}

function researchStatus(): Record<string, unknown> {
  return {
    enabled: config.researchEnabled !== false,
    microsoftLearn: config.microsoftLearnResearchEnabled !== false,
    searxngConfigured: Boolean(config.searxngUrl),
    policy: 'local-first'
  };
}

async function health(response: ServerResponse): Promise<void> {
  try {
    const ollamaHealth = await ollama.health();
    json(response, 200, {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerVersion: WORKER_VERSION,
      ok: true,
      hostname: os.hostname(),
      platform: process.platform,
      model: config.model,
      bootstrap: config.workerBootstrap,
      scheduler: scheduler.snapshot(),
      repoIntelligence: repoIntelligenceStatus(),
      research: researchStatus(),
      ollama: ollamaHealth
    });
  } catch (error) {
    json(response, 503, {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerVersion: WORKER_VERSION,
      ok: false,
      scheduler: scheduler.snapshot(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function status(response: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  try {
    const [ollamaHealth, machine] = await Promise.all([ollama.health(), getMachineStatus()]);
    json(response, 200, {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerVersion: WORKER_VERSION,
      ok: true,
      collectedAt: new Date().toISOString(),
      collectionMs: Date.now() - startedAt,
      hostname: os.hostname(),
      platform: process.platform,
      model: config.model,
      bootstrap: config.workerBootstrap,
      scheduler: scheduler.snapshot(),
      inference: inferenceTracker.snapshot(),
      repoIntelligence: repoIntelligenceStatus(),
      research: researchStatus(),
      ollama: ollamaHealth,
      machine
    });
  } catch (error) {
    json(response, 503, {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerVersion: WORKER_VERSION,
      ok: false,
      collectedAt: new Date().toISOString(),
      scheduler: scheduler.snapshot(),
      inference: inferenceTracker.snapshot(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleChat(body: unknown, response: ServerResponse): Promise<void> {
  assertObject(body, 'request');
  assertProtocolVersion(body.protocolVersion);
  if (typeof body.systemPrompt !== 'string' || typeof body.userPrompt !== 'string') {
    throw new Error('systemPrompt and userPrompt are required.');
  }

  const request = body as unknown as RemoteChatRequest;
  const generation = await scheduler.enqueue('chat', 'model-chat', (job) => {
    job.update({ phase: 'other', action: 'Running delegated model chat' });
    return ollama.chat(request.systemPrompt, request.userPrompt, request.format);
  });
  json(response, 200, {
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    generation
  });
}

async function handleTask(body: unknown, response: ServerResponse): Promise<void> {
  assertObject(body, 'request');
  assertProtocolVersion(body.protocolVersion);
  assertWorkspace(body.workspace);
  assertObject(body.input, 'input');

  const request = body as unknown as RemoteTaskRequest;
  if (!Array.isArray(request.input.editableFiles) || request.input.editableFiles.length === 0) {
    throw new Error('input.editableFiles is required.');
  }

  const output = await scheduler.enqueue('task', isolationKey(request.workspace), (job) => {
    job.update({
      phase: 'workspace',
      action: 'Reconstructing remote workspace',
      detail: request.workspace.repositoryUrl,
      files: request.input.editableFiles
    });
    return withWorkerWorkspace(request.workspace, config, async (workspace) => {
      job.update({
        phase: 'implementation',
        action: 'Workspace ready; executing bounded code task',
        completedSteps: ['workspace']
      });
      return executeAgenticCodeTask(ollama, config, { ...request.input, workspace });
    });
  });

  json(response, 200, {
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    result: output.result,
    changes: output.changes
  });
}

async function handlePlan(body: unknown, response: ServerResponse): Promise<void> {
  assertObject(body, 'request');
  assertProtocolVersion(body.protocolVersion);
  assertWorkspace(body.workspace);
  assertObject(body.input, 'input');

  const request = body as unknown as RemotePlanRequest;
  if (!Array.isArray(request.input.tasks) || request.input.tasks.length === 0) {
    throw new Error('input.tasks is required.');
  }

  const output = await scheduler.enqueue('plan', isolationKey(request.workspace), (job) => {
    job.update({
      phase: 'workspace',
      action: 'Reconstructing remote workspace',
      detail: request.workspace.repositoryUrl
    });
    return withWorkerWorkspace(request.workspace, config, async (workspace) => {
      job.update({
        phase: 'implementation',
        action: 'Workspace ready; executing implementation plan',
        completedSteps: ['workspace']
      });
      return executeLocalCodePlan(ollama, config, { ...request.input, workspace }, job.update);
    });
  });

  json(response, 200, {
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    result: output.result,
    changes: output.changes
  });
}

async function handleEngineer(body: unknown, response: ServerResponse): Promise<void> {
  assertObject(body, 'request');
  assertProtocolVersion(body.protocolVersion);
  assertWorkspace(body.workspace);
  assertObject(body.input, 'input');

  const request = body as unknown as RemoteEngineerRequest;
  if (typeof request.input.goal !== 'string' || !request.input.goal.trim()) {
    throw new Error('input.goal is required.');
  }

  let historyJobId: string | undefined;
  try {
    const output = await scheduler.enqueue('engineer', isolationKey(request.workspace), async (job) => {
      historyJobId = job.id;
      await history.startRun({
        id: job.id,
        kind: 'engineer',
        isolationKey: isolationKey(request.workspace),
        startedAt: new Date().toISOString()
      });
      await history.annotateRun(job.id, {
        goal: request.input.goal,
        repositoryUrl: request.workspace.repositoryUrl
      });
      await history.appendEvent(job.id, {
        type: 'request',
        title: 'local_engineer request',
        data: {
          goal: request.input.goal,
          context: request.input.context ?? null,
          constraints: request.input.constraints ?? [],
          language: request.input.language ?? null,
          claudeGuidance: request.input.claudeGuidance ?? null,
          maxRepairRounds: request.input.maxRepairRounds ?? null,
          repositoryUrl: request.workspace.repositoryUrl,
          baseSha: request.workspace.baseSha
        }
      });
      job.update({
        phase: 'workspace',
        action: 'Reconstructing repository worktree',
        detail: request.workspace.repositoryUrl,
        completedSteps: []
      });
      return await withWorkerWorkspace(request.workspace, config, async (workspace) => {
        job.update({
          phase: 'investigation',
          action: 'Workspace reconstructed; starting premium local agent',
          detail: request.input.goal,
          completedSteps: ['workspace']
        });
        return await executePremiumLocalAgent(ollama, config, {
          ...request.input,
          workspace,
          repoMemoryScopeKey: request.workspace.memoryScopeKey
        });
      });
    });

    if (historyJobId) {
      const premium = output.result.result as PremiumEngineerResult;
      await history.appendEvent(historyJobId, {
        type: 'result',
        title: 'local_engineer result',
        data: {
          status: output.result.result.status,
          phase: output.result.result.phase,
          summary: output.result.result.summary,
          preflight: premium.preflight ?? null,
          decisionRequest: premium.decisionRequest ?? null,
          changedFiles: output.result.result.changedFiles,
          validation: output.result.result.validation,
          review: output.result.result.review ?? null,
          repairRounds: output.result.result.repairRounds,
          modelCalls: output.result.result.modelCalls,
          escalation: output.result.result.escalation ?? null
        }
      });
      await history.finishRun(historyJobId, 'success');
    }

    json(response, 200, {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      result: output.result.result,
      changes: output.result.changes
    });
  } catch (error) {
    if (historyJobId) {
      const message = error instanceof Error ? error.message : String(error);
      await history.appendEvent(historyJobId, {
        type: 'error',
        title: 'local_engineer failed',
        error: message
      }).catch(historyFailure);
      await history.finishRun(historyJobId, 'error', message).catch(historyFailure);
    }
    throw error;
  }
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!authorized(request)) {
    response.setHeader('www-authenticate', 'Bearer');
    json(response, 401, {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      error: 'Unauthorized.'
    });
    return;
  }

  if (request.method === 'GET' && request.url === '/v1/health') {
    await health(response);
    return;
  }
  if (request.method === 'GET' && request.url === '/v1/status') {
    await status(response);
    return;
  }
  if (request.method === 'GET' && request.url?.startsWith('/v1/history')) {
    const url = new URL(request.url, 'http://local-coder-worker');
    if (url.pathname === '/v1/history') {
      const parsedLimit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      json(response, 200, {
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        runs: await history.listRuns(Number.isFinite(parsedLimit) ? parsedLimit : 50)
      });
      return;
    }
    const match = /^\/v1\/history\/([A-Za-z0-9-]{1,100})$/.exec(url.pathname);
    if (match) {
      const run = await history.readRun(match[1]);
      if (!run) {
        json(response, 404, {
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          error: 'History run not found.'
        });
        return;
      }
      json(response, 200, { protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, run });
      return;
    }
  }

  if (request.method !== 'POST') {
    json(response, 404, {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      error: 'Not found.'
    });
    return;
  }

  const body = await readJsonBody(request);
  if (request.url === '/v1/chat') {
    await handleChat(body, response);
    return;
  }
  if (request.url === '/v1/execute-task') {
    await handleTask(body, response);
    return;
  }
  if (request.url === '/v1/execute-plan') {
    await handlePlan(body, response);
    return;
  }
  if (request.url === '/v1/engineer') {
    await handleEngineer(body, response);
    return;
  }

  json(response, 404, {
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    error: 'Not found.'
  });
}

if (!config.workerToken) {
  console.error('LOCAL_CODER_WORKER_TOKEN is required to start the remote worker.');
  process.exit(1);
}

const server = http.createServer((request, response) => {
  const controller = new AbortController();
  request.once('aborted', () => controller.abort());
  response.once('close', () => {
    if (!response.writableEnded) controller.abort();
  });

  void withCancellationSignal(controller.signal, () => route(request, response)).catch((error) => {
    if (controller.signal.aborted || isCancellationError(error)) {
      if (!response.headersSent && !response.destroyed) {
        json(response, 499, {
          protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          error: 'Request cancelled.'
        });
      } else if (!response.destroyed) {
        response.destroy();
      }
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`local-coder worker request failed: ${message}`);
    if (!response.headersSent) {
      json(response, 400, {
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        error: message
      });
    } else {
      response.destroy();
    }
  });
});

server.requestTimeout = config.remoteWorkerTimeoutMs;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;

server.listen(config.workerPort, config.workerHost, () => {
  console.error(
    `local-coder worker v${WORKER_VERSION} listening on http://${config.workerHost}:${config.workerPort} (model: ${config.model}, bootstrap: ${config.workerBootstrap}, maxJobs: ${config.workerMaxConcurrentJobs ?? 1})`
  );
});
