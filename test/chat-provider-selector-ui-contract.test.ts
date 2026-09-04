import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const surface = read('app/src/AgentSurfaceV2.tsx');
const baseCss = read('app/src/lc-base.css');

test('chat provider selector is Connections -> Models with explicit auth badges', () => {
  assert.match(surface, /type ModelMenuView = 'closed' \| 'providers' \| 'models' \| 'legacy-models' \| 'effort'/);
  assert.match(surface, /modelMenu === 'closed' \? 'providers' : 'closed'/);
  assert.match(surface, /<div className="model-provider-label">Connections<\/div>/);
  assert.match(surface, /setBrowsingMode\(mode\.id\);[\s\S]{0,120}props\.setModelMenu\('models'\)/);
  assert.match(surface, /<strong>\{legacy \? moreCopy\.title : 'Models'\}<\/strong>/);
  assert.match(surface, /props\.setModelMenu\(legacy \? 'models' : 'providers'\)/);

  assert.match(surface, /if \(provider\.auth === 'api-key'\) return 'API KEY'/);
  assert.match(surface, /provider\.auth === 'claude-account' \|\| provider\.auth === 'chatgpt-account'/);
  assert.match(surface, /return 'ACCOUNT'/);
  assert.match(surface, /if \(provider\.auth === 'local' \|\| provider\.kind === 'local'\) return 'LOCAL'/);

  assert.match(surface, /className=\{`model-auth-badge status-pill /);
  assert.match(surface, /mode\.authKind === 'api-key' \? 'live'/);
  assert.match(surface, /mode\.authKind === 'local' \? 'good'/);
  assert.match(surface, /mode\.authKind === 'claude-account' \|\| mode\.authKind === 'chatgpt-account' \? 'warn'/);
  assert.doesNotMatch(surface, /authBadgeStyle/);
  assert.doesNotMatch(surface, /style=\{authBadgeStyle/);

  for (const variant of ['live', 'warn', 'good']) {
    assert.match(baseCss, new RegExp(`\\.status-pill\\.${variant}\\s*\\{`), `missing status-pill.${variant}`);
    assert.match(
      baseCss,
      new RegExp(`\\.status-pill\\.model-auth-badge\\.${variant}\\s*\\{[\\s\\S]*?background:[^;]+!important;[\\s\\S]*?color:[^;]+!important;`),
      `model auth badge ${variant} must override the later neutral status-pill rule with a semantic color`
    );
  }
});

test('chat provider selector keeps friendly connection names and normalized model copy', () => {
  assert.match(surface, /function connectionDisplayName\(provider: CatalogProvider\)/);
  assert.ok(surface.includes(".replace(/^API Key\\s*·\\s*/i, '')"), 'API Key prefix must be stripped from the friendly connection name');
  assert.ok(surface.includes(".replace(/^Account\\s*·\\s*(?:Claude|ChatGPT)\\s*·\\s*/i, '')"), 'Account/provider prefix must be stripped from the friendly connection name');
  assert.match(surface, /label: connectionDisplayName\(provider\)/);

  for (const copy of [
    "Uses this account's default model",
    'Faster for quick responses',
    'For complex tasks',
    'Efficient for everyday tasks'
  ]) {
    assert.ok(surface.includes(copy), `missing model copy: ${copy}`);
  }
});
