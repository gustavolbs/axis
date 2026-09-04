import fs from 'node:fs';

function replaceExact(file, before, after) {
  const source = fs.readFileSync(file, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: expected exactly one replacement target, found ${count}`);
  }
  fs.writeFileSync(file, source.replace(before, after));
}

const detail = 'app/src/ProjectDetail.tsx';

// Project Overview starts in Chat. Do not seed its composer with the legacy/Cowork default
// before the scoped Project catalog arrives; Auto lets the runtime resolve the Chat default safely.
replaceExact(
  detail,
  `  const [modelSelection, setModelSelection] = useState<ModelSelection>(props.project.defaultModel);`,
  `  const [modelSelection, setModelSelection] = useState<ModelSelection>({ mode: 'auto' });`
);
replaceExact(
  detail,
  `    setModelSelection(props.project.defaultModel);`,
  `    setModelSelection({ mode: 'auto' });`
);

const connectionsPanel = 'app/src/ProjectConnectionsPanel.tsx';

// Chat owns its default in connectionPolicy.chat. Saving Chat permissions must never rewrite
// project.defaultModel, which is the compatibility/Cowork default used by inference routing.
replaceExact(
  connectionsPanel,
`      const defaultConnection = policy.chat.defaultConnectionId;
      const defaultModel = defaultConnection && policy.chat.defaultModelId
        ? { mode: 'explicit' as const, providerId: defaultConnection, modelId: policy.chat.defaultModelId }
        : scopedProject.defaultModel;
      const { project: updated } = await api<{ project: AdminProject }>(\`/api/projects/\${encodeURIComponent(scopedProject.id)}\`, {
        method: 'PATCH',
        body: {
          connectionPolicy: policy,
          privacy: { cloudAllowed, allowedProviderIds: allowedProviderIds.length ? allowedProviderIds : ['ollama'] },
          defaultModel
        }
      });`,
`      const { project: updated } = await api<{ project: AdminProject }>(\`/api/projects/\${encodeURIComponent(scopedProject.id)}\`, {
        method: 'PATCH',
        body: {
          connectionPolicy: policy,
          privacy: { cloudAllowed, allowedProviderIds: allowedProviderIds.length ? allowedProviderIds : ['ollama'] }
        }
      });`
);

fs.writeFileSync('test/project-model-scope-contract.test.ts', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const detail = fs.readFileSync('app/src/ProjectDetail.tsx', 'utf8');
const connections = fs.readFileSync('app/src/ProjectConnectionsPanel.tsx', 'utf8');
const runtime = fs.readFileSync('src/agent-product-runtime.ts', 'utf8');

test('Project Overview Chat is not seeded with the Cowork compatibility default', () => {
  assert.match(detail, /useState<ModelSelection>\\(\\{ mode: 'auto' \\}\\)/);
  assert.match(detail, /setModelSelection\\(\\{ mode: 'auto' \\}\\)/);
  assert.match(detail, /\\/api\\/projects\\/\\$\\{encodeURIComponent\\(props\\.project\\.id\\)\\}\\/catalog/);
});

test('saving Chat connection policy cannot overwrite the Cowork default model', () => {
  const saveStart = connections.indexOf('async function save()');
  const saveEnd = connections.indexOf('const chatModels', saveStart);
  const saveBody = connections.slice(saveStart, saveEnd);
  assert.match(saveBody, /connectionPolicy: policy/);
  assert.doesNotMatch(saveBody, /defaultModel/);
});

test('runtime resolves explicit user choice first, then mode-specific Project defaults', () => {
  const explicit = runtime.indexOf('const requested = exactSelection(input.modelSelection);');
  const chat = runtime.indexOf('this.options.providers.projectChatSelection(project)');
  const cowork = runtime.indexOf('const projectDefault = exactSelection(project.defaultModel);');
  assert.ok(explicit >= 0, 'explicit per-conversation selection must win');
  assert.ok(chat > explicit, 'Chat must resolve its own projectChatSelection after no explicit override');
  assert.ok(cowork > chat, 'Cowork defaultModel must only be considered after the Chat branch');
});
`);

console.log('Finalized Project Chat/Cowork default isolation patch.');
