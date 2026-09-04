# Paridade funcional com Codex e Claude Desktop

Baseline pesquisado: **2026-09-02**. Estado de implementação re-auditado em **2026-09-03**, após os PRs #75–#88 e o P1 Multi-Company AgentRuntime Gate. Este documento é o checklist atual de implementação para que o Axis centralize, em um aplicativo local-first, o trabalho agêntico realizado com Ollama, Local Worker no Windows, Accounts e conexões autenticadas por API Key.

## P1 Gate real — 2026-09-03

**Resultado: FAIL.** O P1 está substancialmente implementado, porém ainda não atende ao gate completo de uso cotidiano multiempresa. O relatório autoritativo está em [P1_MULTICOMPANY_AGENT_RUNTIME_GATE.md](./P1_MULTICOMPANY_AGENT_RUNTIME_GATE.md).

### Concluído com evidência de produto/runtime

- Chat e Cowork passam pela mesma composição `AgentProductRuntime → AgentRuntime`.
- O engineering loop local real executa busca, leitura, edição, processo/teste com falha, reparo, novo teste e Git diff sem lista prévia obrigatória de arquivos editáveis.
- Company/Project/Connection/model/target/root/resources são fixados na autoridade imutável da sessão antes do provider/tool execution.
- Não existe fallback silencioso de Company, Connection, model ou execution target no runtime canônico.
- Filesystem, process, Git, MCP, browser, Project Memory, runtime policies e redaction possuem boundaries provider-neutral e multi-Company fail-closed.
- Ask/deny/approve funciona antes da mutação no mesmo processo; approve é vinculado à sessão/tool/argumentos e não pode atravessar Company.
- Project Memory é provider-neutral, não persiste raw chain-of-thought e é particionada por Company + Project + identidade do repositório/root.
- Claude Account, OpenAI API Key, Anthropic API Key e Ollama entram pela mesma arquitetura de `AgentProviderAdapter`.
- Adapters admitidos não podem executar filesystem/shell/MCP escondido fora do protocolo canônico.
- Runtime policies são persistentes e monotônicas: Company → Project → sessão só pode reduzir autoridade; deny vence.
- Há Effective Context canônico e secret-free, security audit primitives e redaction transversal antes de UI/Memory/audit.

### Blockers para P1 PASS

1. **P0 — product task worktree orchestration:** compor/reabrir managed worktree por job antes da sessão mutativa e tornar esse checkout o root exato do AgentRuntime.
2. **P0 — durable runtime checkpoint/restart:** persistir pending approval/tool/mutation/background process para restart sem replay de mutação incerta.
3. **P0 — real Local Worker execution target:** executar tools pelo `AgentExecutionTarget` real do Worker, em vez de apenas usar configuração/health/model discovery.
4. **P0 — ChatGPT/Codex Account G2:** continuar fail-closed até todos os provider-managed model-visible tools poderem ser suprimidos ou interceptados antes da execução.
5. **P1 — live Connection matrix:** provar opt-in duas Accounts, duas API Keys do mesmo provider e Account + API Key com Connections reais, mantendo evidência redigida.
6. **P1 — live full-loop UI evidence:** dirigir a Runtime UI pelo engineering loop de produto completo, não apenas por fixtures canônicas.

Nenhum item abaixo é marcado como BASE apenas porque existe um tipo, mock ou fixture. Quando a camada de runtime existe mas falta composição/UX/E2E, o status permanece PARCIAL ou BLOCKER.

---

## Objetivo de produto

O Axis deve ser o **control plane agêntico local para múltiplas empresas**: o desktop oferece ferramentas, controla permissões, lê e modifica arquivos, executa processos, mostra diffs e mantém sessões; cada execução usa uma conexão explicitamente escolhida e herda somente o contexto da empresa ativa.

Paridade funcional significa que o usuário pode entregar uma intenção aberta, deixar o agente explorar o computador/repositório, acompanhar e corrigir o trabalho, revisar cada mudança e continuar a conversa sem perder contexto. O mesmo app deve agregar várias empresas e várias contas de IA, preservando para cada empresa suas instruções, padrões, skills, agents, MCPs, projetos, memórias, credenciais, browser, histórico, limites e peculiaridades.

## Limites obrigatórios da arquitetura

- Sem backend Axis obrigatório, banco hospedado, conta Axis obrigatória ou serviço central de execução.
- Conversas, configurações, índices, memória, policies, agendamentos, logs e metadados são locais/exportáveis.
- Accounts, API Keys e Ollama são conexões de primeira classe; `authKind` não cria arquiteturas diferentes.
- Local Worker é destino de execução/inferência, nunca Company ou Connection falsa.
- Tools nativas pertencem ao Axis; provider-managed filesystem/shell/MCP não pode escapar do AgentRuntime.
- Company, Project, Connection, model, target, roots e resources são definidos antes da execução e não trocam silenciosamente.
- Toda transmissão externa deve ser atribuível a Company/Connection/target/policy.

## Como ler o checklist

- `[x] BASE` — existe em forma utilizável no produto/runtime para o escopo descrito.
- `[ ] PARCIAL` — parte relevante existe, mas ainda falta composição, UX, amplitude ou E2E para a paridade descrita.
- `[ ] BLOCKER` — implementação existente não satisfaz um requisito obrigatório do gate atual.
- `[ ] AUSENTE` — a capacidade descrita ainda não foi implementada de forma material.
- `[x] DECISÃO` — divergência intencional de produto/arquitetura em relação à referência.

---

# P1 — Multiempresa, conversa agêntica, arquivos, shell e Git

## P1.1 — Loop agêntico unificado entre IAs

- [x] BASE — Protocolo de turnos com texto, reasoning resumido, tool calls/resultados tipados, attachments metadata, errors e decisions.
- [x] BASE — Ciclo `modelo → tool call → AxisTool → tool result → modelo` até conclusão, pausa, cancelamento ou decisão.
- [ ] PARCIAL — Uma única interface de tools funciona para Ollama, Claude Account e API Keys; ChatGPT/Codex Account continua fora do runtime sob o blocker G2.
- [ ] PARCIAL — Adapters traduzem tool calling/protocolo e o bridge estruturado cobre providers seguros; falta liberar ChatGPT/Codex Account sem hidden tools.
- [ ] PARCIAL — Capabilities/autenticação/model metadata são representados canonicamente; a UI ainda não exibe toda a matriz de limites, multimodalidade, MCPs e restrições por model.
- [x] BASE — Capabilities nativas do Axis, ofertas do provider/model e restrictions de Company/Project/session são separadas e negociadas; deny explícito vence.
- [ ] PARCIAL — O tool catalog efetivo é recalculado pela sessão; falta UX completa de diff/preview antes de trocar Connection/model/target.
- [ ] BLOCKER — Local Worker possui configuração, health e model discovery, mas ainda não é um `AgentExecutionTarget` real no product AgentRuntime.
- [ ] PARCIAL — Não há fallback silencioso de model/target no runtime canônico; ainda faltam UX explícitas de retry/escolha de outro target compatível.
- [x] BASE — Capability/Connection/model incompatível falha explicitamente sem trocar Company, Account, API Key ou model silenciosamente.
- [x] BASE — O agente descobre dinamicamente arquivos e comandos sem lista final de `editableFiles` antes da exploração.
- [x] BASE — O loop continua após read/search/command/error/diff/validation e pode reparar após uma falha real de teste.
- [ ] AUSENTE — Scheduler de tool calls paralelas independentes com serialização explícita de mutações conflitantes.
- [ ] PARCIAL — Existem timeouts, bounded reads/output/processes e limites de tool específicos; falta orçamento unificado por turno para tokens/tool calls/bytes/processos/repetição.
- [ ] PARCIAL — Lifecycle emite provider/tool progress, reads, mutations, commands e validations; nem todos os providers possuem streaming equivalente.
- [ ] PARCIAL — Cancellation é propagada por provider/process/MCP/browser e process tree; subagents e restart-safe cancellation ainda não existem.
- [ ] PARCIAL — Retry/mutation contracts distinguem safe/after-confirmation/unknown e evitam retry inseguro; falta política de retry de produto mais completa.
- [ ] AUSENTE — Detector explícito de loops improdutivos com intervenção baseada em evidência.
- [ ] BLOCKER — Restart ainda não restaura o checkpoint canônico de pending tool/approval/mutation/background process.
- [ ] AUSENTE — Compactação automática da janela de contexto preservando tool state/decisions/tarefas pendentes.
- [ ] AUSENTE — Ação manual de compactação e indicador completo da janela de contexto.
- [x] DECISÃO — Connection e model são imutáveis dentro de uma sessão canônica; troca deve recompor/abrir uma sessão/handoff explícito, em vez de mutar identidade no meio do turn.
- [ ] AUSENTE — Modos de transcript resumo/normal/verboso com expansão individual de reads/edits/commands/MCPs.
- [ ] AUSENTE — Fila de mensagens com `steer now` versus `next turn`.
- [ ] AUSENTE — Steering durante execução no próximo boundary seguro sem cancelar.
- [ ] PARCIAL — Decisions/approvals estruturados fazem parte do protocolo geral; faltam todos os padrões ricos de pergunta/recomendação/free-form da referência.
- [ ] PARCIAL — Chat e Cowork usam o mesmo AgentRuntime e diferem por authority/capabilities; UX completa de Plan/Ask/Edit/Full-agent ainda não está fechada.

## P1.2 — Exploração e manipulação de arquivos

- [x] BASE — `list_directory` provider-neutral com paginação/bounds, metadata e controle de hidden files.
- [x] BASE — `read_file` bounded por bytes/linhas, com números de linha, SHA/version metadata e binary refusal apropriado.
- [x] BASE — `search_files` e `search_text` com glob/regex/case/context/limits e `.gitignore`.
- [x] BASE — `stat_file` com tipo, tamanho, permissões, MIME hint, hash e detecção UTF-8/binary.
- [ ] AUSENTE — Leitura/preview rico de imagens, PDF, áudio, vídeo, notebooks e formatos documentais.
- [ ] AUSENTE — `@mention` com autocomplete de files/folders/symbols.
- [ ] AUSENTE — Drag/paste/attach rico de imagens, PDFs e arquivos no composer.
- [ ] AUSENTE — Reuso robusto de múltiplos attachments em follow-ups com freshness explícita.
- [ ] PARCIAL — `AgentSessionContext` suporta múltiplos roots explícitos; a configuração de Project/UI ainda não oferece paridade completa de múltiplas pastas/repositórios.
- [ ] PARCIAL — Escrita/edit é atômica e usa SHA conflict detection; ainda falta UX de reaplicar/sobrescrever/descartar conflito.
- [x] BASE — `patch_file` contextual/hunk aplica edits parciais com ambiguity/conflict protection.
- [x] BASE — Criar arquivo/diretório com root/traversal/symlink protections.
- [ ] PARCIAL — Move/copy/delete existem como AxisTools com authority/destructive policy; faltam recuperação/undo e UX de confirmação específica por operação.
- [ ] PARCIAL — `set_file_mode` existe; criação/mutação controlada de symlink continua deliberadamente fail-closed.
- [ ] AUSENTE — Editor interno que recarrega mudança externa e oferece resolução visual de conflito.
- [ ] AUSENTE — Menu de arquivo para contexto/open-in/reveal/copy path.
- [ ] AUSENTE — Links universais clicáveis `file:line` em respostas/errors/search/diffs.
- [ ] AUSENTE — File tree pesquisável de Project/session com changed/open/recent.
- [ ] PARCIAL — Redaction/secret policy é transversal e process env é filtrado; classificação/override UX dedicada para `.env`, certificados etc. ainda falta.
- [ ] PARCIAL — Reads/searches são bounded; falta UX uniforme de chunking/omissão para arquivos grandes.

## P1.3 — Shell, processos e ambiente

- [x] BASE — `process_exec` argv-only com root-scoped cwd, filtered env, timeout, incremental output, exit code e mutation semantics.
- [ ] AUSENTE — PTY persistente para comandos interativos.
- [ ] PARCIAL — stdin, signals, poll/wait/terminate existem para process handles; PTY resize não existe porque PTY ainda não existe.
- [x] BASE — Background processes com stable IDs, session ownership, poll/wait/stdin/signal/terminate/list.
- [ ] PARCIAL — stdout/stderr incremental e truncation gaps existem; search/download do log completo ainda falta.
- [x] BASE — `process_which`/PATH diagnostics usam o ambiente exato visível ao Axis.
- [ ] AUSENTE — Editor de environment variables por Company/Project com secret refs.
- [ ] PARCIAL — Process execution geral substituiu a allowlist fixa do pipeline antigo e passa por capability/permission/policy; OS sandbox real ainda falta.
- [ ] AUSENTE — Project actions reutilizáveis Run/Test/Lint/Build com UI/config própria.
- [ ] AUSENTE — Terminal integrado por session/worktree com múltiplas tabs.
- [ ] AUSENTE — Tool para ler o terminal integrado atual.

## P1.4 — Permissões, sandbox e segurança operacional

- [x] BASE — Runtime policy possui modos normalizados `plan`, `ask-before`, `workspace-write`, `auto` e `full-access` com authority monotônica.
- [ ] PARCIAL — Policies persistem por Company/Project; falta UX completa no composer/Settings para troca, defaults e explicação de todos os efeitos.
- [ ] PARCIAL — Permission gate cobre filesystem/process/Git/MCP/browser/network/destructive actions; Computer Use ainda não existe.
- [ ] PARCIAL — One-shot approve/deny é session+Company+tool+args-bound e persistent policy existe; UX completa de once/session/always/deny-with-instruction ainda falta.
- [ ] PARCIAL — Runtime UI mostra decision/approval metadata redigida; previews especializados de command/patch/MCP/host/recipient ainda são incompletos.
- [ ] PARCIAL — Regras persistentes Company/Project para tool/network/authority existem no backend; editor completo em Settings ainda falta.
- [ ] AUSENTE — OS/process sandbox real read-only/workspace-write/full-access além das validações/policies no host Node.
- [ ] PARCIAL — Há outbound network authorization deny-by-policy, private/metadata/redirect protection e provider-specific allowances; isso ainda não equivale a network namespace/sandbox de SO.
- [x] BASE — Repo/web/MCP/provider/tool output é tratado como data e não pode elevar Company/Connection/model/root/policy/permission.
- [ ] PARCIAL — Security audit primitives registram policy/permission/decision/mutation/external action; ainda falta uma superfície completa de auditoria/export por sessão.
- [ ] PARCIAL — Redaction transversal protege lifecycle/UI/Memory/audit e common credential patterns; cobertura de todo raw diff/export/artifact ainda precisa ser fechada.
- [x] BASE — API Keys são resolvidas fora do renderer por credential ref no provider boundary.
- [x] BASE — Provider adapters não devolvem keys à UI e erros/lifecycle passam pela redaction transversal.
- [ ] PARCIAL — Custom endpoint/redirect boundary foi endurecido; TLS/custom CA/proxy corporativo completo ainda falta.
- [x] BASE — API Key test usa operação mínima/não-mutativa e não registra/devolve secret.
- [x] BASE — Capability/permission/policy gates governam as AxisTools reais do loop canônico.

## P1.5 — Empresas, contas, perfis e isolamento

- [x] BASE — Modelo canônico `Company → Connections/resources → Projects → Sessions`, com Personal separado.
- [x] BASE — Companies são first-class na navegação e possuem Overview, Projects, Connections, MCPs, Skills e Settings scoped.
- [x] BASE — Vários Claude Accounts, ChatGPT/Codex profiles e várias API Keys do mesmo provider permanecem Connections distintas.
- [x] BASE — Account e API Key usam a mesma abstração de Connection; API Key lifecycle possui add/test/edit/rotate/disable/remove e secrets ficam no Keychain.
- [ ] PARCIAL — Model discovery funciona para providers suportados; fallback catalog configurável e metadata completa de preço/capability por Connection/model ainda faltam.
- [ ] BLOCKER — Local Worker existe como configuração/health/model source, mas não como execution target real de tools no AgentProductRuntime.
- [ ] PARCIAL — Connection Center mostra identidade/authKind/Company/provider/status; inventário completo de MCPs/skills/plugins/agents/capabilities por model ainda falta.
- [ ] PARCIAL — Project defaults/policies cobrem Connection/model; Company/target/mode/fallback defaults completos ainda faltam.
- [x] DECISÃO — O runtime canônico não faz fallback silencioso entre Connections; mudança de identity/cost deve ser explícita/recomposta.
- [ ] AUSENTE — Rate limit/quota/circuit breaker plenamente particionados por credential/Connection e apresentados como tal.
- [x] BASE — Session authority fixa Company, Project, exact Connection, provider family/authKind, exact model, target id, roots, resources, permissions e effective capabilities antes do primeiro tool execution.
- [ ] PARCIAL — Company→Project→session policy precedence e Effective Context existem para recursos implementados; skills/plugins/hooks/templates ainda não participam porque não existem.
- [ ] PARCIAL — Effective Context canônico e secret-free existe; falta inspector UI completo e origens para recursos ainda não implementados.
- [ ] PARCIAL — Project instructions e runtime policies permitem parte das peculiaridades por Company/Project; glossário/templates/workflow/app policy ricos ainda faltam.
- [ ] AUSENTE — Project templates por Company instalando instructions/skills/MCPs/agents/validations.
- [ ] PARCIAL — Browser/process/worktree/memory possuem isolation keys/ownership; product worktree orchestration e attachment isolation completo ainda faltam.
- [x] BASE — Cross-Company Project/Connection/root/filesystem/process/Git/MCP/browser/Memory/resource access falha closed nos boundaries canônicos.
- [x] BASE — O mesmo physical workspace não pode ser associado conflitivamente a Companies sem mecanismo explícito.
- [x] BASE — Work Hub é global com `All` + filtros Company/Personal e mantém provenance `companyId`/`connectionId`/`sourceId`.
- [ ] AUSENTE — Busca global cross-Company deliberada sem misturar resultados no contexto da sessão.
- [ ] AUSENTE — Move/copy de Project/conversation/resource entre Companies com preview/redaction/confirmation.
- [ ] AUSENTE — Export da ficha de isolamento/effective context da sessão.
- [ ] AUSENTE — Export/import de pacote local de configuração de Company sem credentials.
- [ ] PARCIAL — Regressões de isolamento cobrem boundaries e operações locais reais; a matriz live de duas Accounts/duas API Keys/Local Worker/crash ainda não existe.

## P1.6 — Git, diff e revisão

- [ ] PARCIAL — Last-turn review já possui files/hunks/old-new line numbers/additions-removals; syntax highlighting e pane de review mais completa ainda faltam.
- [ ] PARCIAL — Backend Git suporta working/staged/branch/commit diffs e Project UI já possui estados Git reais; a experiência uniforme de todos os scopes ainda não está completa.
- [x] BASE — Git status/diff lê o estado real do checkout, incluindo mudanças não produzidas pelo pipeline Axis.
- [ ] PARCIAL — Unified diff/collapse/navigation existem; side-by-side, wrap configurável e search ainda faltam.
- [ ] AUSENTE — Inline diff comments + queue + envio conjunto ao agente.
- [ ] PARCIAL — Cowork possui review/reparo adversarial, mas review on-demand com findings inline/severity/fix action ainda falta.
- [ ] PARCIAL — `git_stage`/`git_unstage` existem para paths; revert e stage/unstage por hunk/UX completa ainda faltam.
- [ ] PARCIAL — Branch creation existe; rename branch e commit creation com message review ainda faltam.
- [ ] PARCIAL — Git layer protege source checkout e testa dirty-source/worktree isolation; o product path ainda não inicia mutating task em worktree automático.
- [ ] AUSENTE — Merge/rebase conflict resolver visual com approval.
- [ ] BLOCKER — Managed worktree create/list/remove existe, mas product Cowork ainda não compõe worktree por job como root da sessão.
- [ ] AUSENTE — Escolha explícita “usar checkout atual” versus worktree com risco/authority claros.
- [ ] PARCIAL — Worktree removal/ownership cleanup existe; snapshot/restore/retention/archive completo ainda falta.
- [ ] AUSENTE — Handoff seguro entre checkout e worktree.
- [ ] AUSENTE — Diff/review multi-repository completo para Projects com múltiplos repos.

## Gate de conclusão do P1

- [ ] PARCIAL — “Corrija o bug de login” já executa search→read→edit→test fail→repair→test pass→Git diff com tools locais reais; ainda falta live-provider matrix.
- [ ] PARCIAL — Ask/deny/approve funciona; steering durante turn e inline diff comments ainda faltam.
- [ ] BLOCKER — Duas sessões do mesmo repo ainda não usam worktree task-root automático no product path.
- [ ] PARCIAL — Company isolation passa nos boundaries canônicos; falta a matriz live cobrindo todas as Connections/resources.
- [ ] PARCIAL — Mesmo-provider Account identity/profile isolation existe, mas duas Accounts reais não são exercitadas no gate e ChatGPT/Codex Account está bloqueado.
- [ ] PARCIAL — Múltiplas API Key Connections são distintas por construção; falta prova live opt-in com duas keys reais do mesmo provider.
- [ ] PARCIAL — Account e API Key compartilham arquitetura sem compartilhar credential; falta matriz live completa e recursos P2 ainda ausentes.
- [ ] BLOCKER — Local Worker ainda não executa o AgentRuntime como target real.
- [ ] BLOCKER — Crash/restart não restaura exact runtime checkpoint sem risco de replay.
- [ ] BLOCKER — ChatGPT/Codex Account permanece fail-closed sob G2.

---

# P2 — Ambiente local completo, computador, previews e extensibilidade

## P2.1 — Browser, preview e Computer Use

- [ ] AUSENTE — Browser integrado em pane, com tabs, persistent isolated profile, history, downloads e abertura pelo chat.
- [ ] AUSENTE — Preview automático de servidor local, com command/port/cwd detection/configuration.
- [ ] AUSENTE — Gerenciamento de múltiplos dev servers e port conflicts.
- [ ] AUSENTE — Persistência/limpeza opcional de cookies/localStorage do preview.
- [ ] PARCIAL — Browser AxisTools já possuem navigate/read/state/static DOM/forms/inspect e contratos para screenshot/developer/interact; falta backend Electron/CDP live para screenshot/click/type/console/network.
- [ ] AUSENTE — Auto-verify pós-edit com preview/DOM/console/screenshot/fix loop.
- [ ] AUSENTE — Visual annotation por element/area e feedback localizado.
- [ ] PARCIAL — Browser/network host policy possui allow/block, private/link-local/metadata protection, redirect re-authorization e untrusted-content semantics; UX completa `once/always/deny` por domínio ainda falta.
- [ ] PARCIAL — Session/browser partition identity existe; browser pessoal autenticado por extension e cookie persistence ainda não.
- [ ] PARCIAL — `developer_read` contract/capability existe; CDP live/console/network/performance implementation ainda falta.
- [ ] AUSENTE — Computer Use macOS/Windows.
- [ ] AUSENTE — Onboarding Accessibility/Screen Recording.
- [ ] AUSENTE — Approval tiers por aplicativo para Computer Use.
- [ ] AUSENTE — Picture-in-picture/visual stream de Computer Use.
- [ ] PARCIAL — Runtime possui tool/capability boundaries para MCP/process/browser; seleção hierárquica automática MCP→shell→DOM→Computer Use ainda não existe.
- [ ] AUSENTE — Appshots/front-window capture.
- [ ] AUSENTE — iOS Simulator pane.

## P2.2 — Editor, renderização e artefatos de arquivo

- [ ] AUSENTE — File editor pane com syntax highlighting/save/discard/external conflict UX.
- [ ] PARCIAL — CommonMark/GFM renderer existe parcialmente; ainda faltam extensões/links/images/footnotes completos e hardening uniforme.
- [ ] AUSENTE — Code highlighting/open snippet/file UX completa.
- [ ] AUSENTE — Sanitização robusta HTML/script/dangerous URLs em todos os renderers ricos.
- [ ] AUSENTE — Mermaid/math/visualizations.
- [ ] AUSENTE — Markdown/HTML rendered/source preview.
- [ ] AUSENTE — PDF/DOCX/PPTX/XLSX/CSV/image/audio/video preview.
- [ ] AUSENTE — Localized annotations em artifacts/files.
- [ ] AUSENTE — Artifact/file versions com compare/restore/download/open-in.
- [ ] AUSENTE — Output cards ricos com path/type/size/preview/validations/open/reveal.

## P2.3 — Sessões paralelas, subagentes e coordenação

- [ ] PARCIAL — Várias jobs/sessions existem, mas resource-aware scheduler + automatic worktree isolation ainda não.
- [ ] PARCIAL — Company/Project grouping/filtering existe; filtro deliberado cross-Company por status/Connection/authKind/environment ainda não.
- [ ] AUSENTE — Duas sessions side-by-side.
- [ ] AUSENTE — Draggable/resizable panes completas.
- [ ] AUSENTE — Side chat não contaminante.
- [ ] AUSENTE — Subagents com prompt/model/Connection/permissions/resource budgets próprios.
- [ ] AUSENTE — Execution target por subagent.
- [ ] AUSENTE — Spawn/status/thread/steer/interrupt/close de subagents.
- [ ] AUSENTE — Structured subagent summary/handoff.
- [ ] AUSENTE — Custom agents por função.
- [ ] AUSENTE — Tasks pane unificando subagents/background workflows.
- [ ] AUSENTE — Session-management tools scoped à mesma Company.
- [ ] AUSENTE — Cross-session messages/backlinks/queues/inbound policy.
- [ ] AUSENTE — Sugestão/criação de nova session+worktree sem interromper a atual.

## P2.4 — MCPs, conectores e ferramentas por empresa

- [x] BASE — Perfis Claude e ChatGPT/Codex podem descobrir/configurar MCPs pelos runtimes oficiais existentes.
- [x] BASE — Work Hub agrega calendar/tickets/messages preservando Connection/source provenance.
- [x] BASE — Existe host MCP provider-agnostic do Axis; MCP execution não depende do inference provider.
- [ ] PARCIAL — Host suporta stdio, Streamable HTTP e legacy SSE, initialize/tools/resources/invoke/progress/cancel/timeout/cleanup; restart/health orchestration de produto ainda não é completa.
- [x] BASE — Configuração suporta stdio executable/args/root-scoped cwd e remote URL/headers via secret refs sem expor secret ao model/renderer.
- [ ] AUSENTE — OAuth genérico iniciado pelo Axis para MCP remoto fora dos runtimes oficiais já existentes.
- [ ] PARCIAL — Tools/resources discovery e invocation existem; prompts/resource templates/roots protocol/sampling/elicitation/notifications ainda faltam.
- [ ] AUSENTE — Lazy/search tool discovery para MCP catalogs grandes.
- [ ] PARCIAL — MCP AxisTools passam pelo permission gate e mutation semantics; preview UI MCP-específico ainda é incompleto.
- [ ] AUSENTE — MCP Apps/UI resources sandboxed.
- [ ] PARCIAL — Axis-managed local/remote e Account-discovered provenance são distinguíveis; modelagem/UI completa dos quatro origins incluindo provider-admin bloqueado ainda falta.
- [ ] PARCIAL — MCP catalog é Company+Project/resource-bound com source Connection ownership; model/session/schedule bindings e allowlists completos ainda faltam.
- [x] BASE — Uma OpenAI/Anthropic API Key pode usar MCPs executados pelo Axis independentemente de configuração MCP nativa do provider, quando a sessão/resource permite.
- [ ] PARCIAL — Structured-output fallback/capability failure existe no runtime; UX de incompatibilidade específica de MCP/model ainda falta.
- [ ] PARCIAL — Effective tool/resource set pode variar por sessão/model capability/policy; UI completa para model-specific MCP bindings ainda falta.
- [ ] PARCIAL — Runtime calcula authority por session resources + capability + Company/Project policy + source Connection ownership; configuração administrativa completa ainda falta.
- [ ] AUSENTE — Claude Enterprise/admin-managed MCP catalog read-only com constraints refletidas integralmente na UI.
- [ ] AUSENTE — UI “managed by your company” para add/remove/configure bloqueado pelo provider.
- [ ] AUSENTE — Rediscovery automática completa após login/org/model/admin changes.
- [x] BASE — Axis diferencia MCP host execution de provider-managed tools; provider hidden MCP execution não é aceito no runtime canônico.
- [ ] AUSENTE — Diff de MCPs antes de trocar Connection/model.
- [ ] PARCIAL — Missing capability/tool falha explicitamente; UX de voltar/escolher compatível/seguir sem capability ainda falta.
- [ ] AUSENTE — MCP scoping para subagents, pois subagents ainda não existem.
- [ ] PARCIAL — Account MCP connector discovery pode alimentar config/provenance do Axis host sem misturar execution; import/mirror UX multi-profile completo ainda falta.
- [ ] PARCIAL — Company Hub possui MCP surface e catalog scoped; busca/status/origin/actions completos ainda faltam.
- [ ] PARCIAL — Effective Context/audit identifica Company/resource/host sem secret; pre-send disclosure rica dos campos enviados a SaaS ainda falta.
- [ ] PARCIAL — Lifecycle/security audit cria trace por tool com authority/result/error; métricas completas de bytes/custo e export ainda faltam.
- [x] BASE — Tool/resource/provider/web content não pode elevar permission/policy/Company/root.

## P2.5 — Skills, plugins, instruções, hooks e memória

- [ ] PARCIAL — Project instructions existem; descoberta/aplicação hierárquica completa de `AGENTS.md` ainda não possui paridade.
- [ ] AUSENTE — `CLAUDE.md`/`CLAUDE.local.md` compatibility.
- [ ] AUSENTE — UI de instruction origins/precedence completa.
- [ ] AUSENTE — Skills pessoais/Company/Project com discovery/invocation/resources/scripts.
- [ ] AUSENTE — CRUD/install/enable/disable de skills no app.
- [ ] AUSENTE — Import de skills/agents/commands/patterns/memory dos profiles externos para Company explícita.
- [ ] AUSENTE — Bindings de skills/plugins/agents/hooks/patterns para API Keys/models com a mesma UX dos Accounts.
- [ ] AUSENTE — Conflict resolver por resource name/origin/scope.
- [ ] AUSENTE — Capability packs por Company e diff de contexto por Project.
- [ ] AUSENTE — Plugins agrupando skills/MCPs/hooks/agents/LSPs/assets/templates.
- [ ] AUSENTE — Local plugin library/validation/enable/disable/uninstall.
- [ ] AUSENTE — Plugin scope/policies/allow-deny-signature.
- [ ] AUSENTE — Executable lifecycle hooks before/after tools/turn/session/subagent.
- [ ] PARCIAL — Runtime policies já fornecem rules declarativas para authority/tools/network; sistema geral de rules consumível por skills/plugins/hooks ainda falta.
- [ ] PARCIAL — Project Memory automático provider-neutral existe por Company+Project+repo/root, com persistence/compaction/handoff/redaction; memória pessoal, editor/freshness/source UX e deletion seletiva ainda faltam.
- [ ] PARCIAL — Repo Intelligence + Project Memory entram no contexto/handoff; inspector/edit/forget facts ainda falta.
- [ ] AUSENTE — Import revisável de config/memory de outro agent.
- [ ] AUSENTE — Record & Replay de UI para gerar skill.

## Gate de conclusão do P2

- [ ] App web: edit → dev server → preview → DOM/console error → fix → visual proof.
- [ ] Ollama + Claude Account + ChatGPT/Codex Account + API Key usam o mesmo runtime de MCP/skill/plugin/agent/hook/browser/subagent sob Company policy.
- [ ] Connection API Key configura os mesmos recursos de uma Account, variando só auth.
- [ ] Duas Companies podem possuir MCPs/skills de mesmo nome sem collision/leak.
- [ ] Dois models da mesma Account podem expor MCP sets distintos e a UI mostra o effective set corretamente.
- [ ] Enterprise managed MCP constraints são respeitados e mostrados sem controles falsos.
- [ ] Subagent não herda MCP unavailable no seu model/Connection.
- [ ] Markdown/HTML/PDF/image/spreadsheet abrem em preview e aceitam localized feedback.
- [ ] Computer Use só opera apps autorizados da Company ativa e é visível/interrompível.

---

# P3 — Agendamentos locais e criação multimodal

## P3.1 — Tarefas agendadas e rotinas

- [ ] AUSENTE — Automation schema local/versioned com Company/Project/Connection/authKind/model/effort/permissions/timezone.
- [ ] AUSENTE — hourly/daily/weekly/weekdays/interval/RRULE scheduling.
- [ ] AUSENTE — Criar schedule por conversation e formulário com confirmação.
- [ ] AUSENTE — Heartbeat em conversation existente e standalone session por run.
- [ ] AUSENTE — Execução local no checkout/worktree dedicado com availability checks.
- [ ] AUSENTE — Temporary `/loop`/monitor dentro da session.
- [ ] AUSENTE — Scheduled inbox active/paused/completed/unread/next run/history/output.
- [ ] AUSENTE — Pause/resume/edit/run-now/retry/duplicate/delete.
- [ ] AUSENTE — Quiet/no-change behavior + local notifications por completion/failure/intervention.
- [ ] AUSENTE — Time/token/process/run limits, concurrency, backoff, dedup, circuit breaker.
- [ ] AUSENTE — Safe unattended policy sem approval impossível.
- [ ] AUSENTE — Schedule fixa Company/Connection/skills/MCPs/roots/policies e mostra impact de mudanças.
- [ ] AUSENTE — Schedule fixa model/target/effective MCP set e pausa em incompatibilidade.
- [ ] AUSENTE — Auth/quota failure pausa apenas automations daquela Connection.
- [ ] AUSENTE — Retention/cleanup de runs/logs/worktrees.
- [ ] AUSENTE — Restart-safe calendar sem duplicate runs.

## P3.2 — Imagens, voz, sites e visualizações locais

- [ ] AUSENTE — Image generation/editing tool/model local com references/versions/workspace save.
- [ ] AUSENTE — Multi-image/screenshot input com preview/comparison.
- [ ] AUSENTE — Voice input/conversation local; TTS atual pode permanecer fallback.
- [ ] AUSENTE — Generated interactive sites/apps com preview/source/local iteration.
- [ ] AUSENTE — Interactive visualizations/diagrams/simulators.
- [ ] AUSENTE — Artifact version/fork/export local.

## Gate de conclusão do P3

- [ ] Duas automations de Companies distintas usam Connections/MCPs/skills/worktrees distintos sem leak.
- [ ] Weekly automation modifica worktree e notifica só em mudança relevante, sem backend Axis.
- [ ] Restart preserva agenda/history sem duplicate next run.
- [ ] Multimodal artifact pode ser criado/reviewed/versioned/exported sem infraestrutura Axis.

---

# P4 — Produtividade, distribuição local, acessibilidade e acabamento

## P4.1 — Organização de conversas e produtividade

- [ ] PARCIAL — Busca local cobre parte de title/content/Company/Project; query completa por branch/files/Connection/authKind ainda falta.
- [ ] AUSENTE — Find dentro da conversation.
- [ ] PARCIAL — Pin/unpin/ordering ainda não possui comportamento completo em todas as surfaces.
- [ ] PARCIAL — Work Hub/Activity multi-Company existe com provenance/filtering, mas estados running/waiting/ready/blocked/unread/scheduled e inbox actions não estão completos.
- [ ] AUSENTE — Custom folders/sections e manual reorder de chats/projects.
- [ ] AUSENTE — Home multi-Company de health/disconnected Connections/pending approvals/automations/usage.
- [ ] AUSENTE — Quick switcher Company→Project→conversation com Connection/auth visibility.
- [ ] AUSENTE — Export redigido de conversation/transcript/tool trace.
- [ ] AUSENTE — Conversation branch/fork + attempt comparison.
- [ ] AUSENTE — Prompt/template library pessoal/Company.
- [ ] AUSENTE — Configurable local retention/deletion controls por Company.

## P4.2 — Settings, atalhos, aparência e acessibilidade

- [ ] PARCIAL — Command palette.
- [ ] PARCIAL — Shortcut map/edit/search/reset.
- [ ] AUSENTE — Slash commands new/compact/review/permissions/model/MCP/plugins/schedule etc.
- [ ] PARCIAL — System/Light/Dark existe; accent/background/foreground/fonts configuráveis ainda faltam.
- [ ] AUSENTE — Density/wrap/font-size/reduced-motion/high-contrast settings.
- [ ] AUSENTE — Complete keyboard/screen-reader/WCAG pass em todas as panes.
- [ ] AUSENTE — Full i18n com UI language separado da response language.
- [ ] AUSENTE — Prevent sleep/follow-up behavior settings.
- [ ] AUSENTE — OS notifications configuráveis.
- [ ] AUSENTE — Secure deep links com preview antes de iniciar.

## P4.3 — Uso, custo, diagnóstico e suporte local

- [x] BASE — Ledger local de usage/cost, budgets e routing history por Project.
- [ ] PARCIAL — Usage/session period existe parcialmente; context used/remaining, reasoning/cache/tool-level cost ainda incompletos.
- [ ] AUSENTE — Dashboard usage por Company/Connection/authKind/provider/model/Project.
- [ ] AUSENTE — Cost/token/concurrency/time alerts por Company/Connection/Project.
- [ ] AUSENTE — Activity profile lifetime/peak/streak/longest-task.
- [ ] PARCIAL — Connection/Worker health existe em surfaces específicas; painel unificado Accounts/API Keys/models/Workers/MCP/browser/sandbox/shell/Git/notifications ainda falta.
- [ ] AUSENTE — Exportable diagnostics bundle redigido.
- [ ] AUSENTE — Mensagens de erro acionáveis e uniformes para auth/rate-limit/context/missing-tool/path/Git-LFS/TLS-proxy.

## P4.4 — Políticas e distribuição local

- [ ] PARCIAL — Runtime policies persistentes por Company/Project existem e restringem session authority; editor/policy-file UX completa ainda falta.
- [ ] PARCIAL — Policies controlam authority/tools/network/destructive behavior; controles completos para models/Workers/Computer Use/plugins/skills/retention ainda faltam.
- [ ] PARCIAL — Domain/network/tool allow/deny existe; plugin/MCP executable/SaaS/app lists completas ainda faltam.
- [ ] AUSENTE — TLS/custom CA/proxy por Connection.
- [x] BASE — macOS signed package + automatic release/update pipeline; rollback local ainda falta.
- [ ] AUSENTE — Windows/macOS/Linux distribution matrix com capability degradation explícita.
- [ ] AUSENTE — Compatibility/versioning policy para provider adapters/Ollama/tools/plugins/skills/local migrations.

## P4.5 — Menor prioridade nas referências

- [ ] AUSENTE — Floating companion/pet status UI.
- [ ] AUSENTE — Pet customization + Computer Use picture-in-picture integration.
- [ ] AUSENTE — Dedicated hardware/keyboard integration.
- [ ] AUSENTE — Local Apple Messages integration com approval por recipient/chat.
- [ ] AUSENTE — Browser history pesquisável pelo agent sob approval.
- [ ] AUSENTE — Inspectable/user-controlled computer memory/history, se essa superfície for adotada.

---

# Ordem recomendada de implementação — pós-P1 Gate

## Marco 0 — Stabilization / sessão de correções

Antes de ampliar o roadmap, testar o app pós-#88 pelo caminho real e corrigir regressões funcionais/visuais introduzidas pelas mudanças de arquitetura do dia. Não usar essa etapa para iniciar features P2/P3 grandes.

## Marco 1 — Fechar os P0 do P1 Gate

1. Product task worktree orchestration.
2. Durable runtime checkpoint/restart.
3. Real Local Worker `AgentExecutionTarget`.
4. Manter G2 fail-closed até existir upstream contract seguro; reavaliar quando Codex expuser tool isolation suficiente.
5. Criar live Connection matrix opt-in e live full-loop UI evidence.

O P1 só muda para PASS depois desses pontos e do novo gate.

## Marco 2 — Ambiente de desenvolvimento (P2)

Prioridade sugerida após P1 PASS:

1. Browser/preview Electron-CDP e visual verification.
2. Terminal PTY e terminal pane.
3. File editor/tree/rich files.
4. MCP produto avançado (UI/OAuth/prompts/apps/catalog).
5. Skills/plugins/instructions/hooks.
6. Subagents/session coordination.
7. Computer Use.

## Marco 3 — Automação e multimodalidade (P3)

Scheduler/heartbeat/routines locais, depois criação multimodal/artifacts.

## Marco 4 — Produto administrável e polish (P4)

Busca/organização, shortcuts, notifications, accessibility, diagnostics, policy UI, usage e distribuição multiplataforma.

## Decisões arquiteturais vigentes

1. **Um único AgentRuntime.** Chat e Cowork já convergiram para o mesmo engine; automations/subagents futuros devem consumir o mesmo boundary.
2. **Tools nativas pertencem ao Axis.** Filesystem/process/Git/MCP/browser passam pelo canonical tool/permission/lifecycle path.
3. **Company/Connection/model/target são session authority imutável.** Troca exige recomposição explícita, nunca fallback silencioso.
4. **Mutações precisam ser observáveis e restart-safe.** O segundo ponto ainda é blocker P1.
5. **Worktree por padrão para mutating parallel work.** Backend existe; product orchestration ainda é blocker.
6. **Persistência local e secrets por reference.** Nenhum backend Axis é pressuposto.
7. **Account/API Key compartilham arquitetura.** ChatGPT/Codex Account permanece exceção fail-closed temporária por limitação técnica upstream, não por desenho do Axis.
8. **External content é data, não authority.** Web/repo/MCP/provider output não pode mudar policy/Company/root/permission.

# Fontes oficiais usadas para o inventário

## OpenAI / Codex

- [Features do ChatGPT/Codex desktop](https://learn.chatgpt.com/docs/features)
- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Code review e review pane](https://learn.chatgpt.com/docs/code-review?surface=app)
- [Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Browser integrado](https://learn.chatgpt.com/docs/browser?surface=app)
- [Computer Use](https://learn.chatgpt.com/docs/computer-use)
- [Terminal integrado](https://learn.chatgpt.com/docs/integrated-terminal)
- [Tarefas agendadas](https://learn.chatgpt.com/docs/automations)
- [Plugins](https://learn.chatgpt.com/docs/plugins)
- [MCP](https://learn.chatgpt.com/docs/mcp)
- [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Appshots](https://learn.chatgpt.com/docs/appshots)
- [Image inputs](https://learn.chatgpt.com/docs/image-inputs)
- [Image generation](https://learn.chatgpt.com/docs/image-generation)
- [Notifications](https://learn.chatgpt.com/docs/notifications)
- [App commands e deep links](https://learn.chatgpt.com/docs/reference/commands)

## Anthropic / Claude Desktop e Claude Code

- [Claude Code overview](https://code.claude.com/docs/en/overview)
- [Claude Code Desktop — referência completa](https://code.claude.com/docs/en/desktop)
- [Extensibilidade do Claude Code](https://code.claude.com/docs/en/features-overview)
- [Computer Use no Claude Desktop](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
- [Scheduled tasks no Cowork](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
- [Desktop extensions e MCP local](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Projects](https://support.claude.com/en/articles/9517075-what-are-projects)
- [Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)

## Manutenção deste inventário

Antes de iniciar cada marco:

- [ ] Revalidar as páginas oficiais e registrar a nova data de baseline quando a referência tiver mudado materialmente.
- [ ] Adicionar funções novas sem rebaixar itens existentes silenciosamente.
- [ ] Marcar BASE somente depois de evidência de produto/runtime adequada ao escopo do item.
- [ ] Manter blockers de integração/E2E explícitos mesmo quando a camada inferior já existir.
- [ ] Registrar diferenças intencionais como decisão de produto, não como falso gap de implementação.
