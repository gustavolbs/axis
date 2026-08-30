# Windows remote execution setup

This is the recommended v0.8 deployment for a Mac control plane plus a Windows execution workstation.

The goal is to keep Claude Code responsive on macOS while Windows owns the heavy work:

```text
Mac
Claude Code
   |
   | stdio (local, user-scoped MCP)
   v
local-coder thin bridge
   |
   | authenticated HTTP over private LAN
   v
Windows :7337
local-coder worker
   |
   +--> Git mirror + disposable worktree
   +--> Qwen/Ollama
   +--> edits + retries
   +--> lint/tests/typecheck/build
   |
   v
bounded changed files + result
   |
   v
Mac verifies source hashes -> applies changes -> Claude reviews
```

Claude never connects directly to Windows. Claude talks to the normal `local-coder` stdio MCP on the Mac; that bridge talks to the Windows worker.

## What moves off the Mac in v0.8

In strict `remote` mode:

- Qwen model weights/KV cache/inference run on Windows;
- the worker clones/fetches repository mirrors on Windows;
- each run uses a disposable Windows Git worktree;
- edits/retries run in that Windows worktree;
- task/final validation, including lint/tests/typecheck/build requested by Claude, runs on Windows;
- the Mac receives only bounded changed-file contents and execution metadata;
- returned files are applied only if their Mac SHA-256 hashes still match the state that started the run.

For this first v0.8 cut, `prepare_local_context`, the compact run store, and the control-plane telemetry file still live on the Mac. They are much lighter than model inference and builds and can move to the worker in a later phase.

## Security model

Full Worker mode exposes **only the authenticated worker port `7337`** to the LAN. Ollama remains bound to Windows loopback (`127.0.0.1:11434`).

Use these controls together:

1. Windows LAN profile is `Private`;
2. Windows Firewall allows worker TCP `7337` only from the Mac LAN IP;
3. every worker endpoint requires a high-entropy bearer token;
4. the router has no port forward for `7337` or `11434`;
5. both computers are on a trusted private LAN (or, later, a private overlay such as Tailscale).

The worker currently uses HTTP on the trusted LAN, so the bearer token is not suitable for exposure to public/untrusted networks. Do not expose this service to the internet.

A DHCP reservation/static LAN address for both computers is strongly recommended so the firewall rule and Mac configuration do not become stale.

---

# Part A — Windows execution machine

## 1. Install prerequisites

Install on Windows:

- current NVIDIA driver;
- Ollama for Windows;
- Git for Windows;
- Node.js 20+ (Node 24 recommended for parity with CI);
- the package managers required by repositories you intend to validate (`npm` is included with Node; install `pnpm`, `yarn`, or `bun` when those repos require them).

Verify in PowerShell:

```powershell
node --version
npm --version
git --version
ollama --version
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

## 2. Authenticate Git on Windows

The worker reconstructs repositories locally; it does **not** receive GitHub credentials from the Mac.

Windows therefore needs its own normal developer access to every repository the worker may execute against.

If your Mac remote is HTTPS, Git Credential Manager is a good fit. If it is SSH, configure an SSH key/agent on Windows too.

Test the exact remote style you use. Examples:

```powershell
git ls-remote https://github.com/OWNER/PRIVATE_REPO.git HEAD
```

or:

```powershell
git ls-remote git@github.com:OWNER/PRIVATE_REPO.git HEAD
```

For company GitHub Enterprise, test its hostname as well. The worker never copies your Mac credentials or SSH keys.

## 3. Clone/update local-coder-mcp on Windows

```powershell
git clone https://github.com/gustavolbs/local-coder-mcp.git
cd local-coder-mcp
git switch main
git pull
```

If already cloned, just update `main`.

## 4. Find the Mac LAN IP

On the Mac:

```bash
ipconfig getifaddr en0
```

If needed:

```bash
ifconfig
```

Example:

```text
192.168.1.25
```

Use the real Mac IP below.

## 5. Configure Windows worker + firewall + model

Open **PowerShell as Administrator** in the Windows `local-coder-mcp` repository.

Recommended setup:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp 192.168.1.25 `
  -Mode Worker `
  -StartWorker
```

The script performs the operational setup:

- pulls `qwen3.6:35b-a3b-coding`;
- keeps Ollama on `127.0.0.1:11434`;
- configures one loaded model / one parallel Ollama inference;
- configures the worker on TCP `7337`;
- generates a cryptographically random worker token unless one was supplied;
- defaults the Git host allowlist to `github.com`;
- defaults dependency bootstrap to `auto`;
- creates a Windows Firewall inbound rule for port `7337` restricted to **only the supplied Mac IP** and **Private** profiles;
- removes the dedicated Ollama-LAN rule created by the legacy/Ollama-only mode if it exists;
- installs dependencies, runs checks, and builds the worker;
- optionally starts the worker in a separate PowerShell window.

The script prints the generated **WORKER TOKEN once**. Copy it to the Mac; do not commit it or paste it into project files.

### Company GitHub Enterprise / extra Git hosts

Example:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp 192.168.1.25 `
  -Mode Worker `
  -AllowedGitHosts "github.com,github.company.example" `
  -StartWorker
```

### Explicit token

If you prefer to generate/store your own high-entropy token:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp 192.168.1.25 `
  -Mode Worker `
  -WorkerToken "YOUR_LONG_RANDOM_TOKEN" `
  -StartWorker
```

## 6. Restart Ollama once after setup

The setup writes user environment variables that Ollama inherits at startup.

After the first Worker setup (especially if Ollama had previously been exposed to LAN):

1. quit Ollama completely from the Windows system tray;
2. start Ollama again from the Start menu.

Verify it remains local-only:

```powershell
Get-NetTCPConnection -LocalPort 11434 -State Listen
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

The listener should not require direct access from the Mac in Worker mode.

## 7. Verify worker locally on Windows

Use the token printed by setup:

```powershell
$TOKEN = "YOUR_WORKER_TOKEN"
Invoke-RestMethod `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  http://127.0.0.1:7337/v1/health
```

Expected fields include:

```text
protocolVersion = 1
workerVersion   = 0.8.0
ok              = True
model           = qwen3.6:35b-a3b-coding
```

## 8. Optional: start worker automatically at Windows logon

Once `npm run build` and Worker setup have succeeded:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker-task.ps1
Start-ScheduledTask -TaskName "Local Coder Remote Worker"
```

Inspect:

```powershell
Get-ScheduledTask -TaskName "Local Coder Remote Worker" | Format-List *
```

Remove later with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker-task.ps1 -Remove
```

Do not simultaneously keep a manually launched worker and the scheduled worker on the same port. Stop the manual process before starting the scheduled task.

## 9. Keep Windows awake

The display can turn off, but the PC/network interface must remain awake while Claude uses it.

Inspect the current power plan:

```powershell
powercfg /getactivescheme
```

If appropriate for this dedicated workstation, an administrator can disable AC standby with:

```powershell
powercfg /change standby-timeout-ac 0
```

Choose a different policy if the machine should still sleep outside working hours.

---

# Part B — connect the Mac and Claude Code

## 10. Find the Windows LAN IP

On Windows:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Format-Table InterfaceAlias, IPAddress
```

Example:

```text
192.168.1.50
```

Reserve it in DHCP if possible.

## 11. Test authenticated worker from the Mac

On the Mac:

```bash
TOKEN='YOUR_WORKER_TOKEN'
curl \
  -H "Authorization: Bearer $TOKEN" \
  http://192.168.1.50:7337/v1/health
```

Do not proceed until this returns worker health JSON.

A request without the token should return HTTP `401`:

```bash
curl -i http://192.168.1.50:7337/v1/health
```

## 12. Update/build the Mac bridge

```bash
cd ~/WORK/local-coder-mcp
git switch main
git pull
npm install --no-package-lock
npm run check
npm run build
```

The MCP still runs as a small stdio process on the Mac because that is the interface Claude Code expects. Heavy execution is remote.

## 13. Configure Claude Code for strict Worker mode

```bash
npm run install:claude:worker -- \
  --host 192.168.1.50 \
  --token "$TOKEN"
```

Optional overrides:

```bash
npm run install:claude:worker -- \
  --host 192.168.1.50 \
  --port 7337 \
  --token "$TOKEN" \
  --model qwen3.6:35b-a3b-coding
```

The installer backs up `~/.claude.json`, preserves unrelated MCP servers, and writes the `local-coder` environment including:

```text
LOCAL_CODER_EXECUTION_MODE=remote
LOCAL_CODER_REMOTE_WORKER_URL=http://192.168.1.50:7337
LOCAL_CODER_REMOTE_WORKER_TOKEN=<token>
LOCAL_CODER_ADAPTIVE_MODELS=false
LOCAL_CODER_MODEL=qwen3.6:35b-a3b-coding
LOCAL_CODER_NUM_CTX=16384
```

`remote` is deliberately strict: if Windows is unavailable, the MCP returns an error rather than quietly loading Qwen on the Mac.

Fully quit Claude Code/Desktop and reopen it.

## 14. Verify the Claude -> Mac MCP -> Windows chain

Ask Claude Code:

```text
Check local_coder_health and tell me the execution mode, worker hostname, worker model, and whether local fallback is enabled.
```

Expected shape:

```text
executionMode: remote
workerUrl: http://192.168.1.50:7337
worker.ok: true
worker.model: qwen3.6:35b-a3b-coding
localFallbackEnabled: false
```

Then run a small bounded implementation through `execute_local_code_task_compact`.

While it runs, on Windows:

```powershell
nvidia-smi -l 1
```

and:

```powershell
ollama ps
```

The GPU/memory load should appear on Windows, not the Mac.

---

# How source code moves between machines

The Mac does not mount its live repository on Windows.

For each remote task the bridge sends:

```text
origin repository URL
+ HEAD/base commit SHA
+ safe tracked dirty patch
+ safe relevant untracked files
+ hashes of every editable file
```

The worker creates/reuses a Windows mirror and a disposable worktree, reconstructs that exact source state, executes there, and returns only changes to the editable files.

Before applying anything, the Mac compares current file hashes to the hashes captured at task start. If you or Claude modified one of those files while Windows was working, **nothing is applied** and the run returns a conflict instead of overwriting newer work.

Existing workspace policy still blocks `.git`, `node_modules`, `.ssh`, and real `.env*` secret files from the transport. Safe examples such as `.env.example` remain allowed.

# Dependency bootstrap on Windows

Default Worker setup uses:

```text
LOCAL_CODER_WORKER_BOOTSTRAP=auto
```

The worker detects a root lockfile and uses the corresponding reproducible install when possible:

```text
pnpm-lock.yaml   -> pnpm install --frozen-lockfile
yarn.lock        -> yarn install --frozen-lockfile
bun.lock/bun.lockb -> bun install --frozen-lockfile
package-lock.json -> npm ci
package.json only -> npm install
```

This can make the first run for a repository slower, but it moves dependency/setup I/O and validation off the Mac.

Use `-Bootstrap none` in Windows setup only for repositories whose remote validation does not need installed dependencies or when you manage dependency preparation separately.

# Windows Firewall verification

Worker rule address restriction:

```powershell
Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Get-NetFirewallAddressFilter
```

Port/profile/action:

```powershell
Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Format-Table DisplayName, Enabled, Profile, Direction, Action

Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Get-NetFirewallPortFilter
```

The expected inbound port is `7337`, the profile is `Private`, and the remote address is the Mac IP.

Inspect broader rules that might accidentally expose either process:

```powershell
Get-NetFirewallRule |
  Where-Object DisplayName -Match "Ollama|Local Coder" |
  Format-Table DisplayName, Enabled, Profile, Direction, Action
```

Do not add router/NAT port forwards for `7337` or `11434`.

# Troubleshooting

## Mac cannot connect to port 7337

On Windows:

```powershell
Get-NetTCPConnection -LocalPort 7337 -State Listen
Get-NetConnectionProfile
```

The worker must be running and the active LAN profile should be `Private`.

Check the firewall's configured Mac address:

```powershell
Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Get-NetFirewallAddressFilter
```

If DHCP changed the Mac IP, rerun `setup-windows-host.ps1 -MacIp <NEW_IP>` or reserve the address in the router.

## HTTP 401

The token in `~/.claude.json`/your shell does not match the Windows user environment token.

On Windows, do not print it in routine logs, but you can intentionally inspect it while repairing setup:

```powershell
[Environment]::GetEnvironmentVariable("LOCAL_CODER_WORKER_TOKEN", "User")
```

Then rerun the Mac installer with the correct token.

## Worker cannot clone a private repo

Test Windows Git authentication directly:

```powershell
git ls-remote <EXACT_ORIGIN_URL_FROM_MAC> HEAD
```

If the repo is on a non-`github.com` Git host, rerun setup with that host in `-AllowedGitHosts`.

## Validation says package manager not found

Install the repository's package manager on Windows and ensure it is available on `PATH` for the same Windows user that runs the worker/scheduled task.

## Model missing / Ollama unavailable

```powershell
ollama list
ollama pull qwen3.6:35b-a3b-coding
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

If Ollama was restarted before environment configuration changed, quit it completely from the tray and start it again.

## Windows is using too much memory

Keep the defaults initially:

```text
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
LOCAL_CODER_NUM_CTX=16384
```

Do not increase context just because the machine has 64 GB RAM; focused repository context is still preferable.

## Claude reports worker unavailable

Strict remote mode intentionally refuses local fallback. Fix/start Windows rather than switching back silently.

If you deliberately want old local Mac execution again, use the rollback below.

# Rollback

## Restore local Mac execution

On the Mac:

```bash
cd ~/WORK/local-coder-mcp
npm run install:claude
```

Fully quit/reopen Claude Code/Desktop.

## Stop/remove Windows worker startup

```powershell
Stop-ScheduledTask -TaskName "Local Coder Remote Worker" -ErrorAction SilentlyContinue
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker-task.ps1 -Remove
```

Remove the worker firewall rule if no longer used:

```powershell
Remove-NetFirewallRule -DisplayName "Local Coder - Worker from Mac"
```

Ollama can remain installed on Windows.

# Simpler fallback: Windows Ollama only

If you want only immediate thermal relief without remote repository/build execution, the setup script still supports:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp 192.168.1.25 `
  -Mode OllamaOnly
```

Then on the Mac:

```bash
npm run install:claude:windows -- --host 192.168.1.50
```

This exposes Ollama `11434` to the Mac (firewall-restricted) and leaves repository edits/tests/build on the Mac. It is less isolated and less secure than the authenticated Worker mode, so Worker mode is the recommended v0.8 configuration.

# Architecture details

See [REMOTE_WORKER_ARCHITECTURE.md](./REMOTE_WORKER_ARCHITECTURE.md) for protocol, source-state reconstruction, conflict safety, worker storage, and subsequent migration phases.
