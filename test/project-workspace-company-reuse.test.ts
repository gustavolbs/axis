import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProjectStore, projectIsolationKey } from '../src/project-store.js';

test('the same physical workspace can be reused by isolated Projects in different Contexts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-workspace-reuse-'));
  const file = path.join(root, 'projects.json');
  const workspace = path.join(root, 'repo');
  fs.mkdirSync(workspace);

  try {
    const store = new ProjectStore(file);
    const companyProject = store.create({
      id: 'company-project',
      name: 'Company project',
      organizationId: 'local-coder',
      organizationName: 'Local Coder',
      workspace
    });
    const personalProject = store.create({
      id: 'personal-project',
      name: 'Personal project',
      organizationId: 'personal',
      organizationName: 'Personal',
      workspace
    });

    assert.equal(companyProject.workspace, personalProject.workspace);
    assert.equal(store.list().length, 2);
    assert.notEqual(projectIsolationKey(companyProject), projectIsolationKey(personalProject));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
