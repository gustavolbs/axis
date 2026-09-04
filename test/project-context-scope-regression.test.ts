import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { DesktopAppRuntime } from '../src/app-runtime.js';
import { CompanyContextStore } from '../src/company-context.js';
import { CompanyScopedDesktopRuntime } from '../src/company-scoped-desktop-runtime.js';

test('Project creation is rewritten to the canonical active Context before it reaches ProjectStore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-context-'));
  const previousSettings = process.env.LOCAL_CODER_SETTINGS_PATH;
  const previousCompanies = process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH;
  process.env.LOCAL_CODER_SETTINGS_PATH = path.join(root, 'settings.json');
  process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH = path.join(root, 'companies.json');

  try {
    const companies = new CompanyContextStore(process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH);
    const context = companies.createCompany({ name: 'Local Coder' });
    let posted: Record<string, unknown> | undefined;

    const fake = {
      subscribe() { return () => {}; },
      async close() {},
      async request(request: { method?: string; path: string; body?: unknown }) {
        if (request.path === '/api/projects' && (request.method ?? 'GET').toUpperCase() === 'POST') {
          posted = request.body as Record<string, unknown>;
          return { project: { id: 'project-a', ...posted } };
        }
        throw new Error(`Unexpected request ${request.method ?? 'GET'} ${request.path}`);
      }
    } as unknown as DesktopAppRuntime;

    const runtime = new CompanyScopedDesktopRuntime(fake);
    await runtime.request({ method: 'PUT', path: '/api/companies/active', body: { companyId: context.id } });
    await runtime.request({
      method: 'POST',
      path: '/api/projects',
      body: {
        name: 'Axis',
        workspace: '/Users/example/WORK/axis',
        organizationId: 'personal',
        organizationName: 'Personal'
      }
    });

    assert.equal(posted?.organizationId, context.id);
    assert.equal(posted?.organizationName, 'Local Coder');
    assert.equal(posted?.workspace, '/Users/example/WORK/axis');
  } finally {
    if (previousSettings === undefined) delete process.env.LOCAL_CODER_SETTINGS_PATH;
    else process.env.LOCAL_CODER_SETTINGS_PATH = previousSettings;
    if (previousCompanies === undefined) delete process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH;
    else process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH = previousCompanies;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
