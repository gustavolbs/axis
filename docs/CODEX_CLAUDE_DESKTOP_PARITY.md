# Paridade funcional com Codex e Claude Desktop

Baseline pesquisado: **2026-09-02**. Estado de implementação revisado em **2026-09-03**. Este documento é um inventário funcional e um checklist de implementação para que o Axis centralize, em um aplicativo local-first, o trabalho agêntico realizado com Ollama, Local Worker no Windows, Accounts e conexões autenticadas por API Key. A experiência operacional deve alcançar Codex e Claude Desktop/Claude Code Desktop sem perder a separação entre empresas.

## Objetivo de produto

O objetivo não é apenas reproduzir a aparência dos concorrentes. O Axis deve ser o **control plane agêntico local para múltiplas empresas**: o processo desktop oferece ferramentas, controla permissões, lê e modifica arquivos, executa processos, mostra diffs e mantém sessões; cada execução usa uma conexão de IA explicitamente escolhida e herda somente o contexto da empresa ativa.

Paridade funcional significa que um usuário pode entregar uma intenção relativamente aberta, deixar o agente explorar o computador e o repositório, acompanhar e corrigir o trabalho em andamento, revisar cada mudança e continuar a conversa sem perder contexto. O mesmo app deve agregar várias empresas e várias contas de IA, preservando para cada empresa suas instruções, padrões, skills, agentes, MCPs, projetos, memórias, credenciais, browser, histórico, limites e peculiaridades.

## Limites obrigatórios da arquitetura

- O Axis não terá backend próprio, banco de dados hospedado, conta Axis obrigatória, sincronização em nuvem ou serviço central de execução.
- Conversas, configurações, índices, memória, agendamentos, logs e metadados serão persistidos no dispositivo, em arquivos controlados pelo aplicativo e exportáveis pelo usuário.
- Ollama é uma das opções de modelo/inferência, não a arquitetura inteira. Accounts ChatGPT/Codex, Claude, conexões por API Key e outras IAs são opções de primeira classe, acessadas diretamente pelo desktop, nunca por um backend intermediário do Axis.
- O Local Worker no Windows é uma especialização de destino de execução/inferência dentro do Axis, não uma empresa, conta ou família de MCP. Ele deve declarar se oferece somente inferência ou também execução de workspace e quais modelos/capacidades estão disponíveis.
- Agente, shell, Git, worktrees, browser de preview, Computer Use, scheduler, plugins e skills executam no desktop ou Local Worker autorizado. MCPs locais ou remotos e conectores SaaS são permitidos quando configurados para uma empresa e acessados diretamente pelo destino autorizado.
- Recursos que exigem infraestrutura hospedada — compartilhamento por link, colaboração em tempo real, handoff entre dispositivos, PR/CI gerenciado, marketplace online, telemetria central e administração por SSO/API — não fazem parte da paridade desejada.

Local-first, neste documento, define onde o Axis executa e persiste seu estado; não significa que o app seja offline-only. Toda transmissão para Ollama, uma conta de IA, MCP ou SaaS precisa ser visível, atribuída a uma empresa e governada pelas regras daquela empresa, inclusive quando parte do Local Worker.

## Modelo de contexto multiempresa

| Entidade | Responsabilidade | Regra de isolamento |
| --- | --- | --- |
| Empresa | Reúne identidade, instruções, padrões, políticas, skills, MCPs, contas, memória e defaults | Nenhum conteúdo contextual é herdado de outra empresa |
| Conexão | Representa qualquer acesso a um provedor, autenticado por Account/OAuth/CLI, API Key, endpoint Ollama ou mecanismo futuro | Credencial, catálogo de modelos, recursos vinculados e políticas pertencem a uma empresa |
| Modelo | É a opção selecionável exposta por uma conexão, inclusive modelos servidos por Ollama | Capabilities e MCPs podem variar entre modelos da mesma conexão |
| Destino de execução | Define onde inferência/trabalho roda: desktop atual ou Local Worker no Windows | Empresa/projeto autorizam o destino e o destino declara suas capacidades |
| Projeto | Liga uma ou mais pastas/repositórios às regras e recursos da empresa | Roots, memória, variáveis e Git ficam confinados ao projeto |
| Sessão | Registra conversa, conta, modelo, destino, permissões, tools, artefatos e execução | Empresa, conexão, modelo, destino e projeto são fixados antes do primeiro turno |
| Recurso | Skill, MCP, agente, hook, padrão, template ou memória reutilizável | Possui escopo-base pessoal/empresa/projeto e, quando aplicável, vínculo adicional por conta/modelo |

O perfil pessoal é tratado como um contexto separado, equivalente a uma empresa local, para impedir que trabalho pessoal herde silenciosamente dados corporativos.

### Invariável: API Key é uma conexão completa

`Account` e `API Key` são métodos de autenticação diferentes para a mesma abstração de conexão. Depois de criada, uma conexão por API Key funciona normalmente em todo o Axis: possui empresa, provedor, modelos, capabilities, skills, plugins, agents, MCPs, memória, políticas, defaults, limites, uso e histórico próprios. Nenhuma funcionalidade pode ser escondida apenas porque `authKind = api_key`.

O schema conceitual mínimo de uma conexão é:

`connectionId + companyId + provider + authKind + credentialRef + endpoint/config + modelCatalog + capabilityManifest + resourceBindings + policies`

O segredo da API Key fica no cofre do sistema. Conversas, projetos, exports, logs, prompts e arquivos de configuração armazenam somente `credentialRef` e metadados redigidos.

O conjunto efetivo de ferramentas de uma sessão é calculado, não presumido:

`tools nativas do Axis + MCPs/capabilities da conexão e do modelo ∩ política da empresa ∩ regras do projeto/sessão ∩ capacidades do destino de execução`

As tools nativas — filesystem, patch, shell, Git, diff, browser e Computer Use — devem manter contratos uniformes. MCPs, conectores e recursos do provedor podem variar legitimamente por conexão e modelo. Uma restrição administrada por um Account, como uma Claude Enterprise que só permite MCPs predefinidos, sempre vence uma configuração mais permissiva do Axis; uma conexão por API Key recebe os bindings configurados para ela.

Exemplo do comportamento esperado:

| Empresa | Conta/modelo | Destino | MCPs efetivos |
| --- | --- | --- |
| Empresa A | Claude Enterprise / modelo autorizado | Desktop | Somente MCPs predefinidos pelo administrador, exibidos como gerenciados |
| Empresa A | Ollama / modelo de código | Local Worker Windows | MCPs que a Empresa A vinculou explicitamente a esse modelo e destino |
| Empresa B | Provider X via API Key / modelo de código | Desktop | Skills, plugins, agents e MCPs vinculados àquela conexão/modelo pela Empresa B |

## Como ler o checklist

- `[x] BASE` — já existe no Axis em forma utilizável.
- `[ ] PARCIAL` — há uma parte implementada, mas ainda não há paridade funcional.
- `[ ] AUSENTE` — não foi encontrada implementação de produto no baseline.
- **Codex**, **Claude** ou **Ambos** indicam onde a função de referência existe.
- P1 é bloqueador da proposta de valor; P2 completa o ambiente de trabalho local; P3 adiciona automação local e criação multimodal; P4 cobre produtividade, distribuição e polimento no dispositivo.

## Diagnóstico do Axis hoje

O Axis já possui uma base importante:

- [x] BASE — aplicativo Electron local com renderer isolado, seletor nativo de pastas e persistência de janela.
- [x] BASE — conversas persistentes, follow-up, edição e reenvio de mensagem, cancelamento, renomear, arquivar, restaurar, excluir e pesquisar por título.
- [x] BASE — projetos com instruções, pasta opcional, Company canônica, políticas de conexão, privacidade e concorrência.
- [x] BASE — seleção explícita de modelo, provedor e conexão, incluindo Ollama, API Keys, perfis Claude e perfis ChatGPT/Codex.
- [x] BASE — Local Worker no Windows como destino especializado configurável, com URL/health route e descoberta de modelos.
- [x] BASE — pipeline Cowork de investigação, plano, edição, validação, revisão adversarial, reparo e memória de repositório.
- [x] BASE — Project Chat consegue montar, a cada turno, um contexto de repositório somente leitura com mapa do repo e excerpts ranqueados do folder pertencente ao Project; o índice reutilizável é particionado por Company.
- [x] BASE — resultados Cowork oferecem review estruturado do diff do último turno, com navegação por arquivo, hunks colapsáveis, números de linha, destaque de adições/remoções e acesso ao unified diff bruto.
- [x] BASE — Markdown básico, cópia, leitura em voz alta, progresso, lista de arquivos alterados e validações.
- [x] BASE — perfis separados de contas Claude e ChatGPT/Codex, com diretórios de runtime e autenticação isolados.
- [x] BASE — conexões nomeadas por API Key, armazenamento da chave no cofre do sistema e persistência somente de referências não secretas.
- [x] BASE — Company/Personal como contextos de primeira classe na sidebar, Company Hub scoped e Work Hub global agregado com filtros por Company.
- [x] BASE — armazenamento local de configuração sensível e histórico de roteamento.

A lacuna arquitetural é objetiva:

- O modo **Project Chat** continua deliberadamente não mutativo, mas agora lê contexto limitado do repositório pertencente ao Project antes de responder. Chat pessoal sem Project continua puramente conversacional. Ainda não existe um loop de tools em que o próprio modelo decida novas leituras durante o turno (`src/project-chat-context.ts`, `src/premium-agent.ts`).
- O modo **Cowork** não oferece ao modelo um catálogo geral de ferramentas. O host escolhe evidências, pede um plano estruturado, exige antecipadamente `editableFiles`/`contextFiles`, recebe arquivos completos em JSON e só executa validações de uma allowlist (`src/local-engineer.ts`, `src/executor.ts`, `src/validation.ts`).
- O review do último turno já saiu do `<pre>` único: a UI estrutura arquivos/hunks, linha antiga/nova e adições/remoções. Ainda faltam escopos Git reais (unstaged/staged/commit/branch), diff side-by-side, comentários inline, stage/unstage/revert, editor de arquivo e terminal integrado (`app/src/diff-review.ts`, `app/src/AgentSurfaceV2.tsx`).
- A seção Scheduled exibida no projeto é apenas apresentação; não existe scheduler de produto (`app/src/ProjectDetail.tsx`).
- O Axis gerencia alguns MCPs por perfis de conta, mas ainda não possui um host MCP universal com tools, resources, prompts, UI, elicitação, aprovações e escopo por empresa.

Portanto, a proposta exige três fundações inseparáveis: um **runtime agêntico único para múltiplas IAs**, um **modelo de contexto multiempresa** e uma **matriz de capabilities/MCPs por conta, modelo e destino de execução**.

---

# P1 — Multiempresa, conversa agêntica, arquivos, shell e Git

P1 é o mínimo para o Axis substituir Codex/Claude no trabalho diário. Nenhum item de P2 deve atrasar este conjunto.

Dentro de P1, **P1.5 — Empresas, contas, perfis e isolamento** é o primeiro bloco de implementação: o loop agêntico não deve crescer sobre um modelo de contexto ambíguo.

## P1.1 — Loop agêntico unificado entre IAs

- [ ] AUSENTE — Criar um protocolo de turnos com conteúdo textual, reasoning resumido, chamadas de ferramenta tipadas, resultados de ferramenta, anexos e erros. **Ambos**.
- [ ] AUSENTE — Implementar o ciclo `modelo → tool call → execução → tool result → modelo` até conclusão, pausa, cancelamento, limite ou pedido de decisão. **Ambos**.
- [ ] AUSENTE — Implementar uma única interface para as tools nativas do Axis em Ollama, Accounts, conexões por API Key e futuros adaptadores. **Objetivo Axis**.
- [ ] AUSENTE — Adaptar o tool calling de cada conexão e oferecer fallback seguro de saída estruturada para modelos sem tool calling confiável. **Objetivo Axis**.
- [ ] AUSENTE — Descobrir e exibir por conexão e modelo os limites, autenticação, thinking, multimodalidade, tool calling, MCPs e demais capacidades realmente disponíveis, independentemente do `authKind`. **Objetivo Axis**.
- [ ] AUSENTE — Representar separadamente capabilities nativas do Axis, capabilities fornecidas pela conexão/modelo e restrições administradas pelo provedor. **Objetivo Axis**.
- [ ] AUSENTE — Recalcular o conjunto efetivo de tools ao trocar conexão, modelo, projeto ou destino, mostrando antes quais capacidades entram, saem ou ficam bloqueadas. **Objetivo Axis**.
- [ ] AUSENTE — Tratar o Local Worker no Windows como destino especializado, com descoberta de modelos, health, latência, capabilities, modo inference-only/workspace e política de fallback próprios. **Objetivo Axis**.
- [ ] AUSENTE — Nunca substituir silenciosamente o modelo escolhido quando o Local Worker ficar indisponível; oferecer retry, outro destino compatível ou cancelamento. **Objetivo Axis**.
- [ ] AUSENTE — Falhar de forma explícita quando uma conexão não suporta uma capacidade solicitada; nunca trocar de empresa, Account, API Key ou modelo silenciosamente. **Objetivo Axis**.
- [ ] AUSENTE — Permitir que o agente descubra dinamicamente quais arquivos e comandos precisa usar, sem exigir a lista final de arquivos editáveis antes da exploração. **Ambos**.
- [ ] AUSENTE — Continuar o raciocínio após cada leitura, busca, comando, erro, diff e validação, inclusive mudando de estratégia. **Ambos**.
- [ ] AUSENTE — Suportar chamadas paralelas somente para ferramentas independentes e serializar mutações conflitantes. **Ambos**.
- [ ] AUSENTE — Aplicar limites por turno: tempo, tokens, tool calls, bytes lidos/escritos, processos e profundidade de repetição. **Ambos**.
- [ ] PARCIAL — Preservar streaming de texto, estado de thinking e progresso, acrescentando eventos de tool call/result em tempo real. **Ambos**.
- [ ] PARCIAL — Tornar cancelamento preemptivo: interromper modelo, comando, MCP, browser, subagente e processo em background, não apenas impedir a próxima etapa. **Ambos**.
- [ ] AUSENTE — Retry seletivo por falha de transporte/tool, com idempotência para mutações e sem repetir uma ação local incerta. **Ambos**.
- [ ] AUSENTE — Detectar loops improdutivos e pedir intervenção com evidências, em vez de encerrar genericamente ou consumir recursos indefinidamente. **Ambos**.
- [ ] PARCIAL — Reabrir e retomar sessões interrompidas no checkpoint exato, inclusive execuções que estavam aguardando permissão ou tinham processos vivos. **Ambos**.
- [ ] AUSENTE — Compactação automática de contexto com resumo verificável, preservando instruções, decisões, arquivos ativos, tool state e tarefas pendentes. **Ambos**.
- [ ] AUSENTE — Comando/ação manual de compactação e indicador real de janela de contexto. **Ambos**.
- [ ] PARCIAL — Troca de modelo/conexão no meio da sessão preservando histórico e compatibilidade de ferramentas, sem mudar a empresa ativa; Accounts e API Keys seguem o mesmo fluxo. **Ambos**.
- [ ] AUSENTE — Modos de transcript: resumo, normal e verboso, com expansão individual de reads, edits, commands, MCPs e resultados. **Claude**; equivalente de atividade no **Codex**.
- [ ] AUSENTE — Fila de mensagens: escolher se uma nova mensagem deve orientar imediatamente o turno ativo ou esperar o próximo turno. **Ambos**.
- [ ] AUSENTE — Steering durante execução sem cancelar: entregar correção no próximo boundary seguro de ferramenta. **Claude** e **Codex**.
- [ ] PARCIAL — Perguntas estruturadas com opções, recomendação e resposta livre devem ser parte do protocolo geral, não apenas do preflight Cowork. **Ambos**.
- [ ] PARCIAL — Diferenciar claramente plan, ask/explain, edit e full-agent sem criar dois produtos incompatíveis “Chat” e “Cowork”. A UI já explicita Chat/Cowork dentro do mesmo Project e Project Chat compartilha Company/Project/contexto de código, mas os runtimes ainda não convergiram para um único loop de tools. **Ambos**.

## P1.2 — Exploração e manipulação de arquivos

- [ ] AUSENTE — Tool `list_directory` com paginação, metadados, arquivos ocultos controlados e indicação de ignorados. **Ambos**.
- [ ] PARCIAL — Tool `read_file` com leitura integral ou por intervalo de linhas/bytes, números de linha e detecção de arquivo alterado. **Ambos**.
- [ ] PARCIAL — Tool `search_files` por glob/nome e `search_text` com regex, case, contexto, limites e respeito a `.gitignore`. **Ambos**.
- [ ] AUSENTE — Tool para `stat`, tipo MIME, encoding, tamanho, permissões e hash, sem tentar decodificar binários como UTF-8. **Ambos**.
- [ ] AUSENTE — Leitura segura de imagens, PDFs, áudio, vídeo, notebooks e outros formatos suportados, com preview adequado. **Ambos**.
- [ ] AUSENTE — `@mention` com autocomplete de arquivos/pastas/símbolos e anexação como contexto. **Claude**; contexto/links de arquivo no **Codex**.
- [ ] AUSENTE — Arrastar, colar e anexar imagens, PDFs e arquivos no composer, mostrando nome, tamanho, tipo, remoção e falha. **Ambos**.
- [ ] AUSENTE — Anexar mais de um arquivo/pasta e reaproveitar anexos em follow-ups sem reenviar silenciosamente conteúdo obsoleto. **Ambos**.
- [ ] AUSENTE — Suporte a múltiplas pastas locais por projeto, pasta primária e roots secundários somente quando explicitamente ligados. **Ambos**.
- [ ] PARCIAL — Tool de escrita atômica com detecção de conflito por versão/hash e opção de reaplicar, sobrescrever ou descartar. **Claude**.
- [ ] AUSENTE — Tool de patch/hunk com contexto, criação e alteração parcial; evitar substituir arquivos completos por padrão. **Ambos**.
- [ ] PARCIAL — Criar arquivos e diretórios, mantendo bloqueios contra escape de workspace e symlinks externos. **Ambos**.
- [ ] AUSENTE — Renomear, mover, copiar e excluir arquivos/diretórios com confirmação proporcional e operação recuperável quando possível. **Ambos**.
- [ ] AUSENTE — Edição de permissões/executável e suporte controlado a links simbólicos. **Ambos**.
- [ ] AUSENTE — Recarregar conteúdo modificado externamente e avisar sobre conflitos no editor/agent. **Claude**.
- [ ] AUSENTE — Menu por arquivo: anexar como contexto, abrir no editor interno, abrir em VS Code/Cursor/Zed/Xcode, revelar no Finder/Explorer e copiar caminho. **Ambos**.
- [ ] AUSENTE — Links clicáveis com arquivo e linha nas respostas, diffs, erros e resultados de busca. **Ambos**.
- [ ] AUSENTE — File tree pesquisável da sessão/projeto, com changed/open/recent files. **Claude**; arquivos no projeto/review do **Codex**.
- [ ] PARCIAL — Políticas de segredos devem classificar `.env`, chaves, certificados, tokens e credenciais; permitir exceção explícita e auditada quando necessária. **Ambos**.
- [ ] PARCIAL — Limites e UX para arquivos grandes: Project Chat já limita quantidade de arquivos e caracteres por evidence capsule, mas ainda faltam UX geral, chunking interativo e explicação uniforme de conteúdo omitido. **Ambos**.

## P1.3 — Shell, processos e ambiente

- [ ] AUSENTE — Tool de shell geral com `cwd`, argumentos sem shell quando possível, ambiente filtrado, timeout, saída incremental e exit code. **Ambos**.
- [ ] AUSENTE — Sessões PTY persistentes para comandos interativos autorizados. **Ambos**.
- [ ] AUSENTE — Escrever em stdin, enviar sinais, redimensionar PTY, poll/wait e terminar processos. **Ambos**.
- [ ] AUSENTE — Manter processos em background (servidor dev, watcher, teste) e referenciá-los por ID durante a conversa. **Ambos**.
- [ ] AUSENTE — Exibir stdout/stderr incremental, truncamento explícito, busca e download/cópia do log completo. **Ambos**.
- [ ] AUSENTE — Descobrir PATH/toolchain do shell de login e mostrar diagnóstico quando um binário existe no terminal do usuário mas não no app. **Ambos**.
- [ ] AUSENTE — Editor de variáveis de ambiente por empresa/projeto com referências ao cofre local e redaction. **Claude**; local environments no **Codex**.
- [ ] PARCIAL — Ampliar validações além da allowlist fixa por meio de aprovação e sandbox, mantendo presets seguros. **Ambos**.
- [ ] AUSENTE — Ações de projeto reutilizáveis, como Run, Test, Lint e Build, executadas no mesmo checkout da sessão. **Codex**; launch/preview no **Claude**.
- [ ] AUSENTE — Terminal integrado por sessão/worktree com múltiplas abas e compartilhamento de cwd/ambiente com o agente. **Ambos**.
- [ ] AUSENTE — Permitir ao agente ler o terminal integrado atual quando o usuário pedir para diagnosticar sua saída. **Codex**.

## P1.4 — Permissões, sandbox e segurança operacional

- [ ] AUSENTE — Implementar modos equivalentes: somente leitura/Plan, perguntar antes, aceitar edições, workspace-write, auto e acesso total/bypass. **Ambos**.
- [ ] AUSENTE — Mostrar o modo no composer, permitir troca durante a sessão e persistir default por empresa/projeto sem enfraquecer regras corporativas. **Ambos**.
- [ ] AUSENTE — Aprovação tipada para edit, delete, shell, acesso de rede, MCP, conector SaaS, browser e Computer Use. **Ambos**.
- [ ] AUSENTE — Opções `permitir uma vez`, `permitir nesta sessão`, `sempre permitir regra equivalente`, `negar` e `negar com instrução`. **Ambos**.
- [ ] AUSENTE — Prévia legível antes da aprovação: comando/args/cwd, patch, host/domínio, ferramenta MCP, destinatário ou app alvo. **Ambos**.
- [ ] AUSENTE — Regras persistentes por empresa para comando/tool/domínio/path, editáveis e revogáveis em Settings. **Ambos**.
- [ ] AUSENTE — Sandbox real do processo agente, com perfis read-only, workspace-write e full access; não depender somente de validações de caminho no Node. **Ambos**.
- [ ] AUSENTE — Rede negada por padrão no sandbox, liberando somente endpoints Ollama, contas, MCPs, SaaS e domínios autorizados para a empresa ativa. **Ambos**.
- [ ] AUSENTE — Nunca permitir que uma mensagem web, arquivo, MCP ou agente filho eleve as próprias permissões. **Ambos**.
- [ ] AUSENTE — Auditoria por sessão de todas as aprovações, negações, regras aplicadas e ações sensíveis. **Ambos**.
- [ ] AUSENTE — Redaction consistente de segredos em prompt, tool result, terminal, diff, log e export local. **Ambos**.
- [ ] PARCIAL — Resolver API Keys somente no main process/adapter no momento da chamada; o Connection Center já mantém segredo fora do renderer e usa referências estáveis, mas a regra ainda precisa cobrir o futuro loop geral de tools/plugins/MCPs. **Objetivo Axis**.
- [ ] PARCIAL — Injetar a chave apenas no header/campo exigido pelo provider, com redaction de requests, respostas de erro, traces e diagnósticos; adapters atuais fazem a chamada sem devolver a chave à UI, porém a política transversal ainda não existe. **Objetivo Axis**.
- [ ] PARCIAL — Validar endpoint customizado, TLS e redirects antes de enviar uma API Key, impedindo vazamento para host diferente do configurado. O lifecycle já preserva endpoint por conexão, mas ainda falta hardening completo de redirect/TLS/proxy. **Objetivo Axis**.
- [x] BASE — Teste de API Key usa operação mínima/não mutativa e não registra nem devolve a chave à UI. **Objetivo Axis**.
- [ ] PARCIAL — Política deny-by-default de capabilities precisa governar as ferramentas reais do loop, e não apenas metadados enviados ao provedor. **Objetivo Axis**.

## P1.5 — Empresas, contas, perfis e isolamento

- [x] BASE — Projetos já possuem Company/`organizationId`, política de conexão, privacidade, memória e workspace separados no dispositivo.
- [x] BASE — Perfis Claude e ChatGPT/Codex usam diretórios de configuração separados e não copiam credenciais OAuth para o Axis.
- [x] BASE — Adotar um modelo canônico e visível `empresa → conexões/recursos → projetos → sessões`; “organização”, “workspace” e “perfil corporativo” não podem representar conceitos conflitantes. **Objetivo Axis**.
- [x] BASE — Criar, editar, arquivar, restaurar, ordenar, buscar e identificar empresas por nome, cor, ícone e descrição, tudo persistido localmente. **Objetivo Axis**.
- [x] BASE — Manter um contexto Pessoal separado das empresas, sem herança implícita de contas, histórico ou recursos corporativos. **Objetivo Axis**.
- [x] BASE — Seletor de empresa sempre visível no chrome, no composer, nas aprovações e nos resultados; trocar de empresa exige uma ação explícita. **Objetivo Axis**.
- [x] BASE — Central de conexões capaz de registrar vários Accounts e várias API Keys do mesmo provedor, com nome amigável, empresa proprietária, `authKind`, restrições administradas e estado. **Objetivo Axis**.
- [x] BASE — Suportar Ollama, perfil Claude, perfil ChatGPT/Codex, API Key com endpoint oficial/customizado e futuros adaptadores como conexões independentes; nenhum deles é obrigatório para os demais funcionarem. **Objetivo Axis**.
- [x] BASE — O mesmo formulário/base de detalhes deve atender Account e API Key, variando somente autenticação e campos específicos do provedor. **Objetivo Axis**.
- [x] BASE — Adicionar, nomear, testar, editar endpoint/headers permitidos, rotacionar chave, desabilitar e remover uma conexão por API Key. **Objetivo Axis**.
- [x] BASE — Permitir várias API Keys do mesmo provedor na mesma empresa ou em empresas diferentes, sem colisão de nome, credencial, uso ou configuração. **Objetivo Axis**.
- [ ] PARCIAL — Descobrir/atualizar o catálogo de modelos pela API Key quando o provedor permitir; OpenAI/Anthropic já usam `listModels`, mas falta um catálogo configurável de fallback para providers sem discovery. **Objetivo Axis**.
- [ ] PARCIAL — Armazenar por modelo de uma conexão API Key context window, preços conhecidos, multimodalidade, tool calling, structured output e limites específicos. `ModelDefinition`/catálogo já carregam parte dos limites/capabilities, mas não toda a matriz de preço/capability por conexão. **Objetivo Axis**.
- [ ] AUSENTE — Central de destinos capaz de registrar o desktop atual e um ou mais Local Workers Windows, mostrando host, versão, health, modelos e modo de execução suportado. **Objetivo Axis**.
- [x] BASE — Vincular cada instância de conexão a exatamente uma empresa; reutilizar a mesma identidade em outra empresa exige criar um vínculo explícito e separado. **Objetivo Axis**.
- [x] BASE — Testar, autenticar/reautenticar ou validar/rotacionar chave, desconectar, desabilitar e remover conexão sem afetar os outros Accounts/API Keys do mesmo provedor. **Ambos**.
- [ ] PARCIAL — Mostrar inventário por conexão e modelo: Connection Center já mostra identidade, `authKind`, Company, provider, estado e restrições administradas; ainda faltam limites/MCPs/skills/plugins/agents/capabilities completos por modelo. **Objetivo Axis**.
- [ ] PARCIAL — Permitir defaults por empresa e projeto para conexão, modelo, destino de execução, esforço, modo de interação e estratégia de fallback. Projects já possuem defaults/policies de conexão/modelo; ainda faltam defaults completos de Company/destino/mode/fallback. **Objetivo Axis**.
- [ ] PARCIAL — Fallback entre conexões somente dentro da allowlist da mesma empresa: o Project runtime já limita candidates à política/Company, mas ainda falta confirmação explícita quando identidade, custo ou Account/API Key mudar. **Objetivo Axis**.
- [ ] AUSENTE — Rate limit, quota, falha e circuit breaker são calculados por conexão/credential reference, não apenas por provedor. **Objetivo Axis**.
- [x] BASE — API Keys ficam no Keychain/cofre do SO; credenciais de Account ficam no runtime oficial; arquivos locais guardam somente referências e metadados não secretos. **Objetivo Axis**.
- [ ] PARCIAL — Fixar empresa, projeto, conexão, modelo, destino, roots e conjunto efetivo de recursos na criação da sessão; Company e Project já são validados/fixados pelo runtime e nunca vêm como autoridade do renderer, mas modelo/destino/resources ainda não formam um snapshot imutável completo. **Objetivo Axis**.
- [ ] PARCIAL — Definir precedência verificável: regras de segurança do app → empresa → projeto → sessão; isolamento de Company e Project instructions já é aplicado, mas ainda falta um resolver/inspector uniforme para todos os tipos de recurso. **Objetivo Axis**.
- [ ] AUSENTE — Inspector “Contexto efetivo” mostrando conexão/`authKind`, modelo, destino, instruções, padrões, skills, plugins, MCPs disponíveis/bloqueados, agents, hooks, memória, variáveis, roots e políticas, com origem de cada item. **Objetivo Axis**.
- [ ] AUSENTE — Configurar por empresa suas peculiaridades: linguagem, glossário, stack, padrões de código, comandos, Git workflow, templates, revisão, apps permitidos e critérios de conclusão. **Objetivo Axis**.
- [ ] AUSENTE — Templates de projeto por empresa que instalam o conjunto correto de instruções, skills, MCPs, agentes e validações sem duplicação manual. **Objetivo Axis**.
- [ ] PARCIAL — Perfil de browser/cookies, processos, worktrees, anexos, memória e índices isolados por empresa e depois por projeto. O índice reutilizável de Project Chat já é particionado por Company; browser/process/worktree/attachments ainda não existem como recursos completos. **Objetivo Axis**.
- [ ] PARCIAL — Bloquear por construção acesso cruzado a pastas, segredos, Accounts, API Keys, MCPs, cookies, processos, worktrees e históricos de outra empresa. Jobs, Projects, Connections e históricos já falham fechados no Company scope; recursos ainda inexistentes e o futuro loop geral precisam herdar a mesma garantia. **Objetivo Axis**.
- [ ] AUSENTE — Um mesmo caminho físico não pode ser associado a empresas conflitantes sem migração ou compartilhamento local explícito, limitado e registrado. **Objetivo Axis**.
- [x] BASE — Mover Companies para uma superfície de contexto de primeira classe fora de Settings, listando Personal + Companies na sidebar primária. **Objetivo Axis**.
- [x] BASE — Ao selecionar uma Company, abrir uma sidebar secundária Company-scoped com Overview, Projects, Connections, MCPs, Skills e Settings; cada seção usa somente o contexto canônico daquela Company. **Objetivo Axis**.
- [x] BASE — Administrar Sources/connections dentro da Company proprietária; configuração de fonte não pertence ao Work Hub global. **Objetivo Axis**.
- [x] BASE — Manter um único **Work Hub global e de primeira classe**, sem Work Hubs duplicados por Company, agregando Personal + todas as Companies em Inbox, My Work, Today, Calendar e Sources. **Objetivo Axis**.
- [x] BASE — Usar `All` como escopo padrão do Work Hub e oferecer filtros explícitos por Company/Personal, mantendo Company identity visível em todos os itens. **Objetivo Axis**.
- [x] BASE — Preservar provenance/ownership no Work Hub, no mínimo `companyId`, `connectionId` e `sourceId`, para que agregação nunca apague isolamento. **Objetivo Axis**.
- [x] BASE — Tratar Work Hub `Sources` como superfície agregada de visibilidade/health; edição e administração continuam na Company proprietária. **Objetivo Axis**.
- [x] BASE — Permitir que Company Overview mostre resumo scoped e abra o Work Hub global já filtrado para aquela Company. **Objetivo Axis**.
- [x] BASE — Manter no Axis Settings global somente configurações app-wide; configurações específicas de Company pertencem ao Company Hub. **Objetivo Axis**.
- [ ] AUSENTE — Busca global pode pesquisar várias empresas somente quando o usuário pedir; resultados nunca misturam trechos no contexto de uma sessão. **Objetivo Axis**.
- [ ] AUSENTE — Mover/copiar projeto, conversa, skill ou padrão entre empresas exige preview do que será copiado, remoção de segredos e confirmação do destino. **Objetivo Axis**.
- [ ] AUSENTE — Exportar a ficha de isolamento da sessão: empresa, projeto, conexão, paths, MCPs, regras, rede e arquivos persistidos. **Objetivo Axis**.
- [ ] AUSENTE — Exportar/importar um pacote local de configuração da empresa sem credenciais, permitindo backup e onboarding manual sem backend Axis. **Objetivo Axis**.
- [ ] PARCIAL — Testes de não vazamento entre pelo menos duas empresas, dois Accounts, duas API Keys do mesmo provedor, dois provedores e um Local Worker, inclusive cancelamento, retry, fallback, crash e restauração. Já há contratos/regressões multi-Company e visual smoke real para Company/Connections/Work Hub; ainda falta a matriz E2E completa de falhas/restauração. **Objetivo Axis**.

## P1.6 — Git, diff e revisão

- [ ] PARCIAL — Review do último turno já possui file list, hunks colapsáveis, números old/new, adições/remoções coloridas e navegação; ainda faltam syntax highlighting de linguagem e uma pane dedicada independente do transcript. **Ambos**.
- [ ] PARCIAL — Escopos Unstaged, Staged, Commit, Branch/base e Last turn; `Last turn` agora é identificado explicitamente, mas os demais escopos Git ainda não existem. **Codex**; diff de sessão no **Claude**.
- [ ] AUSENTE — Mostrar alterações do usuário e de outras ferramentas, não apenas as produzidas pelo pipeline Axis. **Ambos**.
- [ ] PARCIAL — Diff unified, collapse por arquivo/hunk e navegação já existem no review do último turno; faltam side-by-side, wrap configurável e busca. **Ambos**.
- [ ] AUSENTE — Comentários inline em linhas/hunks, fila de comentários e envio conjunto como instrução ao agente. **Ambos**.
- [ ] AUSENTE — Review automático sob demanda com achados inline, severidade, evidência e ação “corrigir”. **Ambos**.
- [ ] AUSENTE — Stage/unstage/revert por hunk, arquivo e conjunto; confirmação forte para revert. **Codex**; controles de diff no **Claude**.
- [ ] AUSENTE — Criar/renomear branch e criar commits locais com mensagem revisável pelo app. **Ambos**.
- [ ] AUSENTE — Detectar working tree suja antes da sessão e preservar mudanças preexistentes durante edição, rollback e handoff. **Ambos**.
- [ ] AUSENTE — Resolver conflitos de merge/rebase com preview e aprovação; nunca descartar alterações silenciosamente. **Ambos**.
- [ ] AUSENTE — Worktree Git automático por sessão paralela, com branch prefix configurável e setup script. **Ambos**.
- [ ] AUSENTE — Opção de trabalhar no checkout atual quando o usuário escolher, deixando o risco claro. **Ambos**.
- [ ] AUSENTE — Snapshot/restore antes de remover worktree e limpeza segura por retenção/arquivo. **Codex**; archive worktree no **Claude**.
- [ ] AUSENTE — Handoff seguro entre checkout local e worktree. **Codex**.
- [ ] AUSENTE — Diff/review multi-repositório para projetos locais com mais de uma pasta/repo. **Codex**; múltiplos repositórios no **Claude**.

## Gate de conclusão do P1

P1 só termina quando os testes E2E comprovarem o fluxo com Ollama, Local Worker, Account e API Key vinculados a empresas diferentes:

- [ ] A partir de “corrija o bug de login”, o agente pesquisa o repo sem lista prévia de arquivos, lê o necessário, edita por patch, executa testes, corrige uma falha e entrega um diff revisável.
- [ ] O usuário consegue orientar o agente durante uma execução, negar um comando, aprovar outro, comentar duas linhas no diff e pedir uma nova iteração.
- [ ] Duas sessões do mesmo repo rodam em paralelo sem conflito por worktrees.
- [ ] Duas empresas rodam em paralelo sem cruzamento de conta, pasta, MCP, skill, memória, processo, browser ou padrão.
- [ ] Duas contas do mesmo provedor podem estar autenticadas simultaneamente, ser identificadas sem ambiguidade e nunca trocar de perfil durante uma execução.
- [ ] Duas API Keys do mesmo provedor funcionam como conexões completas e distintas, cada uma com modelos, recursos, políticas, limites e uso próprios.
- [ ] Um Account e uma API Key podem usar o mesmo modelo nominal sem compartilhar MCPs, skills, plugins, agents ou credenciais.
- [ ] O mesmo modelo pode rodar no destino principal ou no Local Worker quando ambos forem compatíveis, sem alterar empresa, projeto, MCPs ou políticas.
- [ ] Crash/restart restaura conversa, estado Git e checkpoint sem duplicar mutações locais.

---

# P2 — Ambiente local completo, computador, previews e extensibilidade

## P2.1 — Browser, preview e Computer Use

- [ ] AUSENTE — Browser integrado em pane, com abas, perfil isolado, histórico próprio, downloads e abertura pelo chat. **Ambos**.
- [ ] AUSENTE — Preview automático de servidor local, detecção/configuração de comandos, porta e cwd. **Ambos**.
- [ ] AUSENTE — Gerenciar múltiplos servidores, iniciar/parar, detectar conflito de porta e selecionar porta livre. **Claude**; actions/terminal no **Codex**.
- [ ] AUSENTE — Persistir opcionalmente cookies/localStorage do preview e limpar dados pela Settings. **Ambos**.
- [ ] AUSENTE — Ferramentas de DOM, screenshot, click, type, forms, console e network para o agente verificar UI. **Ambos**.
- [ ] AUSENTE — Auto-verify após edições quando houver servidor configurado, com loop screenshot/DOM/console/fix. **Claude**; verificação guiada no **Codex**.
- [ ] AUSENTE — Anotação visual por elemento ou área e feedback de fonte, texto, spacing e cor. **Codex**; seleção/preview no **Claude**.
- [ ] AUSENTE — Browser externo com allowlist por domínio, aprovação `once/always/deny` e proteção contra prompt injection. **Ambos**.
- [ ] AUSENTE — Escolher entre perfil isolado do app e browser pessoal autenticado por extensão. **Ambos**.
- [ ] AUSENTE — Developer mode/CDP para DOM, estilos, console, network e performance trace, sempre com aprovação explícita. **Codex**.
- [ ] AUSENTE — Computer Use em macOS/Windows: screenshot, clique, scroll, texto, drag, teclado e clipboard em apps aprovados. **Ambos**.
- [ ] AUSENTE — Onboarding de Accessibility/Screen Recording e diagnóstico do estado das permissões. **Ambos**.
- [ ] AUSENTE — Aprovação por aplicativo e tiers de controle; lista de apps negados/sempre permitidos e revogação. **Ambos**.
- [ ] AUSENTE — Picture-in-picture/stream visual para acompanhar e interromper o controle do computador. **Codex**; acompanhamento no **Claude**.
- [ ] AUSENTE — Seleção de ferramenta mais precisa: MCP/API → shell → browser/DOM → simulador → Computer Use. **Ambos**.
- [ ] AUSENTE — Appshots/captura da janela frontal, incluindo imagem e texto acessível, anexada à conversa. **Codex**.
- [ ] AUSENTE — Pane dedicada para iOS Simulator com build, execução, screenshot e interação. **Claude**; Computer Use/Xcode no **Codex**.

## P2.2 — Editor, renderização e artefatos de arquivo

- [ ] AUSENTE — Pane de arquivo com syntax highlighting, edição pontual, salvar, descartar e conflito de alteração externa. **Claude**.
- [ ] PARCIAL — Renderizador CommonMark/GFM completo: listas aninhadas, task lists, escaping, links relativos seguros, imagens, footnotes e blocos extensíveis. **Ambos**.
- [ ] AUSENTE — Highlight de código, nome da linguagem, copiar bloco, wrap e abertura do snippet/arquivo. **Ambos**.
- [ ] AUSENTE — Sanitização robusta contra HTML/script/URL perigosa sem degradar conteúdo legítimo. **Ambos**.
- [ ] AUSENTE — Renderização de Mermaid/diagramas, matemática e visualizações quando suportadas. **Ambos**.
- [ ] AUSENTE — Preview de Markdown e HTML com alternância rendered/source. **Codex**; Artifacts no **Claude**.
- [ ] AUSENTE — Preview visual de PDF, DOCX, PPTX, XLSX/CSV, imagens, áudio e vídeo. **Codex**; arquivos/artifacts no **Claude**.
- [ ] AUSENTE — Anotações em documentos, slides, planilhas, Markdown, sites e imagens, ligadas à próxima instrução. **Codex**; artifact feedback no **Claude**.
- [ ] AUSENTE — Versionamento de artefatos/arquivos gerados com comparação, restore, download e “open in”. **Claude**.
- [ ] AUSENTE — Cards de saída com caminho real, tipo, tamanho, preview, validações e ação de revelar/abrir. **Ambos**.

## P2.3 — Sessões paralelas, subagentes e coordenação

- [ ] PARCIAL — Rodar várias sessões simultaneamente com scheduler por recursos, não apenas jobs concorrentes sobre o mesmo checkout. **Ambos**.
- [ ] PARCIAL — Filtros de sessão por status, empresa, conexão, `authKind`, projeto e ambiente; a Company ativa já filtra Jobs/Projects/histórico e conversas ficam agrupadas sob Projects, mas ainda não há uma busca/filtro cross-Company deliberada por todos esses campos. **Claude**; Activity/Projects no **Codex**.
- [ ] AUSENTE — Abrir duas sessões lado a lado e alternar foco sem perder panes. **Claude**.
- [ ] AUSENTE — Layout de panes arrastável/redimensionável: chat, diff, browser, terminal, file, plan, tasks e subagent. **Claude**; panes no **Codex**.
- [ ] AUSENTE — Side chat que lê o contexto até aquele ponto sem contaminar a conversa principal. **Claude**.
- [ ] AUSENTE — Subagentes com prompt, conexão/modelo permitido pela empresa, esforço, instruções, permissões e limites de recursos próprios. **Ambos**.
- [ ] AUSENTE — Escolher destino de execução por subagente, incluindo Local Worker Windows, respeitando capabilities, isolamento e capacidade concorrente do destino. **Objetivo Axis**.
- [ ] AUSENTE — Spawn paralelo, status active/done, abrir thread, esperar, orientar, interromper e fechar subagente. **Ambos**.
- [ ] AUSENTE — Resumo estruturado do subagente para o principal, sem despejar toda a saída no contexto pai. **Ambos**.
- [ ] AUSENTE — Custom agents por função (explorer, reviewer, security, tester) definidos na empresa, projeto ou usuário. **Ambos**.
- [ ] AUSENTE — Tasks pane para subagentes, comandos em background e workflows dinâmicos, com output e stop. **Claude**.
- [ ] AUSENTE — O agente pode listar, ler, renomear, arquivar e enviar mensagens somente a sessões da mesma empresa, salvo transferência explícita pelo usuário. **Claude**; ferramentas de task no **Codex**.
- [ ] AUSENTE — Mensagem cross-session com autoria, backlink, fila quando destino está ocupado e inbound policy. **Claude**; coordenação no **Codex**.
- [ ] AUSENTE — Sugestão de nova sessão para trabalho fora do escopo, criando worktree sem interromper a atual. **Claude**.

## P2.4 — MCPs, conectores e ferramentas por empresa

- [x] BASE — Perfis Claude e ChatGPT/Codex podem descobrir, adicionar, autenticar e remover MCPs usando seus runtimes oficiais.
- [x] BASE — Work Hub já agrega subconjuntos de calendário, tickets e mensagens preservando a conexão de origem.
- [ ] AUSENTE — Implementar um host MCP nativo no Axis, mantendo compatibilidade com MCPs descobertos nas várias contas sem depender de uma conta específica. **Ambos**.
- [ ] AUSENTE — Suportar MCP local via stdio e MCP remoto via Streamable HTTP/SSE, sempre com conexão direta do desktop, lifecycle, restart, timeout e health. **Ambos**.
- [ ] AUSENTE — Configurar executável/args/cwd ou URL/headers, usando referências ao cofre local sem expor segredos ao renderer ou ao modelo. **Ambos**.
- [ ] AUSENTE — OAuth iniciado pelo desktop ou runtime oficial, com callback seguro e credenciais mantidas no perfil da empresa, sem servidor de autenticação do Axis. **Ambos**.
- [ ] AUSENTE — Tools, resources, prompts, resource templates, roots, sampling, elicitation e notifications conforme capacidades negociadas. **Ambos**.
- [ ] AUSENTE — Tool discovery lazy/search para catálogos grandes, evitando inchar o contexto. **Codex**; tool search equivalente no ecossistema.
- [ ] AUSENTE — Aprovação por chamada MCP, preview dos argumentos e destaque claro de leitura versus mutação. **Ambos**.
- [ ] AUSENTE — MCP Apps/UI resources em sandbox local, com comunicação tipada e revisão de permissões. **Codex**; MCP Apps padrão.
- [ ] AUSENTE — Modelar quatro origens de MCP: gerenciado pelo Axis/local, gerenciado pelo Axis/remoto, descoberto em Account/API e administrado/bloqueado pelo provedor. **Objetivo Axis**.
- [ ] AUSENTE — Cada configuração MCP pertence a uma empresa e pode ser vinculada a Accounts, conexões por API Key e modelos específicos; habilitação e allowlist de tools podem ser refinadas por projeto, sessão e agendamento. **Objetivo Axis**.
- [ ] AUSENTE — Conexões por API Key podem receber MCPs gerenciados pelo Axis mesmo que a API do provedor não tenha configuração própria de MCP; o runtime Axis executa o loop de tools. **Objetivo Axis**.
- [ ] AUSENTE — Quando a API/modelo não suporta tool calling confiável, aplicar o fallback estruturado do runtime ou marcar o MCP incompatível com explicação, sem rebaixar toda conexão API Key. **Objetivo Axis**.
- [ ] AUSENTE — Permitir que modelos diferentes da mesma empresa recebam conjuntos de MCPs diferentes, inclusive quando usam o mesmo provedor ou a mesma conexão. **Objetivo Axis**.
- [ ] AUSENTE — Calcular MCPs efetivos pela interseção entre vínculo empresa/conexão/modelo, capabilities declaradas, política corporativa, regras de projeto/sessão e restrições do provedor. **Objetivo Axis**.
- [ ] AUSENTE — Contas administradas, como Claude Enterprise, exibem MCPs predefinidos pelo administrador como read-only e impedem adicionar servidores não autorizados naquele perfil. **Objetivo Axis**.
- [ ] AUSENTE — Quando o provedor bloquear add/remove/configure, a UI explica “gerenciado pela sua empresa” e oferece apenas refresh/reautenticação compatíveis. **Objetivo Axis**.
- [ ] AUSENTE — Descobrir novamente capabilities e MCPs após login, troca de organização na conta, mudança de modelo ou alteração administrativa externa. **Objetivo Axis**.
- [ ] AUSENTE — Distinguir execução de MCP pelo host Axis da execução delegada ao runtime do Account/provedor; tools provider-managed não devem ser copiadas ou simuladas fora daquele runtime. **Objetivo Axis**.
- [ ] AUSENTE — Ao trocar conexão/modelo, mostrar o diff de MCPs disponíveis, indisponíveis e novos antes de confirmar; histórico anterior permanece identificado pela origem. **Objetivo Axis**.
- [ ] AUSENTE — Se a conversa depende de uma tool ausente no novo modelo, bloquear continuação automática e oferecer voltar, escolher modelo compatível ou seguir sem a capability. **Objetivo Axis**.
- [ ] AUSENTE — Subagentes podem usar conexão/modelo diferentes, mas cada um recebe seu próprio conjunto efetivo de MCPs e não herda implicitamente tools do agente pai. **Objetivo Axis**.
- [ ] AUSENTE — Importar/espelhar MCPs de vários perfis Claude, ChatGPT/Codex e APIs sem mesclar credenciais, nomes ou políticas de empresas diferentes. **Objetivo Axis**.
- [ ] AUSENTE — Catálogo central agrupado por empresa com busca, status, descrição, origem, conexão/`authKind`, permissões e ações reconnect/reconfigurar. **Objetivo Axis**.
- [ ] AUSENTE — Mostrar claramente quando uma tool enviará dados para um SaaS ou MCP remoto, incluindo empresa, conexão, host e campos relevantes. **Objetivo Axis**.
- [x] BASE — Work Hub global multiempresa com `All` por padrão, filtros Company/Personal e badges de origem, sem transformar conteúdo de uma empresa em contexto de outra nem criar Work Hubs duplicados por Company. **Objetivo Axis**.
- [ ] AUSENTE — Trace local por tool com empresa, MCP, origem/ownership, conexão/`authKind`, modelo, destino de execução, duração, bytes, resultado e erro. **Ambos**.
- [ ] AUSENTE — Defesa contra instrução maliciosa em tool result/resource e proibição de elevação de privilégio. **Ambos**.

## P2.5 — Skills, plugins, instruções, hooks e memória

- [ ] PARCIAL — Descobrir e aplicar `AGENTS.md` hierárquico; hoje o agente possui instruções de projeto, mas não paridade de escopo/precedência. **Codex**.
- [ ] AUSENTE — Descobrir e aplicar `CLAUDE.md`/`CLAUDE.local.md` hierárquico quando o usuário optar por compatibilidade. **Claude**.
- [ ] AUSENTE — UI que mostre quais instruções pessoais, empresariais e de projeto foram carregadas, incluindo origem e precedência. **Ambos**.
- [ ] AUSENTE — Skills pessoais, de empresa e de projeto com descoberta por descrição, invocação `$`/`/`, recursos e scripts auxiliares. **Ambos**.
- [ ] AUSENTE — Criar, editar, validar, instalar, habilitar, desabilitar e remover skills no app. **Ambos**.
- [ ] AUSENTE — Descobrir e importar skills, agents, comandos, padrões e memórias existentes nos perfis Claude e ChatGPT/Codex, sempre para uma empresa de destino explícita. **Objetivo Axis**.
- [ ] AUSENTE — Vincular skills, plugins, agents, hooks e padrões também a conexões por API Key e a modelos específicos, com a mesma UX disponível para Accounts. **Objetivo Axis**.
- [ ] AUSENTE — Resolver conflitos de mesmo nome por origem/escopo e mostrar qual versão será efetivamente usada na sessão. **Objetivo Axis**.
- [ ] AUSENTE — Pacotes de capacidades por empresa reunindo instruções, padrões, skills, agents, MCPs, hooks, templates e validações. **Objetivo Axis**.
- [ ] AUSENTE — Ativar/desativar um pacote por projeto e visualizar o diff de contexto antes de aplicá-lo. **Objetivo Axis**.
- [ ] AUSENTE — Plugins que agrupem skills, MCPs, hooks, agents/LSPs, assets e templates de automação. **Ambos**.
- [ ] AUSENTE — Biblioteca local de plugins com busca, detalhes, importação de pasta/pacote, validação, enable/disable e uninstall. **Ambos**.
- [ ] AUSENTE — Escopo de plugin pessoal/empresa/projeto e regras de allow/deny/assinatura definidas pela empresa. **Claude**; controles de workspace no **Codex**.
- [ ] AUSENTE — Hooks de lifecycle antes/depois de tool, edit, command, turn, subagent e session, com timeout e decisão allow/deny. **Ambos**.
- [ ] AUSENTE — Rules declarativas para comandos e ferramentas, separadas de hooks executáveis. **Codex**; permissions rules no **Claude**.
- [ ] AUSENTE — Memória automática pessoal, por empresa e por projeto/repo, editável, deletável, com fonte, freshness e isolamento. **Ambos**.
- [ ] PARCIAL — Integrar a Repo Intelligence atual ao contexto visível da sessão e permitir inspecionar/esquecer fatos. Project Chat já injeta mapa + excerpts ranqueados do Project com índice particionado por Company, mas a UI ainda não oferece inspector/fatos editáveis. **Ambos**.
- [ ] AUSENTE — Importar configuração/memória de outro agente de forma revisável e sem copiar credenciais. **Codex**.
- [ ] AUSENTE — Record & Replay de um fluxo de UI para gerar uma skill reutilizável. **Codex**.

## Gate de conclusão do P2

- [ ] O agente altera uma aplicação web, inicia o servidor, abre o preview, detecta erro de console/DOM, corrige e comprova visualmente.
- [ ] Ollama, uma conta Claude, uma conta ChatGPT/Codex e uma conexão por API Key usam o mesmo runtime de MCP, skill, plugin, agent, hook, browser e subagente sob as políticas da empresa ativa.
- [ ] A tela de uma conexão API Key permite configurar os mesmos recursos de uma conexão Account; somente a seção de autenticação é diferente.
- [ ] Duas empresas podem possuir MCPs e skills de mesmo nome com configurações diferentes sem colisão ou vazamento.
- [ ] Dois modelos da mesma conta podem expor conjuntos de MCPs distintos e a UI atualiza o conjunto efetivo sem confundir histórico ou permissões.
- [ ] Uma conta Claude Enterprise com MCPs administrados usa somente o catálogo liberado pela empresa e não recebe controles falsos para instalar MCPs externos.
- [ ] Um subagente em outro modelo não consegue invocar um MCP que existe apenas no modelo do agente principal.
- [ ] Arquivos Markdown, HTML, PDF, imagem e planilha abrem em preview e aceitam feedback localizado.
- [ ] Computer Use só opera apps autorizados para a empresa ativa, é visível, interrompível e não consegue furar sandbox/regras corporativas.

---

# P3 — Agendamentos locais e criação multimodal

## P3.1 — Tarefas agendadas e rotinas

- [ ] AUSENTE — Formato local e versionado de automação: nome, prompt, status, empresa, projeto, `connectionId`/`authKind`, modelo, effort, permissões e timezone. **Ambos**.
- [ ] AUSENTE — Cadências hourly/daily/weekly/weekdays, intervalos em minutos e RRULE avançada. **Ambos**.
- [ ] AUSENTE — Criar agendamento por conversa e por formulário manual, com confirmação explícita. **Ambos**.
- [ ] AUSENTE — Heartbeat na conversa existente para preservar contexto e tarefa standalone com nova sessão por execução. **Codex**.
- [ ] AUSENTE — Execução somente local no checkout ou worktree dedicado; computador, app e a conexão de IA escolhida precisam estar disponíveis. **Ambos**.
- [ ] AUSENTE — `/loop`/monitor temporário dentro da sessão, executado pelo scheduler local. **Claude**; heartbeat no **Codex**.
- [ ] AUSENTE — Scheduled inbox com active/paused/completed, unread, próxima execução, histórico e output de cada run. **Ambos**.
- [ ] AUSENTE — Pause, resume, edit, run now, retry, duplicate e delete. **Ambos**.
- [ ] AUSENTE — Silêncio quando não há mudança relevante e notificação local por conclusão, falha ou intervenção. **Codex**.
- [ ] AUSENTE — Limites de tempo/tokens/processos por automação e por run, concorrência, backoff, deduplicação e circuit breaker. **Objetivo Axis**.
- [ ] AUSENTE — Agendamentos unattended usam política segura e não ficam presos esperando aprovação impossível. **Ambos**.
- [ ] AUSENTE — Agendamento fixa empresa, conexão, skills, MCPs, roots e políticas na criação; alterações posteriores exibem impacto antes da próxima execução. **Objetivo Axis**.
- [ ] AUSENTE — Agendamento fixa também modelo, destino de execução e conjunto efetivo de MCPs; mudança administrativa incompatível pausa o run em vez de improvisar outra configuração. **Objetivo Axis**.
- [ ] AUSENTE — Falha de autenticação, API Key ou limite de uma conexão pausa somente as automações que dependem dela e identifica empresa/conexão afetadas. **Objetivo Axis**.
- [ ] AUSENTE — Limpeza/retention de runs, logs e worktrees sem perder entregáveis referenciados. **Ambos**.
- [ ] AUSENTE — Restaurar o calendário após reiniciar o app usando somente o estado persistido no dispositivo e sem duplicar execuções. **Objetivo Axis**.

## P3.2 — Imagens, voz, sites e visualizações locais

- [ ] AUSENTE — Geração e edição de imagens por ferramenta/modelo instalado localmente, com referências, feedback localizado, versões e salvamento no workspace. **Codex**; artifacts no **Claude**.
- [ ] AUSENTE — Entrada de múltiplas imagens/screenshot com preview e comparação. **Ambos**.
- [ ] AUSENTE — Voice input/conversation por mecanismo local e controles de voz por superfície; manter TTS atual como fallback. **Codex**; recursos gerais do **Claude** quando disponíveis.
- [ ] AUSENTE — Sites/apps interativos gerados, preview, source e iteração inteiramente no workspace local. **Codex Sites**; **Claude Artifacts**.
- [ ] AUSENTE — Visualizações interativas, diagramas e pequenos simuladores dentro da conversa. **Codex Visualizations**; **Claude Artifacts**.
- [ ] AUSENTE — Artefatos com versionamento, fork e exportação para arquivo local. **Claude**.

## Gate de conclusão do P3

- [ ] Duas automações de empresas distintas usam conexões, MCPs, skills e worktrees diferentes sem compartilhar contexto ou credenciais.
- [ ] Uma automação semanal modifica seu worktree local e só notifica em mudança relevante, sem serviço do Axis em segundo plano fora do computador.
- [ ] Reiniciar o aplicativo preserva agenda e histórico local sem duplicar a próxima execução.
- [ ] Um artefato multimodal pode ser criado, revisado, versionado e exportado sem upload para infraestrutura do Axis.

---

# P4 — Produtividade, distribuição local, acessibilidade e acabamento

## P4.1 — Organização de conversas e produtividade

- [ ] PARCIAL — Busca local por título e conteúdo de mensagens, branch, arquivos, empresa, conexão/`authKind` e projeto. **Ambos**.
- [ ] AUSENTE — Find dentro da conversa. **Codex**.
- [ ] PARCIAL — Pin/unpin real de chats e projetos com ordenação persistente; o botão de pin em projeto hoje não executa a ação. **Ambos**.
- [ ] PARCIAL — Activity/inbox consolidado de todas as empresas com badges de origem, filtros de running/waiting/ready/blocked/unread/scheduled e mark all as read. **Codex**; status/filter no **Claude**.
- [ ] AUSENTE — Pastas/seções personalizadas e reordenação de chats/projetos. **Codex**.
- [ ] AUSENTE — Home multiempresa com visão de empresas, Accounts desconectados, API Keys inválidas/expiradas, tarefas em andamento, aprovações pendentes, próximas automações e consumo localmente calculado. **Objetivo Axis**.
- [ ] AUSENTE — Quick switcher por empresa → projeto → conversa, mantendo empresa, conexão e método de autenticação visíveis após a troca. **Objetivo Axis**.
- [ ] AUSENTE — Exportar conversa, transcript e tool trace redigidos para arquivos locais portáveis. **Ambos**.
- [ ] AUSENTE — Branch/fork de conversa e comparação de duas tentativas. **Codex**; side/fork workflows no **Claude**.
- [ ] AUSENTE — Templates/prompt library pessoais e por empresa, com origem e escopo visíveis. **Claude**; skills/prompts no **Codex**.
- [ ] AUSENTE — Retenção local configurável, exclusão verificável e controles de dados por empresa. **Ambos**.

## P4.2 — Settings, atalhos, aparência e acessibilidade

- [ ] PARCIAL — Command palette completa e pesquisável. **Ambos**.
- [ ] PARCIAL — Mapa de atalhos, edição de bindings, busca por comando/keystroke e reset. **Codex**; atalhos do **Claude**.
- [ ] AUSENTE — Slash commands para new, compact, review, permissions, model, MCP, plugins, schedule e tarefas frequentes. **Ambos**.
- [ ] PARCIAL — Tema System/Light/Dark existe; faltam accent/background/foreground e fontes de UI/código configuráveis. **Codex**.
- [ ] AUSENTE — Layout de densidade, wrap, tamanho de fonte, reduced motion e alto contraste. **Ambos**.
- [ ] AUSENTE — Navegação completa por teclado, foco previsível, screen-reader labels/announcements e contraste WCAG em todas as panes. **Ambos**.
- [ ] AUSENTE — Internacionalização integral; idioma do UI separado do idioma preferido de resposta. **Ambos**.
- [ ] AUSENTE — Prevenir sleep durante tarefas locais e definir comportamento de follow-up. **Codex**; continuidade local no **Claude**.
- [ ] AUSENTE — Notificações do SO configuráveis para conclusão, pergunta, aprovação e falha. **Ambos**.
- [ ] AUSENTE — Links profundos registrados e seguros, com preview do prompt/pasta antes de iniciar. **Ambos**.

## P4.3 — Uso, custo, diagnóstico e suporte local

- [x] BASE — Ledger local de uso/custo, budgets e histórico de roteamento por projeto.
- [ ] PARCIAL — Usage ring por sessão e período, contexto usado/restante, tokens de reasoning/cache, duração e custo conhecido por turno/tool. **Ambos**.
- [ ] AUSENTE — Dashboard local de uso por empresa, conexão, `authKind`, provedor, modelo e projeto, sem enviar analytics ao Axis. **Objetivo Axis**.
- [ ] AUSENTE — Limites e alertas por empresa/conexão/projeto para custo, tokens, concorrência e tempo, inclusive separando duas API Keys do mesmo provedor. **Objetivo Axis**.
- [ ] AUSENTE — Perfil com estatísticas de atividade, lifetime/peak tokens, streak e longest task quando aplicável. **Codex**.
- [ ] AUSENTE — Painel de saúde de Accounts, API Keys, modelos, Local Workers, MCPs, browser, Computer Use, sandbox, shell, Git e notificações, agrupado por empresa. **Ambos**.
- [ ] AUSENTE — Diagnóstico exportável com versão, plataforma, configuração redigida e últimos erros, sem prompts/segredos por padrão. **Ambos**.
- [ ] AUSENTE — Mensagens acionáveis para autenticação, API Key inválida, rate limit, indisponibilidade, context overflow, missing tool, path, Git LFS e erro TLS/proxy, sempre identificando empresa e conexão sem expor segredo. **Ambos**.

## P4.4 — Políticas e distribuição local

- [ ] AUSENTE — Arquivos locais de política por empresa que podem restringir settings de projeto/sessão sem serviço de administração. **Ambos**.
- [ ] AUSENTE — Controles por empresa para Accounts/API Keys/modelos, destinos como Local Worker, Computer Use, browser, MCPs, plugins, skills, bypass e retenção. **Ambos**.
- [ ] AUSENTE — Allow/block lists por empresa de sites, plugins, executáveis MCP, tools, SaaS e apps de Computer Use. **Ambos**.
- [ ] AUSENTE — Configuração de TLS, custom CA e proxy por conexão para alcançar Ollama, provedores e MCPs corporativos. **Objetivo Axis**.
- [x] BASE — Instalação e atualização automática por pacote macOS assinado de forma estável, com changelog vindo da versão da release; rollback local ainda não existe. **Objetivo Axis**.
- [ ] AUSENTE — macOS, Windows x64/ARM64 e Linux com matriz clara de capacidades e degradação. **Claude**; desktop multiplataforma no **Codex**.
- [ ] AUSENTE — Política de compatibilidade/versionamento para adaptadores de IA, protocolo Ollama, tools, plugins, skills e migrações de arquivos locais. **Objetivo Axis**.

## P4.5 — Funções de menor prioridade, mas existentes nas referências

- [ ] AUSENTE — Companion/pet flutuante que indica running, needs input, ready e blocked. **Codex**.
- [ ] AUSENTE — Personalização/criação do pet e integração com picture-in-picture de Computer Use. **Codex**.
- [ ] AUSENTE — Integração com hardware/teclado dedicado para monitorar e controlar chats. **Codex Micro**.
- [ ] AUSENTE — Integrações locais como Apple Messages com aprovação por destinatário/chat. **Codex**.
- [ ] AUSENTE — Browser history pesquisável pelo agente somente após aprovação. **Codex**.
- [ ] AUSENTE — Memória/histórico de computador inspecionável e controlável pelo usuário quando essa superfície for adotada. **Codex**.

---

# Ordem recomendada de implementação

## Marco 1 — Fundação multiempresa e harness unificado (P1.5 + P1.1–P1.4)

A fundação de Company/Connections/Projects/Sessions já está utilizável e deve permanecer como boundary obrigatória. O próximo passo é fazer Chat e Cowork convergirem para o mesmo protocolo de eventos/tools para Ollama, Accounts e API Keys, com executor local sandboxed, filesystem/patch/shell/process tools, approvals e transcript. Manter o pipeline Cowork atual atrás do contrato comum até os E2Es do runtime unificado passarem.

## Marco 2 — Git e sessões seguras (P1.5–P1.6)

O review `Last turn` estruturado já estabelece a primeira superfície de revisão. Completar agora os escopos Git reais, dirty-tree protection, stage/revert, comentários, worktrees e testes de isolamento entre empresas/contas. Este marco libera o uso cotidiano real.

## Marco 3 — Ambiente de desenvolvimento (P2)

Adicionar terminal/editor/browser/preview, rich files, subagentes, host MCP universal e sistema de skills/plugins/hooks por empresa. Depois deste marco, Ollama e contas externas passam a compartilhar o mesmo “corpo” operacional.

## Marco 4 — Automação e multimodalidade locais (P3)

Adicionar scheduled/heartbeat/routines no computador e criação multimodal apoiada por ferramentas locais.

## Marco 5 — Produto administrável (P4)

Completar busca/organização, atalhos, notificações, acessibilidade, diagnóstico, políticas no dispositivo e distribuição multiplataforma.

## Decisões arquiteturais que não devem ser adiadas

1. **Um único runtime de tools.** Chat, Cowork, Code e automações devem ser configurações do mesmo engine, independentemente de usar Ollama, Account, API Key ou outro adaptador.
2. **Tools nativas pertencem ao Axis; integrações são negociadas.** Filesystem, shell, Git, diff, browser e Computer Use têm contratos do Axis. MCPs e capabilities externas dependem da conta/modelo e podem ser limitados pelo administrador do provedor.
3. **Empresa, conexão, modelo e destino imutáveis por sessão.** Empresa, projeto, `connectionId`, `authKind`, modelo, Local Worker/desktop, roots, browser profile e regras precisam ser fixados antes do primeiro tool call.
4. **Mutações observáveis e recuperáveis.** Patch, command, Git, MCP e Computer Use precisam de evento, approval policy, idempotência possível e trilha de auditoria.
5. **Worktree por padrão para paralelismo.** Concorrência no mesmo checkout é incompatível com a promessa de múltiplas sessões seguras.
6. **Persistência estritamente local.** Empresas, conexões, conversas, índices, memória, políticas, agendamentos e traces vivem em arquivos do dispositivo; API Keys ficam somente no cofre e nenhum recurso pode pressupor um backend do Axis.
7. **Conexões diretas e atribuíveis.** Toda saída de dados vai diretamente do desktop ou Local Worker autorizado à conexão escolhida e registra empresa, `connectionId`, `authKind`, modelo, destino, finalidade e política aplicável.
8. **Paridade entre métodos de autenticação.** Account e API Key diferem apenas na obtenção/renovação da credencial; catálogo, bindings, tools e superfícies do produto usam a mesma abstração de conexão.
9. **Compatibilidade sem dependência exclusiva.** Importar capacidades de `AGENTS.md`, `CLAUDE.md`, skills, MCPs e perfis conhecidos é parte da centralização; nenhuma função essencial do Axis pode existir apenas dentro de um CLI concorrente.

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

As duas referências evoluem rapidamente. Antes de iniciar cada marco:

- [ ] Revalidar as páginas oficiais e registrar a nova data de baseline.
- [ ] Adicionar funções novas sem rebaixar itens existentes silenciosamente.
- [ ] Marcar como BASE somente depois de teste de produto/E2E, não por existir um botão ou tipo no código.
- [ ] Registrar diferenças intencionais como decisão de produto; não chamá-las de paridade.
