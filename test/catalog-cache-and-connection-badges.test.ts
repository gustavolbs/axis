import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function read(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
}

test('connection pickers render the semantic auth badge and a description on both surfaces', () => {
  const surface = read('app/src/AgentSurfaceV2.tsx');
  assert.match(surface, /className=\{`model-auth-badge status-pill /);
  assert.match(surface, /<small>\{mode\.description\}/);

  const detail = read('app/src/ProjectDetail.tsx');
  assert.match(detail, /providerAuthBadgeClass\(provider\)/);
  assert.match(detail, /model-auth-badge status-pill/);
  assert.match(detail, /<small>\{providerDescription\(provider\)\}/);
  assert.doesNotMatch(detail, /<em>\{providerAuthLabel\(provider\)\}<\/em>/);
  assert.doesNotMatch(detail, /<em>Local<\/em>/);
});

test('chat and Project catalogs are served from a TTL cache that in-app mutations invalidate', () => {
  const runtime = read('src/app-runtime.ts');
  assert.match(runtime, /const CATALOG_CACHE_TTL_MS = /);
  assert.match(runtime, /cachedCatalog\('personal', \(\) => this\.personalProviders\.personalChatCatalog\(\)\)/);
  assert.match(runtime, /cachedCatalog\(`project:\$\{projectId\}`, \(\) => this\.projects\.catalog\(projectId\)\)/);
  assert.match(runtime, /if \(method !== 'GET'\) this\.catalogCache\.clear\(\);/);
});
