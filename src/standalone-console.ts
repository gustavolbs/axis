import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { createExecutionRuntime } from './execution-runtime.js';
import { createControlPlaneLocalProvider } from './local-inference-provider.js';
import { OllamaClient } from './ollama.js';
import { ProjectAdminService } from './project-admin.js';
import { handleProjectAdminRequest } from './project-admin-http.js';
import type { ModelSelection } from './project-store.js';
import {
  StandaloneJobManager,
  type StandaloneJobInput,
  type StandaloneReasoningEffort
} from './standalone-job-manager.js';

const config = loadConfig();
const ollama = new OllamaClient(config);
const runtime = createExecutionRuntime(config, ollama);
const projectAdmin = new ProjectAdminService({
  localProvider: createControlPlaneLocalProvider(config, ollama)
});
const consoleStateDir = path.join(path.dirname(config.runStorePath), 'console');
const jobs = new StandaloneJobManager(runtime.execution, consoleStateDir);
await jobs.restore();
const subscribers = new Set<ServerResponse>();
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(moduleDir, '..', 'console-dist');

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function sse(response: ServerResponse, event: string, payload: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event: string, payload: unknown): void {
  for (const response of subscribers) {
    try {
      sse(response, event, payload);
    } catch {
      subscribers.delete(response);
    }
  }
}

jobs.subscribe((event, job) => broadcast('job', { event, job }));

async function readJson(request: IncomingMessage, maxBytes = 200_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error(`Request exceeds ${maxBytes} bytes.`);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object.');
  }
  return parsed as Record<string, unknown>;
}

function isLoopbackIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.toLowerCase();
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return isLoopbackIpv4(ipv4);
}

function expandWorkspace(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function parseModelSelection(value: unknown): ModelSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('modelSelection must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.mode === 'auto') return { mode: 'auto' };
  if (
    candidate.mode === 'explicit' &&
    typeof candidate.providerId === 'string' && candidate.providerId.trim() &&
    typeof candidate.modelId === 'string' && candidate.modelId.trim()
  ) {
    return {
      mode: 'explicit',
      providerId: candidate.providerId.trim(),
      modelId: candidate.modelId.trim()
    };
  }
  throw new Error('modelSelection must be auto or an explicit provider/model pair.');
}

function parseReasoningEffort(value: unknown): StandaloneReasoningEffort | undefined {
  if (value === undefined) return undefined;
  const allowed = new Set<StandaloneReasoningEffort>([
    'auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'
  ]);
  if (typeof value !== 'string' || !allowed.has(value as StandaloneReasoningEffort)) {
    throw new Error('reasoningEffort must be auto, none, low, medium, high, xhigh, or max.');
  }
  return value as StandaloneReasoningEffort;
}

function parseJobInput(
  body: Record<string, unknown>,
  admin: ProjectAdminService
): StandaloneJobInput {
  if (typeof body.goal !== 'string') throw new Error('goal is required.');
  const projectId = typeof body.projectId === 'string' && body.projectId.trim()
    ? body.projectId.trim()
    : undefined;
  const workspace = projectId
    ? admin.getProject(projectId).workspace
    : typeof body.workspace === 'string' && body.workspace.trim()
      ? expandWorkspace(body.workspace)
      : undefined;
  if (!workspace) throw new Error('workspace is required when projectId is not provided.');

  const modelSelection = parseModelSelection(body.modelSelection);
  const reasoningEffort = parseReasoningEffort(body.reasoningEffort);
  if (!projectId && (modelSelection || (reasoningEffort && reasoningEffort !== 'auto'))) {
    throw new Error('Model and effort overrides require a configured Project.');
  }

  return {
    projectId,
    workspace,
    goal: body.goal,
    context: typeof body.context === 'string' ? body.context : undefined,
    constraints: Array.isArray(body.constraints)
      ? body.constraints.filter((value): value is string => typeof value === 'string')
      : undefined,
    language: typeof body.language === 'string' ? body.language : undefined,
    maxRepairRounds:
      typeof body.maxRepairRounds === 'number' && Number.isInteger(body.maxRepairRounds)
        ? Math.max(0, Math.min(body.maxRepairRounds, 2))
        : 1,
    modelSelection,
    reasoningEffort
  };
}

async function workerStatus(): Promise<Record<string, unknown>> {
  if (config.remoteWorkerUrl && config.remoteWorkerToken) {
    const response = await fetch(`${config.remoteWorkerUrl}/v1/status`, {
      headers: { authorization: `Bearer ${config.remoteWorkerToken}` },
      signal: AbortSignal.timeout(5_000)
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Worker status HTTP ${response.status}.`);
    return body;
  }
  return await runtime.health();
}

async function serveEvents(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  response.write(': connected\n\n');
  subscribers.add(response);
  sse(response, 'jobs', jobs.list());
  try {
    sse(response, 'worker', await workerStatus());
  } catch (error) {
    sse(response, 'worker-error', { error: error instanceof Error ? error.message : String(error) });
  }
  request.on('close', () => subscribers.delete(response));
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

async function serveStatic(urlPath: string, response: ServerResponse): Promise<void> {
  const requested = urlPath === '/' ? 'index.html' : urlPath.replace(/^[/\\]+/, '');
  const clean = path.normalize(requested).replace(/^([.][.][/\\])+/, '');
  let target = path.resolve(staticDir, clean);
  if (target !== staticDir && !target.startsWith(`${staticDir}${path.sep}`)) {
    json(response, 403, { error: 'Forbidden.' });
    return;
  }

  let content: Buffer;
  try {
    content = await fs.readFile(target);
  } catch {
    target = path.join(staticDir, 'index.html');
    try {
      content = await fs.readFile(target);
    } catch {
      json(response, 503, { error: 'Standalone console assets are not built. Run npm run console:build.' });
      return;
    }
  }
  response.writeHead(200, {
    'content-type': mime[path.extname(target)] ?? 'application/octet-stream',
    'cache-control': path.extname(target) === '.html' ? 'no-store' : 'public, max-age=300'
  });
  response.end(content);
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://local-coder-console');

  if (await handleProjectAdminRequest(request, response, projectAdmin)) return;

  if (request.method === 'GET' && url.pathname === '/api/events') {
    await serveEvents(request, response);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    try {
      json(response, 200, {
        ok: true,
        console: { host: config.consoleHost, port: config.consolePort, stateDir: consoleStateDir },
        cognitiveMode: config.cognitiveMode,
        execution: await runtime.health()
      });
    } catch (error) {
      json(response, 503, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/fs/exists') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      json(response, 403, { error: 'Filesystem validation is loopback-only.' });
      return;
    }
    const raw = url.searchParams.get('path')?.trim();
    if (!raw) {
      json(response, 400, { error: 'path is required.' });
      return;
    }
    const resolvedPath = expandWorkspace(raw);
    try {
      const stat = await fs.stat(resolvedPath);
      json(response, 200, { exists: stat.isDirectory(), resolvedPath });
    } catch {
      json(response, 200, { exists: false, resolvedPath });
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    json(response, 200, { jobs: jobs.list() });
    return;
  }

  const jobMatch = /^\/api\/jobs\/([A-Za-z0-9-]+)$/.exec(url.pathname);
  if (request.method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) json(response, 404, { error: 'Job not found.' });
    else json(response, 200, { job });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/jobs') {
    const body = await readJson(request);
    json(response, 202, { job: jobs.create(parseJobInput(body, projectAdmin)) });
    return;
  }

  const cancelMatch = /^\/api\/jobs\/([A-Za-z0-9-]+)\/cancel$/.exec(url.pathname);
  if (request.method === 'POST' && cancelMatch) {
    json(response, 200, { job: await jobs.cancel(cancelMatch[1]) });
    return;
  }

  const decisionMatch = /^\/api\/jobs\/([A-Za-z0-9-]+)\/decision$/.exec(url.pathname);
  if (request.method === 'POST' && decisionMatch) {
    const body = await readJson(request);
    const selections: Record<string, string> = {};
    if (body.selections && typeof body.selections === 'object' && !Array.isArray(body.selections)) {
      for (const [key, value] of Object.entries(body.selections as Record<string, unknown>)) {
        if (typeof value === 'string') selections[key] = value;
      }
    }
    json(response, 200, { job: jobs.submitDecision(decisionMatch[1], selections) });
    return;
  }

  const guidanceMatch = /^\/api\/jobs\/([A-Za-z0-9-]+)\/guidance$/.exec(url.pathname);
  if (request.method === 'POST' && guidanceMatch) {
    const body = await readJson(request);
    if (typeof body.guidance !== 'string') throw new Error('guidance is required.');
    json(response, 200, { job: jobs.submitGuidance(guidanceMatch[1], body.guidance) });
    return;
  }

  if (request.method === 'GET') {
    await serveStatic(url.pathname, response);
    return;
  }
  json(response, 404, { error: 'Not found.' });
}

const server = http.createServer((request, response) => {
  void route(request, response).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!response.headersSent) json(response, 400, { error: message });
    else response.destroy();
  });
});

const statusTimer = setInterval(() => {
  if (subscribers.size === 0) return;
  void workerStatus()
    .then((status) => broadcast('worker', status))
    .catch((error) => broadcast('worker-error', { error: error instanceof Error ? error.message : String(error) }));
}, 1_000);
statusTimer.unref();

server.listen(config.consolePort ?? 7557, config.consoleHost ?? '127.0.0.1', () => {
  const address = `http://${config.consoleHost ?? '127.0.0.1'}:${config.consolePort ?? 7557}`;
  console.error(`Local Coder Console listening at ${address}`);
  if ((config.consoleHost ?? '127.0.0.1') !== '127.0.0.1' && (config.consoleHost ?? '') !== '::1') {
    console.error(
      'WARNING: standalone job/health APIs are not authenticated on network binds. Administrative Project/provider/credential/pricing APIs remain loopback-only.'
    );
  }
});
