import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { createExecutionRuntime } from './execution-runtime.js';
import { OllamaClient } from './ollama.js';
import { StandaloneJobManager, type StandaloneJobInput } from './standalone-job-manager.js';

const config = loadConfig();
const ollama = new OllamaClient(config);
const runtime = createExecutionRuntime(config, ollama);
const jobs = new StandaloneJobManager(runtime.execution);
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

jobs.subscribe((event, job) => {
  broadcast('job', { event, job });
});

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

function parseJobInput(body: Record<string, unknown>): StandaloneJobInput {
  if (typeof body.workspace !== 'string' || typeof body.goal !== 'string') {
    throw new Error('workspace and goal are required strings.');
  }
  return {
    workspace: body.workspace,
    goal: body.goal,
    context: typeof body.context === 'string' ? body.context : undefined,
    constraints: Array.isArray(body.constraints)
      ? body.constraints.filter((value): value is string => typeof value === 'string')
      : undefined,
    language: typeof body.language === 'string' ? body.language : undefined,
    maxRepairRounds:
      typeof body.maxRepairRounds === 'number' && Number.isInteger(body.maxRepairRounds)
        ? Math.max(0, Math.min(body.maxRepairRounds, 2))
        : 1
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
    sse(response, 'worker-error', {
      error: error instanceof Error ? error.message : String(error)
    });
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
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const clean = path.normalize(requested).replace(/^([.][.][/\\])+/, '');
  let target = path.join(staticDir, clean);
  if (!target.startsWith(staticDir)) {
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
      json(response, 503, {
        error: 'Standalone console assets are not built. Run npm run console:build.'
      });
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

  if (request.method === 'GET' && url.pathname === '/api/events') {
    await serveEvents(request, response);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    try {
      json(response, 200, {
        ok: true,
        console: { host: config.consoleHost, port: config.consolePort },
        cognitiveMode: config.cognitiveMode,
        execution: await runtime.health()
      });
    } catch (error) {
      json(response, 503, { ok: false, error: error instanceof Error ? error.message : String(error) });
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
    const job = jobs.create(parseJobInput(body));
    json(response, 202, { job });
    return;
  }

  const decisionMatch = /^\/api\/jobs\/([A-Za-z0-9-]+)\/decision$/.exec(url.pathname);
  if (request.method === 'POST' && decisionMatch) {
    const body = await readJson(request);
    const selections =
      body.selections && typeof body.selections === 'object' && !Array.isArray(body.selections)
        ? Object.fromEntries(
            Object.entries(body.selections as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : {};
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
    .catch((error) =>
      broadcast('worker-error', { error: error instanceof Error ? error.message : String(error) })
    );
}, 1_000);
statusTimer.unref();

server.listen(config.consolePort ?? 7557, config.consoleHost ?? '127.0.0.1', () => {
  const address = `http://${config.consoleHost ?? '127.0.0.1'}:${config.consolePort ?? 7557}`;
  console.error(`Local Coder Console listening at ${address}`);
  if ((config.consoleHost ?? '127.0.0.1') !== '127.0.0.1' && (config.consoleHost ?? '') !== '::1') {
    console.error('WARNING: standalone console is not bound to loopback. Add an authentication layer before exposing it to a network.');
  }
});
