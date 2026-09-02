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
    'providerConnections', 'workHubSnapshot', 'upsertWorkHubSource', 'removeWorkHubSource', 'markWorkHubMessageRead', 'dismissWorkHubMessage', 'refreshWorkHub'
  ]) assert.match(preload, new RegExp(`\\b${method}\\b`));

  assert.doesNotMatch(preload, /setup-token|oauthToken|credentials\.json|Keychain/i);
  assert.doesNotMatch(preload, /invokeClaudeAccount|claudeAccountInvoke|invokeCodexAccount|codexAccountInvoke|spawn\(|exec\(/);
});

test('Settings exposes a first-class provider Connections page', () => {
  const settings = source('app/src/SettingsModal.tsx');
  const connections = source('app/src/ConnectionsSettings.tsx');
  const styles = source('app/src/lc-app.css');
  assert.match(settings, /ConnectionsSettings/);
  assert.match(settings, />Connections</);
  assert.match(connections, /Enterprise SSO/);
  assert.match(connections, /Device login/);
  assert.match(connections, /Search connectors/);
  assert.match(connections, /Add custom connector/);
  assert.match(connections, /Account-isolated and cached/);
  assert.match(connections, /nested-settings-dialog connection-create-dialog/);
  assert.doesNotMatch(connections, /<style>/);
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

test('Work Hub is shell-owned, capability-driven and uses the shared stylesheet', () => {
  const shell = source('app/src/AppRoot.tsx');
  const main = source('app/src/main.tsx');
  const hub = source('app/src/GlobalWorkHubLauncher.tsx');
  const runtime = source('src/work-hub.ts');
  const styles = source('app/src/lc-fixes.css');
  assert.match(shell, /GlobalWorkHubLauncher/);
  assert.match(shell, /surface === 'work-hub'/);
  assert.doesNotMatch(main, /GlobalWorkHubLauncher/);
  assert.match(hub, /Choose what to sync/);
  assert.match(hub, /Work board/);
  assert.match(hub, /work-hub-sync-banner/);
  assert.match(hub, /work-hub-week-grid/);
  assert.match(hub, /work-hub-calendar-join/);
  assert.match(hub, /work-hub-calendar-tooltip/);
  assert.match(hub, /calendarEventDetails/);
  assert.match(hub, /id: 'qa'/);
  assert.match(hub, /result\.setDate\(result\.getDate\(\) - day\)/);
  assert.match(hub, /work-hub-account-filter/);
  assert.match(hub, /accountClass\(item\.connectionId\)/);
  assert.match(hub, /prepareSourceForm/);
  assert.match(hub, /alreadyAdded \? ' added' : ''/);
  assert.match(hub, /hasCachedSnapshot/);
  assert.match(hub, /Checking connected services/);
  assert.match(hub, /The provider discovers its connected services automatically/);
  assert.match(hub, /work-hub-shell work-hub-page/);
  assert.doesNotMatch(hub, /work-hub-backdrop|aria-modal="true"|Close Work Hub/);
  assert.doesNotMatch(hub, /Exact read-only MCP tools|Remote system|Normalized-data retention|<style>/);
  assert.match(runtime, /does not require a manual tool allowlist/);
  assert.match(runtime, /Interactive user requests outside Work Hub may use write actions normally/);
  assert.match(styles, /\.work-hub-shell/);
  assert.match(styles, /\.work-hub-source-form/);
  assert.match(styles, /\.work-hub-board-column/);
  assert.match(styles, /\.work-hub-sync-banner/);
  assert.match(styles, /\.work-hub-now/);
  assert.match(styles, /\.work-hub-calendar-tooltip/);
  assert.match(styles, /\.work-hub-shell \.work-hub-calendar-join/);
  assert.match(styles, /\.work-hub-shell \.work-hub-calendar-today/);
  assert.match(styles, /\.work-hub-shell \.work-hub-icon-button/);
  assert.match(styles, /grid-template-columns: 52px repeat\(7, 168px\)/);
  assert.match(styles, /width: 1228px/);
  assert.match(styles, /height: 928px/);
  assert.match(styles, /\.work-hub-account-toggle/);
  assert.match(styles, /\.work-hub-source-form \.ui-select-trigger/);
  assert.match(styles, /\.settings-option-group > button\.added/);
  assert.match(styles, /\.account-tone-0/);
  assert.match(styles, /repeat\(6/);
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
