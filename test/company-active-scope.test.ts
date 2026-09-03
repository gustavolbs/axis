import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ActiveCompanyScope } from '../src/active-company-scope.js';
import { CompanyContextStore, PERSONAL_COMPANY_ID } from '../src/company-context.js';
import { CompanyScopedDesktopRuntime } from '../src/company-scoped-desktop-runtime.js';
import type { DesktopAppRuntime } from '../src/app-runtime.js';

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withPaths<T>(run: (companyFile: string) => T): T {
  const root = temp('axis-active-company-');
  const previousSettings = process.env.LOCAL_CODER_SETTINGS_PATH;
  const previousCompanies = process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH;
  process.env.LOCAL_CODER_SETTINGS_PATH = path.join(root, 'settings.json');
  process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH = path.join(root, 'companies.json');
  try { return run(process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH); }
  finally {
    if (previousSettings === undefined) delete process.env.LOCAL_CODER_SETTINGS_PATH;
    else process.env.LOCAL_CODER_SETTINGS_PATH = previousSettings;
    if (previousCompanies === undefined) delete process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH;
    else process.env.LOCAL_CODER_COMPANY_CONTEXT_PATH = previousCompanies;
  }
}

test('active Company is explicit, persisted, validated and falls back when archived', () => withPaths((companyFile) => {
  const companies = new CompanyContextStore(companyFile);
  const acme = companies.createCompany({ name: 'Acme', color: '#2563EB' });
  const active = new ActiveCompanyScope(companies);

  assert.equal(active.snapshot().activeCompanyId, PERSONAL_COMPANY_ID);
  assert.deepEqual(active.snapshot().companies.map((item) => item.name), ['Personal', 'Acme']);
  assert.equal(active.set(acme.id).activeCompanyId, acme.id);
  assert.equal(new ActiveCompanyScope(companies).currentId(), acme.id);

  companies.setCompanyArchived(acme.id, true);
  assert.equal(active.currentId(), PERSONAL_COMPANY_ID);
  assert.rejects(async () => active.set(acme.id), /archived/);
}));

test('desktop runtime filters projects and jobs by active Company and blocks cross-company actions', async () => {
  await withPaths(async (companyFile) => {
    const companies = new CompanyContextStore(companyFile);
    const acme = companies.createCompany({ name: 'Acme', color: '#2563EB' });
    const projects = [
      { id: 'personal-project', name: 'Personal Project', organizationId: PERSONAL_COMPANY_ID },
      { id: 'acme-project', name: 'Acme Project', organizationId: acme.id }
    ];
    const jobs = [
      { id: 'personal-job', input: { companyId: PERSONAL_COMPANY_ID, goal: 'Personal' } },
      { id: 'acme-job', input: { companyId: acme.id, projectId: 'acme-project', goal: 'Acme' } }
    ];
    const posted: unknown[] = [];
    const fake = {
      subscribe() { return () => {}; },
      async close() {},
      async request(request: { method?: string; path: string; body?: unknown }) {
        const method = (request.method ?? 'GET').toUpperCase();
        if (request.path === '/api/projects' && method === 'GET') return { projects };
        if (request.path === '/api/jobs' && method === 'GET') return { jobs };
        if (request.path === '/api/jobs' && method === 'POST') { posted.push(request.body); return { job: jobs[1] }; }
        const projectId = /^\/api\/projects\/([^/]+)/.exec(request.path)?.[1];
        if (projectId) return { project: projects.find((item) => item.id === projectId) };
        const jobId = /^\/api\/jobs\/([^/]+)/.exec(request.path)?.[1];
        if (jobId) return { job: jobs.find((item) => item.id === jobId) };
        throw new Error(`Unexpected request ${method} ${request.path}`);
      }
    } as unknown as DesktopAppRuntime;
    const runtime = new CompanyScopedDesktopRuntime(fake);

    assert.deepEqual(((await runtime.request({ path: '/api/projects' })) as { projects: Array<{ id: string }> }).projects.map((item) => item.id), ['personal-project']);
    await runtime.request({ method: 'PUT', path: '/api/companies/active', body: { companyId: acme.id } });
    assert.deepEqual(((await runtime.request({ path: '/api/projects' })) as { projects: Array<{ id: string }> }).projects.map((item) => item.id), ['acme-project']);
    assert.deepEqual(((await runtime.request({ path: '/api/jobs' })) as { jobs: Array<{ id: string }> }).jobs.map((item) => item.id), ['acme-job']);

    await assert.rejects(() => runtime.request({ method: 'POST', path: '/api/jobs', body: { goal: 'No project' } }), /Select a Project/);
    await assert.rejects(() => runtime.request({ path: '/api/jobs/personal-job' }), /does not belong to active Company/);
    await assert.rejects(() => runtime.request({ method: 'POST', path: '/api/jobs', body: { goal: 'Wrong', projectId: 'personal-project' } }), /belongs to Company/);
    await runtime.request({ method: 'POST', path: '/api/jobs', body: { goal: 'Right', projectId: 'acme-project' } });
    assert.equal(posted.length, 1);
  });
});

test('Company selector is rendered in chrome, composer, approvals and results and switches explicitly', () => {
  const source = fs.readFileSync('app/src/main.tsx', 'utf8');
  assert.match(source, /chrome: document\.querySelector<HTMLElement>\('\.lc-shell-window-chrome'\)/);
  assert.match(source, /composer: document\.querySelector<HTMLElement>\('\.composer-toolbar-left'\)/);
  assert.match(source, /approval: document\.querySelector<HTMLElement>\('\.decision-picker-head'\)/);
  assert.match(source, /result: lastElement\('\.lc-agent-thread \.assistant-result-message'\)/);
  assert.match(source, /fetch\('\/api\/companies\/active', \{\s*method: 'PUT'/);
  assert.match(source, /window\.location\.reload\(\)/);
  assert.match(source, /localStorage\.removeItem\('local-coder\.open-job'\)/);
});
