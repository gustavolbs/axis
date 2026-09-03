import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalEngineerResult } from '../src/local-engineer.js';
import { projectRepoMemoryScopeKey } from '../src/project-store.js';
import {
  prepareRepoIntelligence,
  recordRepoIntelligenceLearning
} from '../src/repo-intelligence.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function project(id: string, organizationId: string, workspace: string) {
  return { id, organizationId, workspace };
}

function successfulResult(workspace: string): LocalEngineerResult {
  return {
    status: 'success',
    phase: 'complete',
    workspace,
    goal: 'Preserve the project architecture boundary',
    summary: 'Validated the project architecture boundary.',
    investigation: {
      searchQueries: ['value'],
      evidenceFiles: ['src/value.ts'],
      researchRequests: []
    },
    repairRounds: 0,
    changedFiles: [],
    diff: '',
    validation: [],
    modelCalls: []
  };
}

test('Project Memory is shared across consumers of one Project but isolated by Company and Project', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-memory-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-memory-state-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });

  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Axis Test']);
  git(root, ['config', 'user.email', 'axis-test@example.invalid']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const projectBoundary = true;\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['remote', 'add', 'origin', 'https://example.invalid/acme/project-memory.git']);

  const companyAProject = project('project-shared', 'company-a', root);
  const companyBProject = project('project-shared', 'company-b', root);
  const siblingProject = project('project-sibling', 'company-a', root);
  const companyAScope = projectRepoMemoryScopeKey(companyAProject, root);
  const config = { workerStatePath: state };

  const producer = await prepareRepoIntelligence(root, 'architecture boundary', config, companyAScope);
  await recordRepoIntelligenceLearning(producer, config, {
    result: successfulResult(root),
    facts: [{
      kind: 'architecture',
      text: 'The project boundary is represented by src/value.ts.',
      tags: ['architecture', 'project-boundary'],
      sourcePaths: ['src/value.ts'],
      confidence: 0.96
    }]
  });

  // A later Chat/Cowork/model/connection for the same Company + Project uses
  // the same provider-neutral scope and can retrieve the validated fact.
  const sameProjectConsumer = await prepareRepoIntelligence(
    root,
    'How is the project boundary represented?',
    config,
    projectRepoMemoryScopeKey(companyAProject, root)
  );
  assert.ok(sameProjectConsumer.retrieved.some((fact) => fact.text.includes('src/value.ts')));

  // The identical physical Git repository is not enough to cross either the
  // Company boundary or the Project boundary.
  const otherCompanyConsumer = await prepareRepoIntelligence(
    root,
    'How is the project boundary represented?',
    config,
    projectRepoMemoryScopeKey(companyBProject, root)
  );
  const siblingProjectConsumer = await prepareRepoIntelligence(
    root,
    'How is the project boundary represented?',
    config,
    projectRepoMemoryScopeKey(siblingProject, root)
  );
  assert.equal(otherCompanyConsumer.retrieved.length, 0);
  assert.equal(siblingProjectConsumer.retrieved.length, 0);
  assert.notEqual(companyAScope, projectRepoMemoryScopeKey(companyBProject, root));
  assert.notEqual(companyAScope, projectRepoMemoryScopeKey(siblingProject, root));
});
