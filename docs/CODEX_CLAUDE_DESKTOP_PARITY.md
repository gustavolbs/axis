# Paridade funcional com Codex e Claude Desktop

Baseline pesquisado: **2026-09-02**. Este documento é um inventário funcional e um checklist de implementação para que o Axis centralize, em um aplicativo local-first, o trabalho agêntico realizado com Ollama, Local Worker no Windows, Accounts e conexões autenticadas por API Key. A experiência operacional deve alcançar Codex e Claude Desktop/Claude Code Desktop sem perder a separação entre empresas.

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
| --- | --- | --- | --- |
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
- [x] BASE — projetos com instruções, pasta opcional, `organizationId`, políticas de conexão, privacidade e concorrência.
- [x] BASE — seleção explícita de modelo, provedor e conexão, incluindo Ollama, API Keys, perfis Claude e perfis ChatGPT/Codex.
- [x] BASE — Local Worker no Windows como destino especializado configurável, com URL/health route e descoberta de modelos.
- [x] BASE — pipeline Cowork de investigação, plano, edição, validação, revisão adversarial, reparo e memória de repositório.
- [x] BASE — Markdown básico, cópia, leitura em voz alta, progresso, lista de arquivos alterados, validações e diff unificado em texto.
- [x] BASE — perfis separados de contas Claude e ChatGPT/Codex, com diretórios de runtime e autenticação isolados.
- [x] BASE — conexões nomeadas por API Key, armazenamento da chave no cofre do sistema e persistência somente de referências não secretas.
- [x] BASE — armazenamento local de configuração sensível e histórico de roteamento.

A lacuna arquitetural é objetiva:

- O modo **Chat** é uma inferência conversacional e, por contrato, não explora nem altera o repositório (`src/premium-agent.ts`).
- O modo **Cowork** não oferece ao modelo um catálogo geral de ferramentas. O host escolhe evidências, pede um plano estruturado, exige antecipadamente `editableFiles`/`contextFiles`, recebe arquivos completos em JSON e só executa validações de uma allowlist (`src/local-engineer.ts`, `src/executor.ts`, `src/validation.ts`).
- O diff atual é um `<pre>` dentro da resposta. Não há review pane, seleção de escopo Git, comentários inline, stage/unstage/revert, editor de arquivo ou terminal integrado (`app/src/AgentSurfaceV2.tsx`).
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

<!-- RESTO DO DOCUMENTO RESTAURADO DO BLOB ANTERIOR -->
