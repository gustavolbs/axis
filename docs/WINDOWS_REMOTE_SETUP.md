# Windows remote execution setup — v0.10

This is the recommended deployment for `local-coder-mcp` when Claude runs on a Mac and the heavy local engineering agent runs on a Windows workstation.

```text
Mac
Claude Desktop / Claude Code
   |
   | stdio MCP
   v
local-coder thin bridge
   |
   | authenticated HTTP over LAN or NordVPN Meshnet
   v
Windows :7337
local-coder worker
   |
   +--> Git mirror + disposable worktree
   +--> persistent repo intelligence
   +--> Qwen3.8 reasoning/planning/coding/review
   +--> lint/tests/typecheck/build
   |
   v
bounded changed files
   |
   v
Mac verifies hashes -> applies changes
```

Claude never talks directly to Ollama. Claude talks to the user-scoped `local-coder` MCP on the Mac; that bridge talks to the authenticated Windows worker.

For travel and a stable address independent of the physical LAN, use **[NORDVPN_MESHNET.md](./NORDVPN_MESHNET.md)**. No router port-forwarding is required.

## Default worker policy

The v0.10 Windows setup defaults to:

```text
model                         qwen3.8:27b
context                       16384
OLLAMA_NUM_PARALLEL           1
OLLAMA_MAX_LOADED_MODELS      1
heavy worker jobs             1
persistent repo intelligence  enabled
```

`qwen3.8:27b` supports a much larger advertised context, but **16K is intentional** for the RTX 3060 12 GB / 64 GB RAM worker. The system should prefer targeted repo-intelligence/evidence capsules over loading a huge context and consuming memory needed by Node, TypeScript, tests and builds.

The local-engineer reasoning policy is:

```text
investigation / planning / review  -> maximum reasoning intent
Qwen3.8 maximum intent             -> native default xhigh mode
repo-intelligence learning         -> low reasoning
mechanical coding                  -> low/off where appropriate
```

The Ollama client performs the Qwen3.8-specific `high -> think:true` normalization internally; Claude does not need model-specific prompts.

---

# A. Prepare the Windows execution machine

## 1. Install prerequisites

Install:

- current NVIDIA driver;
- Ollama for Windows;
- Git for Windows;
- Node.js 20+;
- any package managers required by target repos (`pnpm`, `yarn`, `bun`; `npm` ships with Node).

Verify in PowerShell:

```powershell
node --version
npm --version
git --version
ollama --version
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

## 2. Authenticate Git on Windows

The worker creates Windows-local repository mirrors. It does **not** receive GitHub credentials, SSH keys or credential-manager state from the Mac.

Test the exact remote form used by each repo:

```powershell
git ls-remote https://github.com/OWNER/PRIVATE_REPO.git HEAD
```

or:

```powershell
git ls-remote git@github.com:OWNER/PRIVATE_REPO.git HEAD
```

For GitHub Enterprise, include its hostname later in `-AllowedGitHosts`.

## 3. Clone/update local-coder-mcp

After the PR stack has landed on `main`:

```powershell
git clone https://github.com/gustavolbs/local-coder-mcp.git
cd local-coder-mcp
git switch main
git pull
```

During development/testing of v0.10, use the corresponding branch explicitly instead of `main`.

## 4. Choose the Mac address allowed by Windows Firewall

### Recommended: NordVPN Meshnet

Use the **Mac Meshnet IP**. See [NORDVPN_MESHNET.md](./NORDVPN_MESHNET.md).

This keeps the same Mac -> Windows path at home and while traveling.

### LAN-only alternative

On the Mac:

```bash
ipconfig getifaddr en0
```

Example:

```text
192.168.1.25
```

## 5. Run Windows setup

Open **PowerShell as Administrator** in the `local-coder-mcp` directory.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp <MAC_LAN_OR_MESHNET_IP> `
  -Mode Worker `
  -MaxConcurrentJobs 1 `
  -StartWorker
```

The script:

- pulls `qwen3.8:27b`;
- keeps Ollama on `127.0.0.1:11434`;
- configures one loaded model and one parallel inference;
- binds the local-coder worker to TCP `7337`;
- generates a high-entropy bearer token unless supplied;
- restricts the Windows Firewall rule to the supplied Mac address;
- defaults Git hosts to `github.com`;
- defaults dependency bootstrap to `auto`;
- enables persistent repo intelligence;
- builds and tests local-coder;
- optionally starts the worker.

To disable repo intelligence for a temporary diagnostic run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp <MAC_IP> `
  -Mode Worker `
  -DisableRepoIntelligence `
  -StartWorker
```

For GitHub Enterprise:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp <MAC_IP> `
  -Mode Worker `
  -AllowedGitHosts "github.com,github.company.example" `
  -StartWorker
```

The script prints the **WORKER TOKEN once**. Copy it to the Mac. Do not commit it or place it in project files.

## 6. Restart Ollama once after first setup

The setup writes user environment variables that Ollama inherits at startup.

After the first configuration:

1. quit Ollama completely from the Windows tray;
2. start Ollama again;
3. verify loopback-only availability.

```powershell
Get-NetTCPConnection -LocalPort 11434 -State Listen
Invoke-RestMethod http://127.0.0.1:11434/api/tags
ollama list
```

The selected model should include:

```text
qwen3.8:27b
```

Ollama itself should **not** need to be reachable from the Mac in Worker mode.

## 7. Verify worker locally

```powershell
$TOKEN = "YOUR_WORKER_TOKEN"
Invoke-RestMethod `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  http://127.0.0.1:7337/v1/health
```

Expected shape:

```text
protocolVersion = 1
workerVersion   = 0.10.0
ok              = True
model           = qwen3.8:27b
repoIntelligence.enabled = True
scheduler.maxConcurrentJobs = 1
```

## 8. Start worker automatically at logon

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker-task.ps1
Start-ScheduledTask -TaskName "Local Coder Remote Worker"
```

Remove later with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker-task.ps1 -Remove
```

Do not run both a manually launched worker and the scheduled worker on port `7337`.

## 9. Keep the workstation awake

The display may turn off, but the PC/network connection must remain available.

```powershell
powercfg /getactivescheme
```

For a dedicated always-on AC workstation, if appropriate:

```powershell
powercfg /change standby-timeout-ac 0
```

---

# B. Connect the Mac and Claude

## 10. Determine the Windows worker address

### Meshnet

Prefer the Windows **Nord name** or Meshnet address documented in [NORDVPN_MESHNET.md](./NORDVPN_MESHNET.md).

### LAN

On Windows:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Format-Table InterfaceAlias, IPAddress
```

## 11. Test the authenticated worker from the Mac

```bash
TOKEN='YOUR_WORKER_TOKEN'
curl \
  -H "Authorization: Bearer $TOKEN" \
  http://<WINDOWS_HOST>:7337/v1/health
```

Without the token, the endpoint should reject the request:

```bash
curl -i http://<WINDOWS_HOST>:7337/v1/health
```

Expected: HTTP `401`.

## 12. Build/update the Mac bridge

```bash
cd ~/WORK/local-coder-mcp
git switch main
git pull
npm install --no-package-lock
npm run check
npm run build
```

## 13. Configure Claude for strict remote-worker mode

```bash
npm run install:claude:worker -- \
  --host <WINDOWS_HOST> \
  --token "$TOKEN"
```

The installer now defaults to:

```text
LOCAL_CODER_EXECUTION_MODE=remote
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS=7200000
```

An explicit override remains possible:

```bash
npm run install:claude:worker -- \
  --host <WINDOWS_HOST> \
  --token "$TOKEN" \
  --model qwen3.8:27b
```

Then install/update Claude routing and token guards:

```bash
npm run install:routing
npm run install:claude-token-saver
```

Fully quit and reopen Claude Desktop/Code after user-level MCP configuration changes.

## 14. Verify Claude -> Mac MCP -> Windows

Ask Claude:

```text
Check local_coder_health and tell me the execution mode, worker model,
repo-intelligence status, queue state and whether local fallback is enabled.
```

Expected:

```text
executionMode: remote
worker.ok: true
worker.model: qwen3.8:27b
worker.repoIntelligence.enabled: true
localFallbackEnabled: false
```

On Windows while a job runs:

```powershell
nvidia-smi -l 1
```

and:

```powershell
ollama ps
```

Heavy model/build load should appear on Windows, not the Mac.

---

# C. Multiple Claude sessions

Multiple Claude sessions may submit work concurrently. The safe default is a queue:

```text
Claude session A -> running
Claude session B -> queued
Claude session C -> queued
```

Default:

```text
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
OLLAMA_NUM_PARALLEL=1
```

Do not raise concurrency merely because many sessions exist. A single Qwen3.8 inference plus Node/TypeScript/test workloads is the intended resource profile for the initial workstation.

If later changed to `2`, different worktrees may overlap in non-inference phases; same-checkout jobs and Ollama inference remain serialized.

---

# D. Source-state and repo-intelligence isolation

The Windows worker never mounts the live Mac filesystem.

For each remote run the Mac sends bounded state:

```text
origin URL
HEAD/base SHA
safe dirty patch
safe relevant untracked files
editable-file hash preconditions
opaque checkout isolation key
opaque Git-clone memory scope key
```

The worker reconstructs a disposable Windows worktree and returns bounded file changes.

Before applying returned changes, the Mac verifies file hashes. If the local worktree changed while the Windows job was running, the result is rejected instead of overwriting newer work.

Repo intelligence is stored on Windows outside target repositories. Linked worktrees from the same Mac clone share an opaque memory scope; separate clones of the same Git origin receive different scopes. This prevents accidental learned-context reuse across distinct trust/company setups while still allowing normal Engineering OS worktrees to benefit from the same repository knowledge.

See [REPO_INTELLIGENCE.md](./REPO_INTELLIGENCE.md).

---

# E. Dependency bootstrap

Default:

```text
LOCAL_CODER_WORKER_BOOTSTRAP=auto
```

The worker uses the repository lockfile when possible:

```text
pnpm-lock.yaml      -> pnpm install --frozen-lockfile
yarn.lock           -> yarn install --frozen-lockfile
bun.lock/bun.lockb  -> bun install --frozen-lockfile
package-lock.json   -> npm ci
package.json only   -> npm install
```

This intentionally moves bootstrap/validation I/O off the Mac.

---

# F. Firewall verification

```powershell
Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Get-NetFirewallAddressFilter

Get-NetFirewallRule -DisplayName "Local Coder - Worker from Mac" |
  Get-NetFirewallPortFilter
```

Expected worker port: `7337`.

The remote address must be the allowed Mac LAN/Meshnet IP, not `Any`.

Inspect all relevant rules:

```powershell
Get-NetFirewallRule |
  Where-Object DisplayName -Match "Ollama|Local Coder" |
  Format-Table DisplayName, Enabled, Profile, Direction, Action
```

**Never add router/NAT port forwarding for `7337` or `11434`.**

---

# G. Troubleshooting

## Worker unavailable

Windows:

```powershell
Get-NetTCPConnection -LocalPort 7337 -State Listen
```

Then verify Meshnet/LAN reachability and the firewall's remote-address restriction.

Strict `remote` mode intentionally does not fall back to heavyweight Mac inference.

## HTTP 401

Repair the worker-token mismatch, then rerun the Mac installer with the correct token.

Windows user token, when intentionally debugging:

```powershell
[Environment]::GetEnvironmentVariable("LOCAL_CODER_WORKER_TOKEN", "User")
```

## Private repository cannot be cloned

```powershell
git ls-remote <EXACT_ORIGIN_URL> HEAD
```

Fix Windows Git credentials and, for non-GitHub.com hosts, `-AllowedGitHosts`.

## Package manager missing

Install the package manager on Windows for the same account that runs the worker/scheduled task.

## Qwen3.8 missing

```powershell
ollama list
ollama pull qwen3.8:27b
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

## Too much RAM/VRAM usage

Keep:

```text
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
LOCAL_CODER_NUM_CTX=16384
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
```

Do not raise context before there is a concrete evidence-quality reason to do so.

---

# H. Rollback

Restore local Mac execution:

```bash
cd ~/WORK/local-coder-mcp
npm run install:claude
```

Stop/remove Windows startup:

```powershell
Stop-ScheduledTask -TaskName "Local Coder Remote Worker" -ErrorAction SilentlyContinue
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker-task.ps1 -Remove
```

Remove the worker firewall rule if the worker is no longer used:

```powershell
Remove-NetFirewallRule -DisplayName "Local Coder - Worker from Mac"
```

Ollama and repo-intelligence data can remain installed for later reuse, or be removed manually after the worker is stopped.

For protocol/source reconstruction details see [REMOTE_WORKER_ARCHITECTURE.md](./REMOTE_WORKER_ARCHITECTURE.md).
