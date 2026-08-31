import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PricingStore } from '../src/pricing-store.js';
import { ProjectAdminService } from '../src/project-admin.js';
import { ProjectStore } from '../src/project-store.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import { UsageLedger } from '../src/usage-ledger.js';

test('pricing cannot change while the same provider/model has an active budget reservation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-admin-pricing-'));
  const pricing = new PricingStore(path.join(root, 'pricing.json'));
  const ledger = new UsageLedger(path.join(root, 'usage'));
  const admin = new ProjectAdminService({
    projects: new ProjectStore(path.join(root, 'projects.json')),
    providerSettings: new ProviderSettingsStore(path.join(root, 'providers.json')),
    pricing,
    ledger
  });

  await admin.setPricing('anthropic', 'claude-model', {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 5,
    source: 'initial'
  });
  const now = new Date();
  ledger.reserve({
    id: 'active-pricing-reservation',
    jobId: 'job-one',
    timestamp: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    projectId: 'project-one',
    organizationId: 'company-a',
    providerId: 'anthropic',
    modelId: 'claude-model',
    upperBoundCostUsd: 0.1
  });

  await assert.rejects(
    admin.setPricing('anthropic', 'claude-model', {
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 10,
      source: 'replacement'
    }),
    /cannot change while 1 budget reservation\(s\) are active/
  );
  await assert.rejects(
    admin.removePricing('anthropic', 'claude-model'),
    /cannot change while 1 budget reservation\(s\) are active/
  );
  assert.equal(pricing.get('anthropic', 'claude-model')?.source, 'initial');

  assert.equal(ledger.releaseReservation('active-pricing-reservation'), true);
  const updated = await admin.setPricing('anthropic', 'claude-model', {
    inputPerMillionUsd: 2,
    outputPerMillionUsd: 10,
    source: 'replacement'
  });
  assert.equal(updated.source, 'replacement');
});
