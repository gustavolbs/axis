import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

function source(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('Project Overview Chat uses the New Chat model catalog without requiring Connection-policy configuration', () => {
  const projectDetail = source('app/src/ProjectDetail.tsx');
  assert.doesNotMatch(projectDetail, /Configure a default Chat connection and model for this Project first/);
  assert.match(projectDetail, /api<\{ catalog: ProjectCatalog \}>\('\/api\/chat\/catalog'\)/);
  assert.doesNotMatch(projectDetail, /\/api\/projects\/\$\{encodeURIComponent\(props\.project\.id\)\}\/catalog/);
  assert.match(projectDetail, /modelSelection\s*\n\s*}/);
  assert.match(projectDetail, /className="model-effort-trigger"/);
  assert.match(projectDetail, /className="lc-agent-popover model-popover"/);
  assert.doesNotMatch(projectDetail, /Project model and connections|Model & connections|ProjectConnectionsPanel/);
});

test('Contexts expose create and delete workflows using the shell language', () => {
  const settings = source('app/src/CompaniesSettings.tsx');
  const hub = source('app/src/CompanyHub.tsx');
  const css = source('app/src/lc-base.css');

  assert.match(settings, /<h1>Contexts<\/h1>/);
  assert.match(settings, /Add context/);
  assert.match(settings, /Delete context/);
  assert.match(hub, /requestDeleteContext/);
  assert.match(hub, /Delete context/);
  assert.match(css, /content: 'New context'/);
  assert.match(css, /font-size: 12px/);
});

test('Company MCP inventory keeps search, add, logo, health and reconnect controls visible', () => {
  const hub = source('app/src/CompanyHub.tsx');
  const css = source('app/src/lc-base.css');

  assert.match(hub, /aria-label="Search MCPs"/);
  assert.match(hub, /Add MCP/);
  assert.match(hub, /company-mcp-logo/);
  assert.match(hub, /<Network size=\{17\}/);
  assert.match(hub, /company-mcp-status connected/);
  assert.match(hub, /company-mcp-status warning/);
  assert.match(hub, /Reconnect/);
  assert.match(css, /grid-template-columns: 36px minmax\(0, 1fr\) auto auto/);
});

test('Connection surfaces use one compact Axis button type scale', () => {
  const css = source('app/src/lc-base.css');
  assert.match(css, /\.connection-center-settings\.connections-settings-page button/);
  assert.match(css, /\.company-hub \.connection-center-settings button/);
  assert.match(css, /font-size: 11\.5px/);
});