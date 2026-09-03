import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function source(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('desktop installs the bounded provider account bridge', () => {
  const main = source('desktop/main.mjs');
  assert.match(main, /installClaudeAccountBridge/);
  assert.match(main, /\.\/claude-accounts\.mjs/);
});

test('preload exposes bounded connection and Work Hub actions without generic account execution', () => {
  const preload = source('desktop/preload.cjs');
  for (const method of [
    'claudeDiscover', 'claudeAccounts', 'createClaudeAccount', 'claudeAccountStatus', 'loginClaudeAccount', 'listClaudeAccountMcps', 'addClaudeAccountMcp', 'removeClaudeAccountMcp', 'loginClaudeAccountMcp',
    'codexDiscover', 'codexAccounts', 'createCodexAccount', 'codexAccountStatus', 'loginCodexAccount', 'listCodexAccountMcps', 'addCodexAccountMcp', 'removeCodexAccountMcp', 'loginCodexAccountMcp',
    'providerConnections', 'createApiKeyConnection', 'workHubSnapshot', 'upsertWorkHubSource', 'removeWorkHubSource', 'markWorkHubMessageRead', 'dismissWorkHubMessage', 'refreshWorkHub'
  ]) assert.match(preload, new RegExp(`\\b${method}\\b`));

  assert.doesNotMatch(preload, /setup-token|oauthToken|credentials\.json|Keychain/i);
  assert.doesNotMatch(preload, /invokeClaudeAccount|claudeAccountInvoke|invokeCodexAccount|codexAccountInvoke|spawn\(|exec\(/);
});

test('Company Hub owns Connections and Work Hub source administration while global Settings stays app-wide', () => {
  const settings = source('app/src/SettingsModal.tsx');
  const hub = source('app/src/CompanyHub.tsx');
  const companySources = source('app/src/CompanySourcesSettings.tsx');
  const entry = source('app/src/ConnectionsSettings.tsx');
  const center = source('app/src/ConnectionCenterSettings.tsx');
  const legacyEntry = source('app/src/LegacyConnectionsSettings.tsx');
  const connectors = source('app/src/ConnectionConnectorsPanel.tsx');
  const styles = source('app/src/lc-app.css');

  assert.doesNotMatch(settings, /ConnectionsSettings|CompaniesSettings/);
  assert.match(hub, /ConnectionCenterSettings companyId=\{company\.id\}/);
  assert.match(hub, /CompanySourcesSettings companyId=\{company\.id\}/);
  assert.match(entry, /ConnectionCenterSettings as ConnectionsSettings/);

  assert.match(center, /Add connection/);
  assert.match(center, /OpenAI API key/);
  assert.match(center, /Anthropic API key/);
  assert.match(center, /fixedCompanyId/);
  assert.match(center, /connection\.companyId !== fixedCompanyId/);
  assert.match(center, /Managed restrictions/);
  assert.match(center, /createApiKeyConnection/);

  // Source CRUD is Company-owned. The selected connection is checked against
  // the selected Company before any source is created, refreshed or removed.
  assert.match(companySources, /connection\.companyId !== companyId/);
  assert.match(companySources, /source\.companyId !== companyId/);
  assert.match(companySources, /upsertWorkHubSource/);
  assert.match(companySources, /removeWorkHubSource/);
  assert.match(companySources, /Work Hub sources/);
  assert.match(companySources, /Source ownership stays here/);

  assert.match(legacyEntry, /ConnectionConnectorsPanel as ConnectionsSettings/);
  assert.match(connectors, /Search connectors/);
  assert.match(connectors, /Add custom connector/);
  assert.match(connectors, /Company-owned account tools/);
  assert.match(connectors, /Provider-managed connectors remain read-only/);
  assert.match(connectors, /nested-settings-dialog connection-create-dialog connector-create-dialog/);
  assert.doesNotMatch(connectors, /<h1>Connections<\/h1>|connections-surface-tabs|<style>/);
  assert.doesNotMatch(center, /<style>/);
  assert.doesNotMatch(companySources, /<style>/);

  for (const selector of [
    '.connections-settings-page',
    '.connections-runtime-grid',
    '.connection-card-main',
    '.connector-table',
    '.connector-search',
    '.connection-create-dialog'
  ]) assert.match(styles, new RegExp(selector.replace('.', '\\.')));
});

test('desktop account IPC delegates auth and MCP discovery to official runtime abstractions', () => {
  const bridge = source('desktop/claude-accounts.mjs');
  assert.match(bridge, /ClaudeAccountProfileStore/);
  assert.match(bridge, /ClaudeAccountRuntime/);
  assert.match(bridge, /CodexAccountProfileStore/);
  assert.match(bridge, /CodexAccountRuntime/);
  assert.match(bridge, /\.login\(/);
  assert.match(bridge, /\.status\(/);
  assert.match(bridge, /\.listMcp\(/);
  assert.match(bridge, /mcpDiscoveryCache = new Map/);
  assert.match(bridge, /refresh !== true && mcpDiscoveryCache\.has/);
  assert.match(bridge, /invalidateMcpCache/);
  assert.doesNotMatch(bridge, /spawn\(|exec\(|setup-token|cookie|credentials\.json/i);
});

test('Work Hub is one global Company-aware aggregate and Sources is read-only there', () => {
  const shell = source('app/src/AppRoot.tsx');
  const main = source('app/src/main.tsx');
  const hub = source('app/src/GlobalWorkHubLauncher.tsx');
  const companyHub = source('app/src/CompanyHub.tsx');
  const companySources = source('app/src/CompanySourcesSettings.tsx');
  const provenance = source('src/work-hub-company-provenance.ts');
  const bootstrap = source('desktop/bootstrap.mjs');
  const runtime = source('src/work-hub.ts');
  const styles = source('app/src/lc-fixes.css');

  assert.match(shell, /GlobalWorkHubLauncher/);
  assert.match(shell, /surface === 'work-hub'/);
  assert.match(shell, /local-coder\.work-hub-company-filter/);
  assert.doesNotMatch(main, /GlobalWorkHubLauncher/);
  assert.match(companyHub, /Open in Work Hub/);

  // The global rail remains unique and keeps the approved operational sections.
  for (const label of ['Inbox', 'My Work', 'Today', 'Calendar', 'Sources']) assert.match(hub, new RegExp(`'${label}'|>${label}<`));
  assert.match(hub, /Filter Work Hub by Company/);
  assert.match(hub, />All<\/button>/);
  assert.match(hub, /data-company-id=\{company\.id\}/);
  assert.match(hub, /companyName/);
  assert.match(hub, /companyId/);
  assert.match(hub, /connectionId/);
  assert.match(hub, /sourceId/);
  assert.match(hub, /CompanyBadge/);
  assert.match(hub, /work-hub-shell work-hub-page/);
  assert.match(hub, /Aggregation and sync health/);
  assert.match(hub, /Configure sources inside the owning Company/);
  assert.doesNotMatch(hub, /upsertWorkHubSource|removeWorkHubSource|prepareSourceForm|Choose what to sync/);
  assert.match(companySources, /upsertWorkHubSource/);
  assert.match(companySources, /removeWorkHubSource/);

  // Company provenance is projected from canonical connection ownership at the
  // desktop boundary; mutable provider labels never become an ownership source.
  assert.match(provenance, /attachWorkHubCompanyProvenance/);
  assert.match(provenance, /companyId/);
  assert.match(provenance, /companyName/);
  assert.match(provenance, /has no canonical Company owner/);
  assert.match(bootstrap, /installWorkHubCompanyProvenance/);

  assert.match(hub, /work-hub-sync-banner/);
  assert.match(hub, /id: 'qa'/);
  assert.match(hub, /work-hub-account-filter/);
  assert.match(hub, /hasCachedSnapshot/);
  assert.match(hub, /Checking connected services/);
  assert.doesNotMatch(hub, /work-hub-backdrop|aria-modal="true"|Close Work Hub|<style>/);
  assert.match(runtime, /does not require a manual tool allowlist/);
  assert.match(runtime, /Interactive user requests outside Work Hub may use write actions normally/);
  assert.match(styles, /\.work-hub-shell/);
  assert.match(styles, /\.work-hub-board-column/);
  assert.match(styles, /\.work-hub-sync-banner/);
  assert.match(styles, /\.work-hub-account-toggle/);
  assert.match(styles, /\.account-tone-0/);
  assert.match(runtime, /stopOnValidJson: true/);
  assert.doesNotMatch(source('desktop/preload.cjs'), /workHubPrompt|runWorkHubPrompt/);
});

test('subscription account Chat can use account-scoped MCP tools including requested writes', () => {
  const connections = source('src/provider-connections.ts');
  assert.match(connections, /toolUse: true/);
  assert.match(connections, /allowedTools: \['mcp__\*'\]/);
  assert.match(connections, /Read or mutate remote data when the user explicitly asks/);
  assert.match(connections, /creating or updating tickets, calendar events, messages/);
  assert.doesNotMatch(connections, /does not expose external capabilities/);
});
