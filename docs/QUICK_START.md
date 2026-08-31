# Local Coder — Quick Start ultrassimples

Este é o guia para **colocar o Local Coder para rodar sem precisar entender a arquitetura antes**.

Se alguma etapa der problema, use os documentos detalhados apenas para troubleshooting:

- `docs/INSTALLATION.md`
- `docs/WINDOWS_REMOTE_SETUP.md`
- `docs/NORDVPN_MESHNET.md`

## O setup recomendado

```text
Mac
├─ Local Coder.app / Console
├─ Agent Runtime
├─ Claude MCP
├─ Anthropic/OpenAI opcionais
└─ chama Qwen no Windows

Windows
├─ Ollama
├─ qwen3.8:27b
└─ Local Coder Worker :7337
```

O Mac continua sendo o cérebro/control plane. O Windows fornece a GPU local. Cloud é opcional e pode ser chamada diretamente pelo Mac.

---

# Parte 1 — Mac

## 1. Clone e prepare

No Terminal do Mac:

```bash
git clone https://github.com/gustavolbs/local-coder-mcp.git
cd local-coder-mcp
npm install
npm run check
```

Se terminou sem erro, o Mac está pronto.

> Recomendado: Node.js 24. O projeto suporta Node 20+.

## 2. Abra o Local Coder

Enquanto ainda não houver um DMG assinado publicado, rode pelo próprio repositório:

```bash
npm run desktop
```

Isso abre o app desktop e sobe automaticamente o control plane local.

Alternativa pelo navegador:

```bash
npm run console
```

Depois abra:

```text
http://127.0.0.1:7557
```

Você deve ver:

```text
Agent | Projects | Runs
```

Pode deixar essa janela aberta.

---

# Parte 2 — Windows com Qwen

Se você não quer usar o Windows agora, pule para **Parte 4 — Criar o primeiro Project**. O Local Coder também funciona com Ollama no próprio Mac.

## 3. Instale o básico no Windows

Instale:

- NVIDIA driver atualizado;
- Ollama;
- Git;
- Node.js 24 recomendado.

Abra PowerShell e confira:

```powershell
node --version
git --version
ollama --version
```

## 4. Clone o Local Coder no Windows

```powershell
git clone https://github.com/gustavolbs/local-coder-mcp.git
cd local-coder-mcp
```

## 5. Descubra o IP do Mac

No Mac, para LAN/Wi-Fi:

```bash
ipconfig getifaddr en0
```

Exemplo:

```text
192.168.1.25
```

Se você usa NordVPN Meshnet, prefira o IP Meshnet do Mac no lugar do IP acima.

## 6. Configure o Windows Worker

Abra **PowerShell como Administrador**, dentro da pasta `local-coder-mcp`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp <IP_DO_MAC> `
  -Mode Worker `
  -MaxConcurrentJobs 1 `
  -StartWorker
```

Exemplo:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp 192.168.1.25 `
  -Mode Worker `
  -MaxConcurrentJobs 1 `
  -StartWorker
```

Esse comando faz praticamente tudo:

- instala/puxa `qwen3.8:27b` no Ollama;
- configura contexto 16K;
- limita GPU a uma inference por vez;
- prepara e testa o Local Coder;
- abre a porta `7337` somente para o Mac informado;
- gera o `WORKER TOKEN`;
- inicia o Worker.

**Copie o `WORKER TOKEN` quando ele aparecer. Ele é mostrado para você usar no Mac. Não salve no repo.**

## 7. Reinicie o Ollama uma vez

Depois do primeiro setup:

1. saia completamente do Ollama pelo ícone da bandeja;
2. abra o Ollama novamente.

Confira:

```powershell
ollama list
```

Deve aparecer:

```text
qwen3.8:27b
```

---

# Parte 3 — Conectar Mac ↔ Windows ↔ Claude

## 8. Descubra o IP do Windows

No Windows:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Format-Table InterfaceAlias, IPAddress
```

Escolha o IP da mesma rede do Mac.

Se usa Meshnet, use o IP/nome Meshnet do Windows.

Vamos chamar esse endereço de:

```text
<WINDOWS_HOST>
```

## 9. Passe o Worker Token ao Mac sem colocá-lo no histórico do shell

No Terminal padrão do macOS (zsh):

```bash
read -s "LOCAL_CODER_WINDOWS_WORKER_TOKEN?Cole o WORKER TOKEN: "
echo
export LOCAL_CODER_WINDOWS_WORKER_TOKEN
```

Agora teste o Worker:

```bash
curl \
  -H "Authorization: Bearer $LOCAL_CODER_WINDOWS_WORKER_TOKEN" \
  http://<WINDOWS_HOST>:7337/v1/health
```

Você deve receber JSON com `ok: true` e o modelo `qwen3.8:27b`.

## 10. Configure o Mac e o Claude para usar o Worker

Na pasta do Local Coder no Mac:

```bash
npm run build
npm run install:claude:worker -- --host <WINDOWS_HOST>
npm run install:routing
npm run install:claude-token-saver
```

Depois apague o token da sessão do terminal:

```bash
unset LOCAL_CODER_WINDOWS_WORKER_TOKEN
```

O instalador já guardou o token no **macOS Keychain**. Ele não fica em `control-plane.json` nem no config MCP do Claude.

Agora **feche completamente e abra novamente o Claude**.

## 11. Teste no Claude

Peça:

```text
Use o MCP local-coder e execute local_coder_health.
Mostre execution mode, worker status e modelo.
```

Você quer ver algo equivalente a:

```text
executionMode: remote
worker.ok: true
worker.model: qwen3.8:27b
```

Se isso apareceu, Claude → Mac → Windows/Qwen está funcionando.

---

# Parte 4 — Criar o primeiro Project

## 12. No app, abra Projects

Clique em:

```text
Projects → New Project
```

Preencha:

```text
Name:             nome do projeto
Workspace:        /caminho/absoluto/do/repo
Organization ID:  empresa-ou-conta
Routing:          local-first
Model:            Auto
Concurrency:      1
```

Para o primeiro teste, deixe:

```text
Cloud allowed: OFF
Allowed providers: ollama
```

Salve.

Isso garante que o primeiro teste é 100% local e não gera custo cloud.

## 13. Rode o primeiro job

Abra **Agent**, selecione/use o Project e mande algo pequeno, por exemplo:

```text
Investigue este repositório e identifique uma melhoria pequena, segura e
objetivamente validável em código ou testes. Implemente apenas uma melhoria,
rode as validações apropriadas e faça review do resultado.
```

Depois abra **Runs**.

Confira:

- status do run;
- modelo usado;
- validações;
- arquivos alterados;
- routing/fallback quando aplicável.

Se terminou com sucesso, o fluxo standalone está funcionando.

---

# Parte 5 — Adicionar Anthropic e/ou OpenAI

Isso é opcional. Faça somente depois de o Local-only funcionar.

## 14. Adicione uma API key pelo app

Abra:

```text
Projects → seu Project → Credentials / Providers
```

Para Anthropic:

1. escolha `Anthropic`;
2. escolha armazenamento **macOS Keychain**;
3. cole a API key;
4. salve/teste;
5. faça model discovery.

Para OpenAI, repita escolhendo `OpenAI`.

**Não coloque API keys em `.env`, `projects.json`, `control-plane.json`, prompts ou arquivos do repo.**

## 15. Libere cloud para o Project

Ainda em **Projects**:

1. adicione `anthropic` e/ou `openai` aos allowed providers;
2. ligue `Cloud allowed`;
3. deixe `Model = Auto` ou escolha um modelo explícito;
4. escolha sua política de routing.

Sugestão inicial:

```text
Routing: balanced
Model: Auto
```

Se quiser provar que Qwen não é obrigatório antes da cloud:

```text
Routing: speed-first
```

Nesse modo o router pode escolher cloud diretamente, sem fazer um pre-pass local.

## 16. Configure pricing antes de usar budgets

Em **Projects**, para cada modelo cloud que você pretende usar:

1. abra a configuração de pricing;
2. copie os preços atuais da documentação oficial do provider;
3. informe a fonte;
4. informe a data de verificação.

Depois configure, se quiser:

```text
Per-job budget
Daily budget
Monthly budget
```

Se um hard budget estiver configurado e o custo não puder ser calculado com segurança, Local Coder falha fechado em vez de adivinhar o gasto.

## 17. Faça um teste cloud pequeno

Use o mesmo Project e peça uma tarefa pequena.

Depois abra **Runs** e confira:

```text
provider/model
routing reasons
fallbacks
input/output tokens
known cost
budget snapshot
```

---

# Parte 6 — Testar os providers diretamente (opcional)

O smoke abaixo **faz uma chamada real paga pequena**. Use apenas se quiser validar a API de ponta a ponta.

Para Anthropic:

```bash
export ANTHROPIC_API_KEY='...'
export LOCAL_CODER_SMOKE_ANTHROPIC_MODEL='<MODEL_ID_DESCOBERTO>'
npm run smoke:cloud -- --provider anthropic
unset ANTHROPIC_API_KEY LOCAL_CODER_SMOKE_ANTHROPIC_MODEL
```

Para OpenAI:

```bash
export OPENAI_API_KEY='...'
export LOCAL_CODER_SMOKE_OPENAI_MODEL='<MODEL_ID_DESCOBERTO>'
npm run smoke:cloud -- --provider openai
unset OPENAI_API_KEY LOCAL_CODER_SMOKE_OPENAI_MODEL
```

Prefira o cadastro via Keychain no app para uso normal. As variáveis acima são apenas para o smoke CLI.

---

# Parte 7 — Deixar o Windows Worker automático

Quando tudo estiver funcionando, no Windows abra PowerShell como Administrador:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker-task.ps1
Start-ScheduledTask -TaskName "Local Coder Remote Worker"
```

A partir daí o Worker inicia automaticamente no logon.

Não deixe ao mesmo tempo um Worker manual e o Scheduled Task usando a porta `7337`.

---

# Checklist final

Se todas estas caixas estiverem OK, acabou:

```text
[ ] npm run check passa no Mac
[ ] Local Coder desktop abre
[ ] Windows tem qwen3.8:27b
[ ] /v1/health do Windows responde ao Mac
[ ] Claude local_coder_health vê o Worker
[ ] primeiro Project foi criado
[ ] job Local-only terminou e apareceu em Runs
[ ] Anthropic/OpenAI foram cadastrados no Keychain (se quiser cloud)
[ ] Cloud allowed está ligado somente nos Projects que podem enviar código à cloud
[ ] pricing/budgets foram configurados (se quiser controle financeiro)
[ ] Windows Worker inicia automaticamente (opcional)
```

## Se algo não funcionar

Não tente consertar tudo de uma vez.

Use esta ordem:

```text
1. O app abre?
2. O Project existe e aponta para o workspace correto?
3. Windows: ollama list mostra qwen3.8:27b?
4. Mac consegue chamar http://WINDOWS:7337/v1/health com o token?
5. Claude local_coder_health vê o Worker?
6. Runs mostra onde o job falhou?
```

Depois consulte:

- Windows/Worker: `docs/WINDOWS_REMOTE_SETUP.md`
- Meshnet: `docs/NORDVPN_MESHNET.md`
- instalação e segurança: `docs/INSTALLATION.md`
- cloud smoke: `docs/CLOUD_SMOKE.md`
- desktop: `docs/DESKTOP_SHELL.md`
