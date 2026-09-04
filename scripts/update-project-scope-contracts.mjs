import fs from 'node:fs';

const file = 'test/context-project-ui-regressions.test.ts';
const source = fs.readFileSync(file, 'utf8');
const before = `test('Project Overview Chat uses the New Chat model catalog without requiring Connection-policy configuration', () => {
  const projectDetail = source('app/src/ProjectDetail.tsx');
  assert.doesNotMatch(projectDetail, /Configure a default Chat connection and model for this Project first/);
  assert.match(projectDetail, /api<\\{ catalog: ProjectCatalog \\}>\\('\\/api\\/chat\\/catalog'\\)/);
  assert.doesNotMatch(projectDetail, /\\/api\\/projects\\/\\$\\{encodeURIComponent\\(props\\.project\\.id\\)\\}\\/catalog/);
  assert.match(projectDetail, /modelSelection\\s*\\n\\s*}/);
  assert.match(projectDetail, /className="model-effort-trigger"/);
  assert.match(projectDetail, /className="lc-agent-popover model-popover"/);
  assert.doesNotMatch(projectDetail, /Project model and connections|Model & connections|ProjectConnectionsPanel/);
});`;
const after = `test('Project Overview Chat uses the scoped Project catalog without requiring a Connections modal', () => {
  const projectDetail = source('app/src/ProjectDetail.tsx');
  assert.doesNotMatch(projectDetail, /Configure a default Chat connection and model for this Project first/);
  assert.match(projectDetail, /\\/api\\/projects\\/\\$\\{encodeURIComponent\\(props\\.project\\.id\\)\\}\\/catalog/);
  assert.doesNotMatch(projectDetail, /api<\\{ catalog: ProjectCatalog \\}>\\('\\/api\\/chat\\/catalog'\\)/);
  assert.match(projectDetail, /projectCatalogProviderAllowed/);
  assert.match(projectDetail, /modelSelection\\s*\\n\\s*}/);
  assert.match(projectDetail, /className="model-effort-trigger"/);
  assert.match(projectDetail, /className="lc-agent-popover model-popover"/);
  assert.doesNotMatch(projectDetail, /Project model and connections|Model & connections|ProjectConnectionsPanel/);
});`;
const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`${file}: expected one old Project catalog contract, found ${count}`);
fs.writeFileSync(file, source.replace(before, after));
console.log('Updated Project Overview scoped catalog regression contract.');
