import fs from 'node:fs';

function replaceExact(file, before, after) {
  const source = fs.readFileSync(file, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: expected exactly one replacement target, found ${count}`);
  }
  fs.writeFileSync(file, source.replace(before, after));
}

const surface = 'app/src/AgentSurfaceV2.tsx';

replaceExact(
  surface,
  "import type { AdminProject, ModelSelection } from './app-types.js';",
  "import type { AdminProject, ModelSelection, ProjectConnectionPolicy } from './app-types.js';"
);

replaceExact(
  surface,
`interface ProjectCatalog {
  scope?: 'personal' | 'project';
  projectId: string;
  defaultModel: ModelSelection;
  providers: CatalogProvider[];
}`,
`interface ProjectCatalog {
  scope?: 'personal' | 'project';
  projectId: string;
  defaultModel: ModelSelection;
  chatDefaultModel?: ModelSelection;
  coworkDefaultModel?: ModelSelection;
  connectionPolicy?: ProjectConnectionPolicy;
  providers: CatalogProvider[];
}`
);

replaceExact(
  surface,
`function firstAvailableModel(catalog: ProjectCatalog, providerId: string): CatalogModel | undefined {
  const provider = catalog.providers.find((item) => item.id === providerId && item.ready);
  return provider?.models.find((model) => model.available);
}
function catalogHasSelection(catalog: ProjectCatalog, value: string): boolean {
  const selection = parseModelValue(value);
  if (selection.mode === 'auto') return false;
  const providerId = selection.mode === 'local-first' ? 'ollama' : selection.providerId;
  const provider = catalog.providers.find((item) => item.id === providerId && item.ready);
  return Boolean(provider?.models.some((model) => model.id === selection.modelId && model.available));
}
function defaultComposerSelection(catalog: ProjectCatalog): string {
  const configured = modelValue(catalog.defaultModel);
  if (configured !== 'auto') return configured;
  const local = firstAvailableModel(catalog, 'ollama');
  if (local) return modeValue(catalog.scope === 'personal' ? 'ollama' : 'local-first', local.id);
  for (const provider of catalog.providers) {
    const model = firstAvailableModel(catalog, provider.id);
    if (model) return modeValue(provider.id, model.id);
  }
  return 'auto';
}`,
`function allowedConnectionIds(catalog: ProjectCatalog, mode: ComposerMode): ReadonlySet<string> | undefined {
  const policy = catalog.connectionPolicy;
  if (!policy) return undefined;
  return new Set(mode === 'chat'
    ? policy.chat.allowedConnectionIds
    : policy.inference.allowedConnectionIds);
}
function catalogProviderAllowed(catalog: ProjectCatalog, providerId: string, mode: ComposerMode): boolean {
  const allowed = allowedConnectionIds(catalog, mode);
  return !allowed || allowed.has(providerId);
}
function firstAvailableModel(
  catalog: ProjectCatalog,
  providerId: string,
  mode: ComposerMode
): CatalogModel | undefined {
  if (!catalogProviderAllowed(catalog, providerId, mode)) return undefined;
  const provider = catalog.providers.find((item) => item.id === providerId && item.ready);
  return provider?.models.find((model) => model.available);
}
function catalogHasSelection(catalog: ProjectCatalog, value: string, mode: ComposerMode): boolean {
  const selection = parseModelValue(value);
  if (selection.mode === 'auto') return false;
  const providerId = selection.mode === 'local-first' ? 'ollama' : selection.providerId;
  if (!catalogProviderAllowed(catalog, providerId, mode)) return false;
  const provider = catalog.providers.find((item) => item.id === providerId && item.ready);
  return Boolean(provider?.models.some((model) => model.id === selection.modelId && model.available));
}
function defaultComposerSelection(catalog: ProjectCatalog, mode: ComposerMode): string {
  const scopedDefault = mode === 'chat' ? catalog.chatDefaultModel : catalog.coworkDefaultModel;
  const configured = modelValue(scopedDefault ?? catalog.defaultModel);
  if (configured !== 'auto' && catalogHasSelection(catalog, configured, mode)) return configured;
  const local = firstAvailableModel(catalog, 'ollama', mode);
  if (local) {
    return modeValue(catalog.scope === 'personal' || mode === 'chat' ? 'ollama' : 'local-first', local.id);
  }
  for (const provider of catalog.providers) {
    if (!catalogProviderAllowed(catalog, provider.id, mode)) continue;
    const model = firstAvailableModel(catalog, provider.id, mode);
    if (model) return modeValue(provider.id, model.id);
  }
  return 'auto';
}`
);

replaceExact(
  surface,
`  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const currentInference = worker?.inference?.current ?? undefined;`,
`  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const currentInference = worker?.inference?.current ?? undefined;
  const composerCatalogMode: ComposerMode = active?.input.interactionMode === 'chat' ? 'chat' : mode;`
);

replaceExact(
  surface,
`        setModelSelection((current) => activeSelection
          ? modelValue(activeSelection)
          : catalogHasSelection(next, current)
            ? current
            : defaultComposerSelection(next));`,
`        setModelSelection((current) => activeSelection
          ? modelValue(activeSelection)
          : catalogHasSelection(next, current, composerCatalogMode)
            ? current
            : defaultComposerSelection(next, composerCatalogMode));`
);

replaceExact(
  surface,
`  }, [selectedProjectId, activeId, catalogRefreshNonce]);`,
`  }, [selectedProjectId, activeId, catalogRefreshNonce, composerCatalogMode]);`
);

replaceExact(
  surface,
`    for (const provider of catalog?.providers ?? []) {
      for (const model of provider.models) {`,
`    for (const provider of catalog?.providers ?? []) {
      if (catalog && !catalogProviderAllowed(catalog, provider.id, composerCatalogMode)) continue;
      for (const model of provider.models) {`
);

replaceExact(
  surface,
`  }, [catalog]);

  const providerModes = useMemo<ProviderModeConfig[]>(() => {
    const modes = (catalog?.providers ?? []).map((provider) => ({`,
`  }, [catalog, composerCatalogMode]);

  const providerModes = useMemo<ProviderModeConfig[]>(() => {
    const modes = (catalog?.providers ?? [])
      .filter((provider) => !catalog || catalogProviderAllowed(catalog, provider.id, composerCatalogMode))
      .map((provider) => ({`
);

replaceExact(
  surface,
`  }, [catalog]);

  const selectedMode = providerMode(modelSelection);`,
`  }, [catalog, composerCatalogMode]);

  const selectedMode = providerMode(modelSelection);`
);

replaceExact(
  surface,
`  function chooseMode(next: ComposerMode) {
    localStorage.setItem('local-coder.composer-mode', next);
    setMode(next);
    if (next === 'cowork' && !selectedProject && !workspace.trim()) {`,
`  function chooseMode(next: ComposerMode) {
    localStorage.setItem('local-coder.composer-mode', next);
    setMode(next);
    if (catalog && !catalogHasSelection(catalog, modelSelection, next)) {
      setModelSelection(defaultComposerSelection(catalog, next));
    }
    if (next === 'cowork' && !selectedProject && !workspace.trim()) {`
);

const runtime = 'src/agent-product-runtime.ts';
replaceExact(
  runtime,
`    const candidate = input.modelSelection ?? project?.defaultModel;
    const exact = exactSelection(candidate);
    if (exact) return exact;
    if (!project) {
      throw new Error(
        'AgentRuntime product execution requires an exact selected Connection and model before Personal session composition.'
      );
    }`,
`    const requested = exactSelection(input.modelSelection);
    if (requested) return requested;
    if (!project) {
      throw new Error(
        'AgentRuntime product execution requires an exact selected Connection and model before Personal session composition.'
      );
    }`
);

replaceExact(
  runtime,
`    if (mode === 'chat') {
      const selected = await this.options.providers.projectChatSelection(project);
      const resolved = exactSelection(selected);
      if (!resolved) {
        throw new Error(\`Project \${project.id} did not resolve an exact Chat Connection and model.\`);
      }
      return resolved;
    }

    const { candidates } = await this.options.providers.routingCandidates(project, {`,
`    if (mode === 'chat') {
      const selected = await this.options.providers.projectChatSelection(project);
      const resolved = exactSelection(selected);
      if (!resolved) {
        throw new Error(\`Project \${project.id} did not resolve an exact Chat Connection and model.\`);
      }
      return resolved;
    }

    const projectDefault = exactSelection(project.defaultModel);
    if (projectDefault) return projectDefault;

    const { candidates } = await this.options.providers.routingCandidates(project, {`
);

const selectorTest = 'test/chat-provider-selector-ui-contract.test.ts';
fs.appendFileSync(selectorTest, `

test('Project model selector is scoped to the current Chat or Cowork connection authority', () => {
  assert.match(surface, /connectionPolicy\\?: ProjectConnectionPolicy/);
  assert.match(surface, /mode === 'chat'[\\s\\S]{0,120}policy\\.chat\\.allowedConnectionIds[\\s\\S]{0,120}policy\\.inference\\.allowedConnectionIds/);
  assert.match(surface, /catalogProviderAllowed\\(catalog, provider\\.id, composerCatalogMode\\)/);
  assert.match(surface, /catalogHasSelection\\(next, current, composerCatalogMode\\)/);
  assert.match(surface, /defaultComposerSelection\\(next, composerCatalogMode\\)/);
  assert.match(surface, /catalogHasSelection\\(catalog, modelSelection, next\\)/);
});
`);

fs.writeFileSync('test/project-chat-selection-scope-contract.test.ts', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src/agent-product-runtime.ts'), 'utf8');

test('Project Chat resolves its Chat default before the Cowork default', () => {
  const requested = source.indexOf('const requested = exactSelection(input.modelSelection);');
  const chatDefault = source.indexOf('this.options.providers.projectChatSelection(project)');
  const coworkDefault = source.indexOf('const projectDefault = exactSelection(project.defaultModel);');
  assert.ok(requested >= 0, 'explicit user selection must still be honored');
  assert.ok(chatDefault > requested, 'Project Chat must resolve through projectChatSelection');
  assert.ok(coworkDefault > chatDefault, 'Cowork default must only be considered after the Chat branch');
});
`);

console.log('Applied Project Chat/Cowork connection-scope fix.');
