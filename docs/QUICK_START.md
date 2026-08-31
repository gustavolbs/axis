# Local Coder — Quick Start ultrassimples

Siga este arquivo **de cima para baixo**. Ele coloca no ar o setup recomendado:

```text
Mac
├─ Local Coder.app / Console
├─ Agent Runtime
├─ Claude MCP
├─ Anthropic/OpenAI opcionais
└─ usa Qwen no Windows

Windows
├─ Ollama
├─ qwen3.8:27b
└─ Local Coder Worker :7337
```

Se você quiser entender detalhes, veja os guias longos só depois. Para colocar para rodar, faça apenas isto.

---

## 1. Prepare o Mac

No Terminal:

```bash
git clone https://github.com/gustavolbs/local-coder-mcp.git
cd local-coder-mcp
npm install
npm run check
```

Recomendado: Node.js 24.

Abra o app:

```bash
npm run desktop
```

Você deve ver:

```text
Agent | Projects | Runs
```

> Enquanto não houver DMG assinado publicado, este é o caminho mais simples e seguro. Não desative o Gatekeeper para usar build unsigned.

---

## 2. Prepare o Windows com Qwen

Se você não quer usar a GPU do Windows, pule para o passo 5 e use Ollama no próprio Mac.

No Windows instale:

- NVIDIA driver;
- Ollama;
- Git;
- Node.js 24 recomendado.

Clone o repo:

```powershell
git clone https://github.com/gustavolbs/local-coder-mcp.git
cd local-coder-mcp
```

No Mac descubra o IP dele:

```bash
ipconfig getifaddr en0
```

Exemplo: `192.168.1.25`.

Se usa NordVPN Meshnet, use o IP Meshnet do Mac em vez do IP LAN.

No Windows, abra **PowerShell como Administrador** dentro de `local-coder-mcp` e rode:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp <IP_DO_MAC> `
  -Mode Worker `
  -MaxConcurrentJobs 1 `
  -StartWorker
```

Esse script prepara o Worker, puxa `qwen3.8:27b`, configura a GPU e mostra um **WORKER TOKEN**.

Copie o token. Não salve no repo.

Depois saia completamente do Ollama e abra-o novamente uma vez.

Confira:

```powershell
ollama list
```

Você deve ver `qwen3.8:27b`.

---

## 3. Conecte o Mac ao Windows

No Windows descubra o IP:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Format-Table InterfaceAlias, IPAddress
```

Vamos chamar esse IP de `<WINDOWS_HOST>`.

No Terminal padrão do Mac (zsh), coloque o Worker Token numa variável **sem gravá-lo no histórico**:

```bash
read -s "LOCAL_CODER_WINDOWS_WORKER_TOKEN?Cole o WORKER TOKEN: "
echo
export LOCAL_CODER_WINDOWS_WORKER_TOKEN
```

Teste:

```bash
curl \
  -H "Authorization: Bearer $LOCAL_CODER_WINDOWS_WORKER_TOKEN" \
  http://<WINDOWS_HOST>:7337/v1/health
```

Você quer receber JSON com `ok: true` e `qwen3.8:27b`.

---

## 4. Ligue o Worker ao Local Coder e ao Claude

No Mac, dentro de `local-coder-mcp`:

```bash
npm run build
npm run install:claude:worker -- --host <WINDOWS_HOST>
npm run install:routing
npm run install:claude-token-saver
```

Depois remova o token da sessão:

```bash
unset LOCAL_CODER_WINDOWS_WORKER_TOKEN
```

O instalador já guardou o token no **macOS Keychain**. Ele não fica no `control-plane.json` nem no config MCP do Claude.

Agora:

1. feche e abra novamente o **Local Coder**;
2. feche completamente e abra novamente o **Claude**.

No Claude, teste:

```text
Use o MCP local-coder e execute local_coder_health.
Mostre execution mode, worker status e modelo.
```

Você quer algo equivalente a:

```text
executionMode: remote
worker.ok: true
worker.model: qwen3.8:27b
```

Se apareceu isso, Claude → Mac → Windows/Qwen está funcionando.

---

## 5. Crie o primeiro Project

No Local Coder abra:

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
Cloud allowed:    OFF
Allowed providers: ollama
```

Salve.

**Faça o primeiro teste com cloud desligada.** Assim você valida o produto sem custo e sem enviar código para provider externo.

---

## 6. Rode o primeiro job

Abra **Agent** e mande:

```text
Investigue este repositório e identifique uma melhoria pequena, segura e
objetivamente validável em código ou testes. Implemente apenas uma melhoria,
rode as validações apropriadas e faça review do resultado.
```

Depois abra **Runs**.

Confira:

- status;
- modelo usado;
- arquivos alterados;
- validações;
- quality/review.

Se terminou com sucesso, o Local Coder standalone está funcionando.

---

## 7. Adicione Anthropic/OpenAI — opcional

Faça isso **somente depois** do Local-only funcionar.

No app:

```text
Projects → seu Project → Credentials / Providers
```

Para cada provider que quiser usar:

1. escolha `Anthropic` ou `OpenAI`;
2. escolha **macOS Keychain**;
3. cole a API key no campo do app;
4. salve/teste;
5. faça model discovery;
6. adicione o provider ao `Allowed providers`;
7. ligue `Cloud allowed` para esse Project;
8. deixe `Model = Auto` ou escolha um modelo explícito.

Sugestão inicial:

```text
Routing: balanced
Model: Auto
```

Para provar que cloud pode ser usada diretamente sem Qwen antes:

```text
Routing: speed-first
```

### Pricing e budgets

Se for usar budgets, antes cadastre o pricing atual do modelo em **Projects**, usando a documentação oficial do provider como fonte.

Depois configure, se quiser:

```text
Per-job budget
Daily budget
Monthly budget
```

Nunca coloque API keys em `.env`, `projects.json`, `control-plane.json`, prompts ou arquivos do repo.

Para testar a API cloud diretamente com uma chamada paga pequena, use o guia `docs/CLOUD_SMOKE.md`. Ele mostra como fornecer a key temporariamente sem transformá-la em configuração persistente.

---

## 8. Faça o Windows Worker iniciar sozinho — opcional

Quando tudo estiver funcionando, no Windows abra PowerShell como Administrador:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker-task.ps1
Start-ScheduledTask -TaskName "Local Coder Remote Worker"
```

Não rode ao mesmo tempo um Worker manual e o Scheduled Task na porta `7337`.

---

# Pronto

Seu checklist final é este:

```text
[ ] npm run check passou no Mac
[ ] Local Coder abriu
[ ] Windows mostra qwen3.8:27b em ollama list
[ ] Mac acessa /v1/health do Worker
[ ] Claude local_coder_health vê o Worker
[ ] Project foi criado
[ ] primeiro job Local-only terminou e apareceu em Runs
[ ] Anthropic/OpenAI estão no Keychain, se você quiser cloud
[ ] Cloud allowed está ligado somente nos Projects que podem enviar código à cloud
[ ] pricing/budgets estão configurados, se você quiser controle financeiro
```

Se todas as caixas necessárias ao seu setup estão OK, acabou.

## Se algo falhar

Diagnostique nesta ordem:

```text
1. Local Coder abre?
2. Project aponta para o workspace correto?
3. Windows: ollama list mostra qwen3.8:27b?
4. Mac acessa http://WINDOWS:7337/v1/health com o token?
5. Claude local_coder_health vê o Worker?
6. Runs mostra em qual etapa falhou?
```

Só então abra os guias detalhados:

- instalação/segurança: `docs/INSTALLATION.md`
- Windows Worker: `docs/WINDOWS_REMOTE_SETUP.md`
- NordVPN Meshnet: `docs/NORDVPN_MESHNET.md`
- cloud smoke: `docs/CLOUD_SMOKE.md`
- desktop: `docs/DESKTOP_SHELL.md`
