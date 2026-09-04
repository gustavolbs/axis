import fs from 'node:fs';

function replaceExact(file, before, after) {
  const source = fs.readFileSync(file, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${file}: expected exactly one replacement target, found ${count}`);
  fs.writeFileSync(file, source.replace(before, after));
}

const detail = 'app/src/ProjectDetail.tsx';

replaceExact(
  detail,
  "import type { AdminProject, ModelSelection } from './app-types.js';",
  "import type { AdminProject, ModelSelection, ProjectConnectionPolicy } from './app-types.js';"
);

replaceExact(
  detail,
`interface ProjectCatalog {
  defaultModel: ModelSelection;
  providers: CatalogProvider[];
}`,
`interface ProjectCatalog {
  defaultModel: ModelSelection;
  chatDefaultModel?: ModelSelection;
  coworkDefaultModel?: ModelSelection;
  connectionPolicy?: ProjectConnectionPolicy;
  providers: CatalogProvider[];
}`
);

replaceExact(
  detail,
`function catalogHasSelection(catalog: ProjectCatalog, selection: ModelSelection): boolean {
  const providerId = selectionProviderId(selection);
  if (!providerId || selection.mode === 'auto') return false;
  const provider = catalog.providers.find((item) => item.id === providerId && item.ready);
  return Boolean(provider?.models.some((model) => model.id === selection.modelId && model.available));
}

function firstCatalogSelection(catalog: ProjectCatalog): ModelSelection {
  if (catalog.defaultModel.mode !== 'auto' && catalogHasSelection(catalog, catalog.defaultModel)) return catalog.defaultModel;
  const local = catalog.providers.find((provider) => provider.id === 'ollama' && provider.ready)?.models.find((model) => model.available);
  if (local) return { mode: 'local-first', modelId: local.id };
  for (const provider of catalog.providers) {
    const model = provider.ready ? provider.models.find((candidate) => candidate.available) : undefined;
    if (model) return { mode: 'explicit', providerId: provider.id, modelId: model.id };
  }
  return catalog.defaultModel;
}`,
`function projectCatalogProviderAllowed(
  catalog: ProjectCatalog,
  providerId: string,
  mode: 'chat' | 'cowork'
): boolean {
  const policy = catalog.connectionPolicy;
  if (!policy) return true;
  const allowed = mode === 'chat'
    ? policy.chat.allowedConnectionIds
    : policy.inference.allowedConnectionIds;
  return allowed.includes(providerId);
}

function catalogHasSelection(
  catalog: ProjectCatalog,
  selection: ModelSelection,
  mode: 'chat' | 'cowork'
): boolean {
  const providerId = selectionProviderId(selection);
  if (!providerId || selection.mode === 'auto' || !projectCatalogProviderAllowed(catalog, providerId, mode)) return false;
  const provider = catalog.providers.find((item) => item.id === providerId && item.ready);
  return Boolean(provider?.models.some((model) => model.id === selection.modelId && model.available));
}

function firstCatalogSelection(catalog: ProjectCatalog, mode: 'chat' | 'cowork'): ModelSelection {
  const scopedDefault = mode === 'chat' ? catalog.chatDefaultModel : catalog.coworkDefaultModel;
  const configured = scopedDefault ?? catalog.defaultModel;
  if (configured.mode !== 'auto' && catalogHasSelection(catalog, configured, mode)) return configured;
  const local = catalog.providers.find((provider) =>
    provider.id === 'ollama' && provider.ready && projectCatalogProviderAllowed(catalog, provider.id, mode)
  )?.models.find((model) => model.available);
  if (local) return mode === 'chat'
    ? { mode: 'explicit', providerId: 'ollama', modelId: local.id }
    : { mode: 'local-first', modelId: local.id };
  for (const provider of catalog.providers) {
    if (!projectCatalogProviderAllowed(catalog, provider.id, mode)) continue;
    const model = provider.ready ? provider.models.find((candidate) => candidate.available) : undefined;
    if (model) return { mode: 'explicit', providerId: provider.id, modelId: model.id };
  }
  return { mode: 'auto' };
}`
);

replaceExact(
  detail,
`    void api<{ catalog: ProjectCatalog }>('/api/chat/catalog')
      .then(({ catalog: next }) => {
        if (cancelled) return;
        setCatalog(next);
        setModelSelection((current) => catalogHasSelection(next, current) ? current : firstCatalogSelection(next));`,
`    void api<{ catalog: ProjectCatalog }>(\`/api/projects/\${encodeURIComponent(props.project.id)}/catalog\`)
      .then(({ catalog: next }) => {
        if (cancelled) return;
        setCatalog(next);
        setModelSelection((current) => catalogHasSelection(next, current, mode) ? current : firstCatalogSelection(next, mode));`
);

replaceExact(
  detail,
`  }, [props.project.id, catalogRefreshNonce]);`,
`  }, [props.project.id, catalogRefreshNonce, mode]);`
);

replaceExact(
  detail,
`  const selectedProvider = catalog?.providers.find((provider) => provider.id === selectedProviderId);`,
`  const selectedProvider = catalog?.providers.find((provider) =>
    provider.id === selectedProviderId && projectCatalogProviderAllowed(catalog, provider.id, mode)
  );`
);

replaceExact(
  detail,
`  const activeMenuProvider = catalog?.providers.find((provider) => provider.id === activeMenuProviderId);`,
`  const activeMenuProvider = catalog?.providers.find((provider) =>
    provider.id === activeMenuProviderId && projectCatalogProviderAllowed(catalog, provider.id, mode)
  );`
);

replaceExact(
  detail,
`  function togglePin() {`,
`  function chooseMode(next: 'chat' | 'cowork') {
    setMode(next);
    setModelMenuProvider(undefined);
    if (catalog && !catalogHasSelection(catalog, modelSelection, next)) {
      setModelSelection(firstCatalogSelection(catalog, next));
    }
  }

  function togglePin() {`
);

replaceExact(
  detail,
`                  <button type="button" role="radio" aria-checked={mode === 'chat'} className={mode === 'chat' ? 'selected' : ''} onClick={() => setMode('chat')}>Chat</button>
                  <button type="button" role="radio" aria-checked={mode === 'cowork'} className={mode === 'cowork' ? 'selected' : ''} onClick={() => setMode('cowork')}>Cowork</button>`,
`                  <button type="button" role="radio" aria-checked={mode === 'chat'} className={mode === 'chat' ? 'selected' : ''} onClick={() => chooseMode('chat')}>Chat</button>
                  <button type="button" role="radio" aria-checked={mode === 'cowork'} className={mode === 'cowork' ? 'selected' : ''} onClick={() => chooseMode('cowork')}>Cowork</button>`
);

replaceExact(
  detail,
`                      {(catalog?.providers ?? []).flatMap((provider) => {`,
`                      {(catalog?.providers ?? [])
                        .filter((provider) => !catalog || projectCatalogProviderAllowed(catalog, provider.id, mode))
                        .flatMap((provider) => {`
);

const desktopTest = 'test/desktop-ui-contract.test.ts';
replaceExact(
  desktopTest,
`  assert.match(agentSurface, /\\(catalog\\?\\.providers \\?\\? \\[\\]\\)\\.map\\(\\(provider\\)/);`,
`  assert.match(agentSurface, /\\(catalog\\?\\.providers \\?\\? \\[\\]\\)[\\s\\S]{0,180}catalogProviderAllowed\\(catalog, provider\\.id, composerCatalogMode\\)[\\s\\S]{0,180}\\.map\\(\\(provider\\)/);`
);
replaceExact(
  desktopTest,
`  assert.match(agentSurface, /catalogHasSelection\\(next, current\\)/, 'catalog refresh must preserve a valid explicit model');`,
`  assert.match(agentSurface, /catalogHasSelection\\(next, current, composerCatalogMode\\)/, 'catalog refresh must preserve a valid explicit model inside the active Chat or Cowork scope');`
);

const personalTest = 'test/personal-cloud-chat.test.ts';
replaceExact(
  personalTest,
`  assert.match(surface, /\\(catalog\\?\\.providers \\?\\? \\[\\]\\)\\.map\\(\\(provider\\)/);`,
`  assert.match(surface, /\\(catalog\\?\\.providers \\?\\? \\[\\]\\)[\\s\\S]{0,180}catalogProviderAllowed\\(catalog, provider\\.id, composerCatalogMode\\)[\\s\\S]{0,180}\\.map\\(\\(provider\\)/);`
);

const overviewTest = 'test/project-overview-surface.test.ts';
replaceExact(
  overviewTest,
`  assert.match(source, /\\/catalog\`\\)/);`,
`  assert.match(source, /\\/api\\/projects\\/\\$\\{encodeURIComponent\\(props\\.project\\.id\\)\\}\\/catalog/);`
);
fs.appendFileSync(overviewTest, `

test('Project overview model catalog enforces Chat and Cowork connection scopes', () => {
  assert.match(source, /connectionPolicy\\?: ProjectConnectionPolicy/);
  assert.match(source, /mode === 'chat'[\\s\\S]{0,120}policy\\.chat\\.allowedConnectionIds[\\s\\S]{0,120}policy\\.inference\\.allowedConnectionIds/);
  assert.match(source, /catalogHasSelection\\(next, current, mode\\)/);
  assert.match(source, /firstCatalogSelection\\(next, mode\\)/);
  assert.match(source, /projectCatalogProviderAllowed\\(catalog, provider\\.id, mode\\)/);
  assert.match(source, /catalogHasSelection\\(catalog, modelSelection, next\\)/);
});
`);

console.log('Completed Project Overview and UI contract scope fix.');
