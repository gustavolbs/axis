# Windows remote host setup

This guide covers the first v0.8 deployment step: keep Claude Code and the stdio MCP bridge on the Mac while moving **all Ollama inference** to a Windows workstation on the same private LAN.

This is the fastest way to remove the largest source of memory pressure and fan activity from the Mac. The later v0.8 worker phase moves repository reconstruction, edits, tests, typecheck, build, run artifacts and telemetry to Windows too.

## Current phase architecture

```text
Mac
Claude Code
   |
   | stdio MCP
   v
local-coder-mcp
   |
   | HTTP over private LAN
   v
Windows
Ollama + qwen3.6:35b-a3b-coding
```

In this phase:

- Claude reasoning/review stays on the Mac;
- the MCP process still runs on the Mac;
- repository reads/writes and validations still run on the Mac;
- model inference runs on Windows;
- no Qwen weights or KV cache need to be resident on the Mac while remote inference is active.

## Security model

Ollama's local API does not provide application-layer authentication. Do **not** expose port `11434` to the internet and do not create an unrestricted inbound firewall rule.

Use all three controls:

1. Windows network profile must be `Private`;
2. Windows Firewall rule must allow TCP `11434` only from the Mac IP;
3. your router must not port-forward `11434`.

A DHCP reservation/static LAN address for both machines is recommended so the firewall rule and Claude configuration do not become stale.

## 1. Prerequisites on Windows

Install:

- current NVIDIA driver;
- Ollama for Windows;
- PowerShell 5+ (already present on supported Windows versions).

Ollama runs natively on Windows and exposes its API at `http://localhost:11434` by default.

Verify:

```powershell
ollama --version
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

## 2. Find the Mac LAN IP

On the Mac:

```bash
ipconfig getifaddr en0
```

If the Mac is connected through another interface, inspect:

```bash
ifconfig
```

Example:

```text
192.168.1.25
```

Use the actual Mac address in the next step.

## 3. Configure the Windows host

Clone/update this repository on Windows, then open **PowerShell as Administrator** in the repository root.

```powershell
git switch main
git pull
```

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 -MacIp 192.168.1.25
```

The script:

- sets `OLLAMA_HOST=0.0.0.0:11434` for the Windows user;
- sets `OLLAMA_NUM_PARALLEL=1`;
- sets `OLLAMA_MAX_LOADED_MODELS=1`;
- creates a Windows Firewall inbound rule restricted to the supplied Mac IP and `Private` profiles;
- pulls `qwen3.6:35b-a3b-coding` by default.

To override the model:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp 192.168.1.25 `
  -Model "qwen3.6:35b-a3b-coding"
```

### Restart Ollama

Ollama inherits user/system environment variables when it starts. After the script completes:

1. quit Ollama completely from the Windows system tray;
2. start Ollama again from the Start menu.

Verify locally:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

Verify the model is installed:

```powershell
ollama list
```

## 4. Find the Windows LAN IP

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

Prefer a router DHCP reservation for this address.

## 5. Test Windows Ollama from the Mac

On the Mac:

```bash
curl http://192.168.1.50:11434/api/tags
```

You should receive JSON containing the installed model.

If this fails, do not change Claude configuration yet. See troubleshooting below.

## 6. Point the Mac MCP at Windows

On the Mac, update/build the repository first:

```bash
cd ~/WORK/local-coder-mcp
git switch main
git pull
npm install --no-package-lock
npm run check
npm run build
```

Then configure Claude Code:

```bash
npm run install:claude:windows -- --host 192.168.1.50
```

Optional model/port overrides:

```bash
npm run install:claude:windows -- \
  --host 192.168.1.50 \
  --port 11434 \
  --model qwen3.6:35b-a3b-coding
```

The installer backs up `~/.claude.json`, preserves unrelated MCP servers, and configures `local-coder` with:

```text
OLLAMA_BASE_URL=http://192.168.1.50:11434
LOCAL_CODER_ADAPTIVE_MODELS=false
LOCAL_CODER_MODEL=qwen3.6:35b-a3b-coding
LOCAL_CODER_NUM_CTX=16384
LOCAL_CODER_TIMEOUT_MS=600000
```

The stronger Windows host uses a single selected executor model in this phase; the old Mac 7B -> 14B adaptive ladder is disabled for the remote model.

Fully quit Claude Code/Desktop and reopen it.

## 7. Verify from Claude

Ask Claude Code:

```text
Check local_coder_health and tell me which Ollama host/model is active.
```

Expected characteristics:

```text
baseUrl: http://<WINDOWS_IP>:11434
configuredModel: qwen3.6:35b-a3b-coding
modelAvailable: true
adaptiveModelsEnabled: false
numCtx: 16384
```

You can also watch the Windows GPU while a task runs:

```powershell
nvidia-smi -l 1
```

and inspect Ollama residency:

```powershell
ollama ps
```

The Mac should no longer load Qwen locally during MCP inference.

## Windows Firewall verification

Show the dedicated rule:

```powershell
Get-NetFirewallRule -DisplayName "Local Coder - Ollama from Mac" |
  Get-NetFirewallAddressFilter
```

Inspect any other Ollama-related rules:

```powershell
Get-NetFirewallRule |
  Where-Object DisplayName -Match "Ollama" |
  Format-Table DisplayName, Enabled, Profile, Direction, Action
```

If an old rule allows Ollama inbound from `Any`, disable/remove that broad rule after confirming the dedicated Mac-only rule works.

Do not add a router/NAT port forward for `11434`.

## Troubleshooting

### Mac gets connection refused

On Windows:

```powershell
Get-ChildItem Env:OLLAMA_HOST
Get-NetTCPConnection -LocalPort 11434 -State Listen
```

If Ollama is still bound only to `127.0.0.1`, quit the tray application completely and restart it after setting `OLLAMA_HOST`.

### Mac times out

Verify Windows network profile:

```powershell
Get-NetConnectionProfile
```

The active LAN should be `Private`. Also confirm the firewall rule contains the current Mac IP.

### Model missing

```powershell
ollama pull qwen3.6:35b-a3b-coding
ollama list
```

### Model is using too much memory

Keep:

```text
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
```

and keep the MCP context at `16384` initially. Increase context only after observing stable RAM/VRAM behavior.

### Windows sleeps and Claude loses the worker

Configure the Windows power plan so the machine does not sleep during the hours you use Claude Code. The display may sleep; the machine/network adapter must remain available.

## Roll back to local Mac inference

On the Mac:

```bash
npm run install:claude
```

Then fully restart Claude Code/Desktop.

On Windows, optionally remove the dedicated firewall rule:

```powershell
Remove-NetFirewallRule -DisplayName "Local Coder - Ollama from Mac"
```

You can also restore Ollama to localhost-only by removing the user `OLLAMA_HOST` variable and restarting Ollama:

```powershell
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", $null, "User")
```

## Next v0.8 phase

The final architecture will keep only a thin control bridge on the Mac. Windows will reconstruct the repository in disposable worktrees and own:

- context/index processing;
- model inference;
- edits/retries;
- lint/tests/typecheck/build;
- run artifacts/telemetry.

The Windows worker will return bounded changes to the Mac, which verifies the expected source state before applying them. See `REMOTE_WORKER_ARCHITECTURE.md`.
