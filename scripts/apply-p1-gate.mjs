import fs from 'node:fs';

function replaceOnce(text, from, to, label) {
  if (text.includes(to)) return text;
  const index = text.indexOf(from);
  if (index < 0) throw new Error(`Could not find ${label}`);
  return `${text.slice(0, index)}${to}${text.slice(index + from.length)}`;
}

function write(path, content) {
  fs.writeFileSync(path, content, 'utf8');
}

// 1) Product hardening: managed worktree tools require a task checkout root
// that the current immutable product session does not yet compose. Do not
// advertise unusable worktree tools until that P1 blocker is fixed correctly.
{
  const file = 'src/agent-product-runtime.ts';
  let source = fs.readFileSync(file, 'utf8');
  source = replaceOnce(
    source,
    "import { createGitTools } from './agent-tools/git/index.js';",
    "import {\n  GIT_WORKTREE_CREATE_TOOL_NAME,\n  GIT_WORKTREE_REMOVE_TOOL_NAME,\n  GIT_WORKTREE_LIST_TOOL_NAME,\n  createGitTools\n} from './agent-tools/git/index.js';",
    'Git tool import'
  );
  source = replaceOnce(
    source,
    "function baseTools(\n  roots: readonly AgentRoot[],\n  backend: BrowserBackend | false | undefined,\n  extraTools: readonly AxisTool[] = []\n): AxisTool[] {\n  const tools = [\n    ...createFilesystemP12Tools(),\n    ...createProcessTools().tools,\n    ...createGitTools().tools,",
    "const PRODUCT_UNCOMPOSED_GIT_TOOLS = new Set<string>([\n  GIT_WORKTREE_LIST_TOOL_NAME,\n  GIT_WORKTREE_CREATE_TOOL_NAME,\n  GIT_WORKTREE_REMOVE_TOOL_NAME\n]);\n\nfunction baseTools(\n  roots: readonly AgentRoot[],\n  backend: BrowserBackend | false | undefined,\n  extraTools: readonly AxisTool[] = []\n): AxisTool[] {\n  const gitTools = createGitTools().tools.filter(\n    (tool) => !PRODUCT_UNCOMPOSED_GIT_TOOLS.has(tool.definition.name)\n  );\n  const tools = [\n    ...createFilesystemP12Tools(),\n    ...createProcessTools().tools,\n    ...gitTools,",
    'baseTools Git composition'
  );
  write(file, source);
}

// 2) Regression proof for the fail-closed product catalog. Direct Git-tool
// worktree tests remain intact; this only prevents the product agent from being
// told it can use a worktree before the exact task root exists.
{
  const file = 'test/agent-product-runtime.test.ts';
  let source = fs.readFileSync(file, 'utf8');
  const marker = "test('P1 gate: product catalog does not advertise managed worktrees before an exact task worktree root is composed'";
  if (!source.includes(marker)) {
    source += `\n\ntest('P1 gate: product catalog does not advertise managed worktrees before an exact task worktree root is composed', async () => {\n  const directory = temp('p1-worktree-catalog');\n  const repo = path.join(directory, 'repo');\n  fs.mkdirSync(repo);\n  fs.writeFileSync(path.join(repo, 'readme.txt'), 'hello\\n');\n  initializeRepo(repo);\n\n  const selected = project({\n    id: 'p1-worktree-project', companyId: 'company-a', workspace: repo,\n    connectionId: 'openai-a', providerFamily: 'openai', modelId: 'gpt-test'\n  });\n  const selectedConnection = connection({\n    id: 'openai-a', providerFamily: 'openai', companyId: 'company-a'\n  });\n  const prompts: string[] = [];\n  const provider = new ScriptedProvider('openai-a', 'gpt-test', (request, invocation) => {\n    prompts.push(request.systemPrompt);\n    if (invocation === 1) {\n      return call('read', 'read_file', {\n        rootId: 'project:p1-worktree-project', path: 'readme.txt'\n      });\n    }\n    return complete('Catalog stayed fail-closed.');\n  });\n  const runtime = product({\n    projects: [selected], connections: [selectedConnection],\n    providers: new Map([['openai-a', provider]])\n  });\n\n  try {\n    const result = await runtime.executeEngineer(engineerInput({\n      project: selected, sessionId: 'p1-worktree-catalog'\n    }));\n    assert.equal(result.status, 'success');\n    const prompt = prompts[0] ?? '';\n    assert.ok(prompt.includes('\\\"name\\\":\\\"git_status\\\"'));\n    assert.equal(prompt.includes('\\\"name\\\":\\\"git_worktree_list\\\"'), false);\n    assert.equal(prompt.includes('\\\"name\\\":\\\"git_worktree_create\\\"'), false);\n    assert.equal(prompt.includes('\\\"name\\\":\\\"git_worktree_remove\\\"'), false);\n  } finally {\n    fs.rmSync(directory, { recursive: true, force: true });\n  }\n});\n`;
    write(file, source);
  }
}

// 3) Release metadata and a focused gate command.
{
  const file = 'package.json';
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = '0.23.1';
  pkg.scripts['p1:gate'] = 'tsx --test test/agent-product-runtime.test.ts test/agent-git-tool.test.ts test/runtime-security-policies.test.ts test/project-memory.test.ts test/project-memory-sharing.test.ts test/native-provider-adapters.test.ts test/codex-app-server-agent-blocker.test.ts test/agent-runtime-ui.test.ts';
  write(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

{
  const file = 'CHANGELOG.md';
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes('## [0.23.1] - 2026-09-03')) {
    const section = `## [0.23.1] - 2026-09-03\n\n### Added\n- Added the P1 multi-company end-to-end gate report with an acceptance-by-acceptance distinction between real product evidence, module/fixture evidence, and unresolved blockers.\n- Added a focused \\`npm run p1:gate\\` regression command spanning product runtime composition, Git, runtime security, Project Memory, provider adapters, the accepted Codex Account blocker, and Runtime UI contracts.\n\n### Changed\n- Product AgentRuntime composition now fails closed by withholding managed-worktree tools until a task-specific managed worktree checkout can be composed as an exact immutable session root. Direct provider-neutral Git worktree tools remain available to the lower-level Git runtime and keep their existing ownership/isolation coverage.\n- Updated the Codex/Claude Desktop parity document with the real P1 gate result instead of treating merged foundations or mock/fixture coverage as completion.\n\n### Fixed\n- Fixed a product integration mismatch where Cowork could advertise managed-worktree tools even though its immutable product session contained no authorized worktree storage/task-checkout root capable of satisfying those tool contracts.\n\n### Security\n- P1 remains explicitly FAIL rather than silently falling back: product-level worktree orchestration, durable restart checkpoints, real Local Worker execution-target composition, the accepted ChatGPT/Codex Account G2 blocker, and live multi-Connection evidence remain blockers.\n\n`;
    const firstRelease = source.indexOf('## [');
    if (firstRelease < 0) throw new Error('Could not find changelog release section');
    source = `${source.slice(0, firstRelease)}${section}${source.slice(firstRelease)}`;
    write(file, source);
  }
}

// 4) Make the long parity inventory point at the authoritative real-state gate.
{
  const file = 'docs/CODEX_CLAUDE_DESKTOP_PARITY.md';
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes('## P1 Gate real — 2026-09-03')) {
    const section = `## P1 Gate real — 2026-09-03\n\n**Resultado: FAIL.** O inventário/checklist histórico abaixo continua útil como roadmap, mas seus marcadores antigos não são evidência suficiente de conclusão. O estado autoritativo do gate está em [P1_MULTICOMPANY_AGENT_RUNTIME_GATE.md](./P1_MULTICOMPANY_AGENT_RUNTIME_GATE.md).\n\n### Concluído com evidência de produto/runtime\n\n- Chat e Cowork passam pela mesma composição \\`AgentProductRuntime → AgentRuntime\\`.\n- O engineering loop local real executa busca, leitura, edição, processo/teste com falha, reparo, novo teste e Git diff sem lista prévia obrigatória de arquivos editáveis.\n- Company/Project/Connection/model são fixados antes do provider/tool execution e não possuem fallback silencioso.\n- Filesystem, process, Git, MCP, browser, Project Memory, policy e redaction possuem boundaries multi-Company fail-closed; operações locais de filesystem/process/Git são exercitadas contra roots/repos temporários reais.\n- Ask/deny/approve funciona antes da mutação no mesmo processo; approve executa a ação correspondente uma vez.\n- Project Memory é provider-neutral, não persiste raw chain-of-thought e é particionada por Company + Project + identidade do repositório.\n- Adapters admitidos não podem executar filesystem/shell/MCP escondido fora do protocolo canônico; ChatGPT/Codex Account continua bloqueado por G2.\n\n### Parciais\n\n- Claude Account, API Keys e Ollama usam a mesma arquitetura, mas CI não possui credenciais reais para provar duas Accounts, duas API Keys e Account + API Key simultaneamente.\n- Runtime UI possui Electron/visual smoke real, porém o smoke é fixture-driven e não um engineering loop inteiro com provider real.\n- Git worktrees possuem backend real e testes de isolamento/ownership, mas ainda não são o checkout raiz de uma tarefa Cowork composta pelo produto.\n\n### Blockers para P1 PASS\n\n1. compor/reabrir um managed worktree por job **antes** da sessão mutativa e tornar esse checkout o root exato do AgentRuntime;\n2. persistir checkpoint de runtime/approval/tool/mutation/background process para restart sem duplicação;\n3. executar o product AgentRuntime por um \\`AgentExecutionTarget\\` Local Worker real, sem mascarar desktop como worker;\n4. resolver G2 para ChatGPT/Codex Account sem provider-managed hidden tools;\n5. executar uma matriz opt-in com Connections reais e evidência redigida;\n6. dirigir a UI pelo lifecycle do engineering loop completo, não somente fixtures canônicas.\n\nNenhum item acima é marcado como concluído somente porque a camada inferior possui mocks/fixtures ou porque o CI está verde.\n\n---\n\n`;
    const anchor = '## Objetivo de produto';
    const index = source.indexOf(anchor);
    if (index < 0) throw new Error('Could not find parity insertion anchor');
    source = `${source.slice(0, index)}${section}${source.slice(index)}`;
    write(file, source);
  }
}

// Remove the one-shot transformer and workflow from the final branch.
for (const file of ['scripts/apply-p1-gate.mjs', '.github/workflows/p1-gate-apply.yml']) {
  if (fs.existsSync(file)) fs.rmSync(file);
}
