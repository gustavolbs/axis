import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProviderCapabilityPolicyManager, ProviderCapabilityPolicyError } from '../src/provider-capability-policy.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import { ProjectStore, projectRepoMemoryScopeKey } from '../src/project-store.js';
import type { InferenceProvider, ProviderCapabilities } from '../src/providers/types.js';

function temp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `local-coder-contract-${name}-`));
}

const providerCapabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: false,
  reasoning: false,
  promptCaching: false,
  toolUse: true
};

function fakeProvider(id: string, kind: 'local' | 'cloud'): InferenceProvider {
  return {
    id,
    kind,
    capabilities: providerCapabilities,
    async listModels() { return [{ providerId: id, id: 'model-1', displayName: 'Model 1' }]; },
    async health() { return { providerId: id, ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 1 }; },
    async invoke(request) {
      return { providerId: id, model: request.model, content: 'ok', latencyMs: 1, usage: {} };
    }
  };
}

test('Projects can organize conversations without a folder and persist shared instructions', () => {
  const root = temp('folderless-project');
  const store = new ProjectStore(path.join(root, 'projects.json'));
  const project = store.create({
    id: 'product-project',
    name: 'Product Project',
    organizationId: 'personal',
    instructions: 'Always answer in concise engineering language.'
  });

  assert.equal(project.workspace, '');
  assert.equal(project.instructions, 'Always answer in concise engineering language.');
  assert.deepEqual(store.get(project.id), project);

  const repoA = projectRepoMemoryScopeKey(project, path.join(root, 'repo-a'));
  const repoB = projectRepoMemoryScopeKey(project, path.join(root, 'repo-b'));
  assert.notEqual(repoA, repoB, 'folderless Project Cowork memory must remain isolated per repository');
});

test('Project workspace association is explicit and never inferred from a Cowork folder', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/project-engineer-backend.ts'), 'utf8').replace(/\r\n/g, '\n');
  const resolve = source.slice(source.indexOf('private async resolveProject'));
  assert.match(resolve, /if \(!input\.projectId\)/);
  assert.match(resolve, /input\.interactionMode === 'chat'\) return \{ workspace: '' \}/);
  assert.match(resolve, /return \{ workspace: await resolveWorkspace\(input\.workspace\) \}/);
  assert.doesNotMatch(resolve, /matches\.push\(project\)/);
});

test('Project instructions are injected into every explicitly scoped execution', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/project-engineer-backend.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /function withProjectInstructions/);
  assert.match(source, /# PROJECT INSTRUCTIONS/);
  assert.match(source, /const scopedInput = withProjectInstructions\(project, input\)/);
  assert.match(source, /userPrompt: escalationPrompt\(scopedInput, escalation\)/);
});

test('Cowork keeps a hard folder requirement while Chat remains folderless', () => {
  const manager = fs.readFileSync(path.join(process.cwd(), 'src/standalone-job-manager.ts'), 'utf8').replace(/\r\n/g, '\n');
  const runtime = fs.readFileSync(path.join(process.cwd(), 'src/app-runtime.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(manager, /\(input\.interactionMode \?\? 'cowork'\) !== 'chat' && !input\.workspace\.trim\(\)/);
  assert.match(runtime, /interactionMode === 'chat'/);
});

test('capability policy defaults external powers to deny and allows prompt-level skills', async () => {
  const root = temp('capability-defaults');
  const settings = new ProviderSettingsStore(path.join(root, 'providers.json'));
  const manager = new ProviderCapabilityPolicyManager(settings);
  const cloud = manager.wrap(fakeProvider('future-ai', 'cloud'));
  const local = manager.wrap(fakeProvider('ollama', 'local'));

  await cloud.invoke({
    model: 'model-1', systemPrompt: '', userPrompt: '',
    capabilityRequests: [{ kind: 'skills', id: 'code-review' }]
  });
  await local.invoke({
    model: 'model-1', systemPrompt: '', userPrompt: '',
    capabilityRequests: [{ kind: 'abilities', id: 'reason-about-code' }]
  });
  await assert.rejects(
    cloud.invoke({
      model: 'model-1', systemPrompt: '', userPrompt: '',
      capabilityRequests: [{ kind: 'mcps', id: 'github' }]
    }),
    (error: unknown) => error instanceof ProviderCapabilityPolicyError && error.capability.kind === 'mcps'
  );
  await assert.rejects(
    local.invoke({
      model: 'model-1', systemPrompt: '', userPrompt: '',
      capabilityRequests: [{ kind: 'tools', id: 'shell' }]
    }),
    ProviderCapabilityPolicyError
  );
});

test('capability settings can enable a class and optionally restrict exact ids', async () => {
  const root = temp('capability-allowlist');
  const settings = new ProviderSettingsStore(path.join(root, 'providers.json'));
  settings.update('future-ai', {
    capabilities: { mcps: { enabled: true, allowIds: ['github'] } }
  });
  const manager = new ProviderCapabilityPolicyManager(settings);
  const wrapped = manager.wrap(fakeProvider('future-ai', 'cloud'));

  await wrapped.invoke({
    model: 'model-1', systemPrompt: '', userPrompt: '',
    capabilityRequests: [{ kind: 'mcps', id: 'github' }]
  });
  await assert.rejects(
    wrapped.invoke({
      model: 'model-1', systemPrompt: '', userPrompt: '',
      capabilityRequests: [{ kind: 'mcps', id: 'filesystem' }]
    }),
    ProviderCapabilityPolicyError
  );
});

test('the provider runtime applies budget and capability gates to current and future providers', () => {
  const runtime = fs.readFileSync(path.join(process.cwd(), 'src/project-provider-runtime.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(runtime, /private governed\(provider: InferenceProvider\)/);
  assert.match(
    runtime,
    /this\.capabilityPolicy\.wrap\(this\.budget\.wrap\(withSafeModelLimits\(provider\)\)\)/
  );
  assert.match(runtime, /\.\.\.Object\.keys\(this\.factories\)/);
  assert.match(runtime, /return \{ provider: this\.governed\(provider\) \}/);
});

test('project creation keeps folders optional while the project screen owns shared instructions', () => {
  const gallery = fs.readFileSync(path.join(process.cwd(), 'app/src/ProjectGallery.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const detail = fs.readFileSync(path.join(process.cwd(), 'app/src/ProjectDetail.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(gallery, /Use a folder/);
  assert.match(gallery, /name="description"/);
  assert.match(detail, /Edit instructions/);
  assert.match(detail, /body: \{ instructions \}/);
  assert.doesNotMatch(gallery, /disabled=\{busy \|\| !workspace\.trim\(\)\}/);
});
