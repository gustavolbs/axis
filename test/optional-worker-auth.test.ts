import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../src/remote-protocol.js';
import { RemoteWorkerClient } from '../src/remote-worker-client.js';

async function listen(server: http.Server): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return server.address() as AddressInfo;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('remote execution config permits a worker URL without a token', () => {
  const config = loadConfig({
    LOCAL_CODER_EXECUTION_MODE: 'remote',
    LOCAL_CODER_REMOTE_WORKER_URL: 'http://127.0.0.1:7337'
  });

  assert.equal(config.executionMode, 'remote');
  assert.equal(config.remoteWorkerUrl, 'http://127.0.0.1:7337');
  assert.equal(config.remoteWorkerToken, undefined);
});

test('remote worker client omits Authorization when no token is configured', async () => {
  let authorization: string | undefined;
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerVersion: 'test',
      ok: true,
      hostname: 'test-worker',
      platform: process.platform,
      model: 'qwen-test',
      bootstrap: 'none',
      ollama: { ok: true }
    }));
  });

  const address = await listen(server);
  try {
    const config = loadConfig({
      LOCAL_CODER_EXECUTION_MODE: 'remote',
      LOCAL_CODER_REMOTE_WORKER_URL: `http://127.0.0.1:${address.port}`,
      LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS: '5000'
    });
    const client = new RemoteWorkerClient(config);
    const health = await client.health();

    assert.equal(health.ok, true);
    assert.equal(authorization, undefined);
  } finally {
    await close(server);
  }
});

test('remote worker client still sends Bearer auth when a token is configured', async () => {
  let authorization: string | undefined;
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerVersion: 'test',
      ok: true,
      hostname: 'test-worker',
      platform: process.platform,
      model: 'qwen-test',
      bootstrap: 'none',
      ollama: { ok: true }
    }));
  });

  const address = await listen(server);
  try {
    const config = loadConfig({
      LOCAL_CODER_EXECUTION_MODE: 'remote',
      LOCAL_CODER_REMOTE_WORKER_URL: `http://127.0.0.1:${address.port}`,
      LOCAL_CODER_REMOTE_WORKER_TOKEN: 'optional-secret',
      LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS: '5000'
    });
    const client = new RemoteWorkerClient(config);
    await client.health();

    assert.equal(authorization, 'Bearer optional-secret');
  } finally {
    await close(server);
  }
});
