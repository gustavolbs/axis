import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProviderSettingsStore } from '../src/provider-settings.js';

function temp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `local-coder-${name}-`));
}

test('provider default model can be cleared back to Auto without deleting model profiles', () => {
  const root = temp('provider-settings-clear');
  const file = path.join(root, 'providers.json');
  const store = new ProviderSettingsStore(file);

  store.update('anthropic', {
    defaultModelId: 'cloud-fast',
    models: {
      'cloud-fast': { frontier: true, qualityScore: 92 },
      'cloud-deep': { frontier: true, qualityScore: 97 }
    }
  });

  const cleared = store.update('anthropic', { defaultModelId: null });
  assert.equal(cleared.defaultModelId, undefined);
  assert.equal(cleared.models['cloud-fast']?.qualityScore, 92);
  assert.equal(cleared.models['cloud-deep']?.qualityScore, 97);

  const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    providers: Record<string, { defaultModelId?: string }>;
  };
  assert.equal('defaultModelId' in persisted.providers.anthropic!, false);
});
