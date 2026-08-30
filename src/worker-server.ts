import { timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';

import { loadConfig } from './config.js';
import { executeAgenticCodeTask } from './executor.js';
import { OllamaClient } from './ollama.js';
import { executeLocalCodePlan } from './orchestrator.js';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  assertProtocolVersion,
  type RemoteChatRequest,
  type RemoteEngineerRequest,
  type RemotePlanRequest,
  type RemoteTaskRequest,
  type RemoteWorkspaceSnapshot
} from './remote-protocol.js';
import { executeLocalEngineerWithRepoIntelligence } from './repo-intelligence.js';
import { WorkerScheduler } from './worker-scheduler.js';
import { withWorkerWorkspace } from './worker-workspace.js';

const WORKER_VERSION = '0.10.0';
const config = loadConfig();
const ollama = new OllamaClient(config);
const scheduler = new WorkerScheduler(config.workerMaxConcurrentJobs ?? 1);

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
}

function isolationKey(snapshot: RemoteWorkspaceSnapshot): string {
  return snapshot.isolationKey?.trim() || `${snapshot.repositoryUrl}|${snapshot.workspaceRelativePath}`;
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
      repoIntelligence: {
        enabled:
          process.env.LOCAL_CODER_REPO_INTELLIGENCE_ENABLED === undefined ||
          !['0', 'false', 'no', 'off'].includes(
            process.env.LOCAL_CODER_REPO_INTELLIGENCE_ENABLED.trim().toLowerCase()
          ),
        storage: 'worker-local'
      },
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

async function handleChat(body: unknown, response: ServerResponse): Promise<void> {
  assertObject(body, 'request');
  assertProtocolVersion(body.protocolVersion);
  if (typeof body.systemPrompt !== 'string' || typeof body.userPrompt !== 'string') {
    throw new Error('systemPrompt and userPrompt are required.');
  }

  const request = body as unknown as RemoteChatRequest;
  const generation = await scheduler.enqueue('chat', 'model-chat', () =>
    ollama.chat(request.systemPrompt, request.userPrompt, request.format)
  );
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

  const output = await scheduler.enqueue('task', isolationKey(request.workspace), () =>
    withWorkerWorkspace(request.workspace, config, async (workspace) =>
      executeAgenticCodeTask(ollama, config, { ...request.input, workspace })
    )
  );

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

  const output = await scheduler.enqueue('plan', isolationKey(request.workspace), () =>
    withWorkerWorkspace(request.workspace, config, async (workspace) =>
      executeLocalCodePlan(ollama, config, { ...request.input, workspace })
    )
  );

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

  const output = await scheduler.enqueue('engineer', isolationKey(request.workspace), () =>
    withWorkerWorkspace(request.workspace, config, async (workspace) =>
      executeLocalEngineerWithRepoIntelligence(ollama, config, { ...request.input, workspace })
    )
  );

  // The local engineer discovers its editable set only after investigation/planning,
  // so it owns dynamic before/after snapshots and returns its own bounded changes.
  json(response, 200, {
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    result: output.result.result,
    changes: output.result.changes
  });
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
  void route(request, response).catch((error) => {
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