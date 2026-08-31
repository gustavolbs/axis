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
  const config = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8'));
  const env = config?.mcpServers?.['local-coder']?.env ?? {};
  const workerUrl = env.LOCAL_CODER_REMOTE_WORKER_URL;
  const token = env.LOCAL_CODER_REMOTE_WORKER_TOKEN;
  if (!workerUrl || !token) {
    throw new Error(
      'local-coder is not configured in strict remote-worker mode in ~/.claude.json.'
    );
  }
  return { workerUrl: String(workerUrl).replace(/\/$/, ''), token: String(token) };
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
      .filter((event) => ['engineering', 'execution', 'orchestration'].includes(event.kind))
      .slice(-limit)
      .reverse();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function statusPayload() {
  const { workerUrl, token } = await loadConnection();
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
      workerUrl
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
      'cache-control': path.extname(absolute) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      'content-length': content.byteLength
    });
    response.end(content);
  } catch (error) {
    if (error?.code === 'ENOENT' && !path.extname(relative)) {
      const content = await fs.readFile(path.join(dashboardDist, 'index.html'));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
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
    if (request.method === 'GET') {
      await sendStatic(request, response);
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  })().catch((error) => {
    if (!response.headersSent) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    } else {
      response.destroy();
    }
  });
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`Local Coder dashboard: ${url}`);
  console.log(
    'The dashboard binds to Mac loopback only; the worker bearer token is never sent to the browser.'
  );
  if (process.platform === 'darwin' && !process.argv.includes('--no-open')) {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
});
