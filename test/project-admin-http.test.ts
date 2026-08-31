import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';

import { handleProjectAdminRequest } from '../src/project-admin-http.js';
import type { ProjectAdminService } from '../src/project-admin.js';

class ResponseCapture {
  status?: number;
  body = '';

  writeHead(status: number): this {
    this.status = status;
    return this;
  }

  end(body?: string | Buffer): this {
    if (body !== undefined) this.body += body.toString();
    return this;
  }
}

function request(input: {
  url: string;
  method?: string;
  remoteAddress?: string;
  origin?: string;
}): IncomingMessage {
  return {
    url: input.url,
    method: input.method ?? 'GET',
    headers: input.origin ? { origin: input.origin } : {},
    socket: { remoteAddress: input.remoteAddress ?? '127.0.0.1' }
  } as unknown as IncomingMessage;
}

function admin(): ProjectAdminService {
  return {
    listProjects: () => []
  } as unknown as ProjectAdminService;
}

test('administrative APIs reject non-loopback clients before touching stores', async () => {
  const response = new ResponseCapture();
  const handled = await handleProjectAdminRequest(
    request({ url: '/api/projects', remoteAddress: '10.0.0.24' }),
    response as unknown as ServerResponse,
    admin()
  );

  assert.equal(handled, true);
  assert.equal(response.status, 403);
  assert.match(response.body, /restricted to loopback clients/);
});

test('mutating administrative APIs reject browser origins outside literal loopback', async () => {
  for (const origin of ['https://evil.example', 'https://127.0.0.1.evil.example']) {
    const response = new ResponseCapture();
    const handled = await handleProjectAdminRequest(
      request({
        url: '/api/projects',
        method: 'POST',
        remoteAddress: '127.0.0.1',
        origin
      }),
      response as unknown as ServerResponse,
      admin()
    );

    assert.equal(handled, true);
    assert.equal(response.status, 403, origin);
  }
});

test('loopback clients can read administrative APIs and unrelated paths remain untouched', async () => {
  const response = new ResponseCapture();
  const handled = await handleProjectAdminRequest(
    request({ url: '/api/projects', remoteAddress: '::1' }),
    response as unknown as ServerResponse,
    admin()
  );

  assert.equal(handled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { projects: [] });

  const unrelated = new ResponseCapture();
  const unrelatedHandled = await handleProjectAdminRequest(
    request({ url: '/api/jobs', remoteAddress: '10.0.0.24' }),
    unrelated as unknown as ServerResponse,
    admin()
  );
  assert.equal(unrelatedHandled, false);
  assert.equal(unrelated.status, undefined);
});
