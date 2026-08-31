import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CredentialManager, CredentialProfileStore } from '../src/credential-store.js';
import { ProjectAdminService } from '../src/project-admin.js';
import { ProjectStore } from '../src/project-store.js';
import type { SecretStore } from '../src/secret-store.js';

class MemorySecretStore implements SecretStore {
  readonly backend = 'macos-keychain' as const;
  readonly values = new Map<string, string>();
  isAvailable(): boolean { return true; }
  get(id: string): string | undefined { return this.values.get(id); }
  set(id: string, value: string): void { this.values.set(id, value); }
  delete(id: string): boolean { return this.values.delete(id); }
}

test('credential replacement preserves Project isolation and secret backend ownership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-admin-credential-'));
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  const keychain = new MemorySecretStore();
  const credentials = new CredentialManager(
    new CredentialProfileStore(path.join(root, 'credentials.json')),
    { keychain }
  );
  const admin = new ProjectAdminService({ projects, credentials });

  admin.createCredential({
    backend: 'macos-keychain',
    id: 'shared-id',
    providerId: 'anthropic',
    label: 'Company A',
    organizationId: 'company-a',
    secret: 'original-secret'
  });
  admin.createProject({
    id: 'company-a-project',
    name: 'Company A Project',
    workspace: path.join(root, 'repo'),
    organizationId: 'company-a',
    privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic'] },
    credentialProfileIds: { anthropic: 'shared-id' }
  });

  assert.throws(
    () => admin.createCredential({
      backend: 'macos-keychain',
      id: 'shared-id',
      providerId: 'anthropic',
      label: 'Company B',
      organizationId: 'company-b',
      secret: 'replacement-secret'
    }),
    /cannot be moved outside that organization/
  );

  assert.throws(
    () => admin.createCredential({
      backend: 'environment',
      id: 'shared-id',
      providerId: 'anthropic',
      label: 'Company A Env',
      organizationId: 'company-a',
      environmentVariable: 'COMPANY_A_ANTHROPIC_KEY'
    }),
    /remove it before changing secret backends/
  );

  assert.equal(credentials.getProfile('shared-id')?.organizationId, 'company-a');
  assert.equal(credentials.getProfile('shared-id')?.secret.backend, 'macos-keychain');
  assert.equal(credentials.resolve('shared-id'), 'original-secret');
});
