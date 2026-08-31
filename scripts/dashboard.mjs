import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot = path.resolve(import.meta.dirname, '..');
const dashboardDist = path.join(projectRoot, 'dashboard', 'dist');
const host = process.env.LOCAL_CODER_DASHBOARD_HOST ?? '127.0.0.1';
const port = Number(process.env.LOCAL_CODER_DASHBOARD_PORT ?? '7447');
const claudeConfigPath =
  process.env.LOCAL_CODER_CLAUDE_CONFIG_PATH ?? path.join(os.homedir(), '.claude.json');
const telemetryPath =
  process.env.LOCAL_CODER_TELEMETRY_PATH ??
  path.join(os.homedir(), '.local-coder-mcp', 'telemetry.jsonl');
const statusStreamIntervalMs = Math.max(
  500,
  Number(process.env.LOCAL_CODER_DASHBOARD_STREAM_INTERVAL_MS ?? '1200')
);

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon']
]);

async function loadConnection() {
  const explicitWorkerUrl = process.env.LOCAL_CODER_DASHBOARD_WORKER_URL?.trim();
  const explicitToken =
    process.env.LOCAL_CODER_DASHBOARD_WORKER_TOKEN?.trim() ||
    process.env.LOCAL_CODER_WORKER_TOKEN?.trim();

  if (explicitWorkerUrl && explicitToken) {
    return {
      workerUrl: explicitWorkerUrl.replace(/\/$/, ''),
      token: explicitToken,
      mode: 'execution-host'
    };
  }

  // When the dashboard runs on the Windows execution host, prefer the worker's
  // loopback endpoint. This keeps telemetry traffic local to the machine and lets
  // the Mac act only as the browser/client over Meshnet.
  if (process.platform === 'win32' && explicitToken) {
    const workerPort = Number(process.env.LOCAL_CODER_WORKER_PORT ?? '7337');
    return {
      workerUrl: `http://127.0.0.1:${workerPort}`,
      token: explicitToken,
      mode: 'execution-host'
    };
  }

  const config = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8'));
  const env = config?.mcpServers?.['local-coder']?.env ?? {};
  const workerUrl = env.LOCAL_CODER_REMOTE_WORKER_URL;
  const token = env.LOCAL_CODER_REMOTE_WORKER_TOKEN;
  if (!workerUrl || !token) {
    throw new Error(
      'No dashboard worker connection found. Configure LOCAL_CODER_DASHBOARD_WORKER_URL + token, or strict remote-worker mode in ~/.claude.json.'
    );
  }
  return {
    workerUrl: String(workerUrl).replace(/\/$/, ''),
    token: String(token),
    mode: 'mac-proxy'
  };
}

async function recentTelemetry(limit = 30) {
  try {
    const raw = await fs.readFile(telemetryPath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-800)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .filter((event) => ['engineering', 'execution', 'orchestration', 'inference'].includes(event.kind))
      .slice(-limit)
      .reverse();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function workerGet(pathname) {
  const { workerUrl, token } = await loadConnection();
  const response = await fetch(workerUrl + pathname, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? ('Worker returned HTTP ' + response.status));
  return body;
}

async function statusPayload() {
  const { workerUrl, token, mode } = await loadConnection();
  const response = await fetch(`${workerUrl}/v1/status`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? `Worker returned HTTP ${response.status}`);
  return {
    ...body,
    controlPlane: {
      hostname: os.hostname(),
      platform: process.platform,
      dashboardPid: process.pid,
      workerUrl,
      mode,
      transport: 'sse'
    },
    recentTelemetry: await recentTelemetry()
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

function sseEvent(response, event, value) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function streamStatus(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  response.flushHeaders?.();
  response.write('retry: 1500\n\n');

  let closed = false;
  let inFlight = false;
  let lastHeartbeatAt = 0;

  const push = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      sseEvent(response, 'status', await statusPayload());
    } catch (error) {
      sseEvent(response, 'status-error', {
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString()
      });
    } finally {
      inFlight = false;
    }

    const now = Date.now();
    if (!closed && now - lastHeartbeatAt >= 15_000) {
      lastHeartbeatAt = now;
      response.write(`: heartbeat ${new Date(now).toISOString()}\n\n`);
    }
  };

  void push();
  const timer = setInterval(() => void push(), statusStreamIntervalMs);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (!response.writableEnded) response.end();
  };
  request.on('close', close);
  request.on('aborted', close);
}

async function sendStatic(request, response) {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const relative = decodeURIComponent(requestPath).replace(/^\/+/, '');
  const absolute = path.resolve(dashboardDist, relative);
  if (absolute !== dashboardDist && !absolute.startsWith(`${dashboardDist}${path.sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(absolute);
    response.writeHead(200, {
      'content-type': contentTypes.get(path.extname(absolute)) ?? 'application/octet-stream',
      'cache-control':
        path.extname(absolute) === '.html'
          ? 'no-store'
          : 'public, max-age=31536000, immutable',
      'content-length': content.byteLength
    });
    response.end(content);
  } catch (error) {
    if (error?.code === 'ENOENT' && !path.extname(relative)) {
      const content = await fs.readFile(path.join(dashboardDist, 'index.html'));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(content);
      return;
    }
    if (error?.code === 'ENOENT') {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    throw error;
  }
}

const server = http.createServer((request, response) => {
  void (async () => {
    if (request.method === 'GET' && request.url === '/api/events') {
      streamStatus(request, response);
      return;
    }
    if (request.method === 'GET' && request.url === '/api/status') {
      try {
        sendJson(response, 200, await statusPayload());
      } catch (error) {
        sendJson(response, 503, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/history')) {
      try {
        const url = new URL(request.url, `http://${host}:${port}`);
        const suffix = url.pathname.slice('/api/history'.length);
        if (suffix && !/^\/[A-Za-z0-9-]{1,100}$/.test(suffix)) {
          sendJson(response, 400, { error: 'Invalid history id.' });
          return;
        }
        sendJson(response, 200, await workerGet('/v1/history' + suffix + url.search));
      } catch (error) {
        sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'GET') {
      await sendStatic(request, response);
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  })().catch((error) => {
    if (!response.headersSent) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    } else {
      response.destroy();
    }
  });
});

// SSE responses are intentionally long-lived. There is no request body to time out.
server.requestTimeout = 0;

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`Local Coder dashboard: ${url}`);
  console.log(`Live dashboard stream: ${url}/api/events (${statusStreamIntervalMs}ms cadence)`);
  console.log(
    process.platform === 'win32'
      ? 'Dashboard is running on the Windows execution host. Restrict inbound access with the Meshnet firewall rule.'
      : 'Dashboard is running on the Mac control plane; the worker bearer token is never sent to browser JavaScript.'
  );
  if (process.platform === 'darwin' && !process.argv.includes('--no-open')) {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
});
