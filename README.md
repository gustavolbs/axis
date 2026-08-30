# local-coder-mcp

Global MCP bridge that keeps Claude focused on reasoning, architecture, sensitive decisions, decomposition, and review while delegating bounded implementation to an Ollama coding executor.

v0.8 supports two execution topologies:

```text
LOCAL
Claude Code -> stdio MCP -> Ollama + repo execution on the same machine

REMOTE (recommended for a Mac + Windows workstation)
Claude Code on Mac
  -> thin stdio MCP bridge on Mac
  -> authenticated LAN worker on Windows
      -> Git mirror + disposable worktree
      -> Ollama/Qwen
      -> edits/retries
      -> lint/tests/typecheck/build
  -> bounded changes back to Mac
  -> source-state verification + apply
  -> Claude review
```

The remote design avoids mounting the live Mac repository over SMB/SSHFS. Windows reconstructs the source state from Git metadata and a bounded dirty-workspace delta, executes in a disposable worktree, and returns only allowed file changes.

## Why

The intended ownership split is:

```text
Claude
- ambiguous requirements
- architecture/system design
- unknown-root-cause investigation
- sensitive product/security decisions
- decomposition
- final review

local-coder execution plane
- bounded implementation with known behavior
- retries
- lint/tests/typecheck/build
- deterministic repository context processing
```

The guiding rule is:

> Claude should receive less information, not less important information.

## v0.8 Windows remote execution

For a dedicated Windows workstation, use strict remote mode so a worker outage never silently loads a large model on the Mac.

Recommended topology:

```text
Mac = control plane
Windows = execution plane
```

Windows Worker mode exposes only the authenticated worker port to the private LAN. Ollama stays loopback-only on Windows.

Full installation, Windows Firewall rules, Git authentication, Mac/Claude connection, startup task, troubleshooting, and rollback:

**[docs/WINDOWS_REMOTE_SETUP.md](docs/WINDOWS_REMOTE_SETUP.md)**

Protocol and source-state design:

**[docs/REMOTE_WORKER_ARCHITECTURE.md](docs/REMOTE_WORKER_ARCHITECTURE.md)**

### Quick shape

Windows, PowerShell as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp <MAC_LAN_IP> `
  -Mode Worker `
  -StartWorker
```

Copy the generated worker token. Then on the Mac:

```bash
npm run install:claude:worker -- \
  --host <WINDOWS_LAN_IP> \
  --token '<WORKER_TOKEN>'
```

Fully restart Claude Code/Desktop and check `local_coder_health`.

The Windows setup currently defaults its execution model to:

```text
qwen3.6:35b-a3b-coding
num_ctx=16384
parallel inference=1
max loaded models=1
```

The remote protocol is model-agnostic; the model can be replaced later without changing Claude's MCP workflow.

## Execution modes

| Mode | Behavior |
| --- | --- |
| `local` | Existing local Ollama + local repository execution. Default for backwards compatibility. |
| `remote` | Authenticated worker required. No silent fallback to local model execution. Recommended for the Windows workstation setup. |
| `auto` | Remote preferred; falls back locally only when the worker is classified unavailable. Use only when local fallback is actually desired. |

Configure with:

```text
LOCAL_CODER_EXECUTION_MODE=local|remote|auto
```

## MCP tools

The server preserves the same twelve tool names across local and remote execution:

- `local_coder_health`
- `classify_local_code_task`
- `discover_local_workspace`
- `search_local_workspace`
- `prepare_local_context`
- `delegate_code_task`
- `execute_local_code_task`
- `execute_local_code_task_compact` **preferred**
- `execute_local_code_plan`
- `execute_local_code_plan_compact` **preferred**
- `get_local_run`
- `local_coder_telemetry`

Claude does not need a different prompting workflow when execution moves to Windows.

## Routing

`classify_local_code_task` returns:

- `deterministic` — normal repository tooling is better than an LLM;
- `local` — bounded implementation with known solution/validation;
- `local-supervised` — a sensitive domain is touched, but Claude has already resolved the sensitive behavior and only bounded implementation remains;
- `claude` — discovery, architecture, ambiguity, or blocking risk is still unresolved.

The routing name `local` means “execution plane owned by local-coder”, not necessarily “physically execute on the Mac”. In `remote` mode, `local` and `local-supervised` work executes on Windows.

### Sensitive execution

Authentication, authorization, credentials, permissions, sessions, tokens, and secrets do not force all mechanical implementation into Claude.

After Claude explicitly resolves the sensitive behavior, bounded work can use:

```json
{
  "solutionKnown": true,
  "validationKnown": true,
  "sensitiveDecisionResolved": true,
  "riskTags": ["auth", "credentials"]
}
```

A `local-supervised` execution always forces full-diff Claude review. The execution model is explicitly constrained from redesigning auth/security contracts.

Cryptography design, unresolved architecture/discovery, unknown-root-cause debugging, destructive migrations, production infrastructure/IAM, concurrency/races, and similar work remain Claude blockers.

## Remote workspace safety

A remote task sends source state rather than granting Windows direct access to the live Mac filesystem:

```text
origin repository URL
+ HEAD/base commit SHA
+ safe tracked dirty patch
+ safe untracked files
+ SHA-256 preconditions for editable files
```

Windows:

1. creates/updates a local bare repository mirror;
2. creates a unique disposable worktree at the requested base SHA;
3. reconstructs the dirty source state;
4. verifies editable-file hashes;
5. bootstraps dependencies according to worker policy;
6. executes the existing bounded task/plan executor;
7. runs validation on Windows;
8. returns only changed editable files.

Mac apply is compare-and-swap: if any editable file changed while Windows was executing, no returned change is applied. A partially failed apply is rolled back to its pre-apply snapshots.

Existing path boundaries remain in force: traversal, symlink escapes, `.git`, `node_modules`, `.ssh`, and real `.env*` secret files are blocked. `.env.example`, `.env.sample`, and `.env.template` remain allowed.

## Compact results / Token Killer

`execute_local_code_task_compact` and `execute_local_code_plan_compact` are the preferred executors.

Complete results are stored under the control-plane run store:

```text
~/.local-coder-mcp/runs/<runId>/run.json
~/.local-coder-mcp/runs/<runId>/diff.patch
```

Claude initially receives status, validation/routing/review metadata, changed-file summary, model/token/latency metadata, and `runId`.

Use `get_local_run` with `summary`, `diff`, `validation`, or `full` only when needed. `local-supervised` explicitly requires the full diff before Claude approval.

In the first v0.8 cut, the compact run store and `prepare_local_context` index remain on the Mac/control plane. Model inference, edits, retries, and validation move to Windows in strict remote mode.

## Context capsules

`prepare_local_context` maintains a persistent repository index under:

```text
~/.local-coder-mcp/indexes/
```

It returns bounded file:line evidence instead of forcing Claude to broadly read a repository before every task.

## Large-feature orchestration

For broad features:

1. Claude understands requirements/architecture.
2. Claude resolves sensitive/product decisions.
3. Claude decomposes into bounded tasks, normally 1–5 editable files each.
4. `execute_local_code_plan_compact` validates the dependency DAG/routing.
5. Tasks execute sequentially in the configured execution plane.
6. Each task validates/retries there.
7. Final integration validation runs after tasks succeed.
8. Failed plans roll back by default.
9. Any supervised-sensitive task forces full aggregate-diff Claude review.

The coding model never owns architecture or sensitive-decision authority.

## Local v0.7 adaptive execution

Local mode retains the resource-safe v0.7 ladder:

```text
qwen2.5-coder:7b
   -> retry/escalation
qwen2.5-coder:14b
```

Defaults include:

- 16K Ollama context;
- 96 KB executor source-context cap;
- one machine-wide local inference at a time;
- unload the other configured model tier before switching;
- per-model inference telemetry.

See [docs/ADAPTIVE_EXECUTION.md](docs/ADAPTIVE_EXECUTION.md).

## Claude-side configuration

### Global routing policy

```bash
npm run install:routing
```

Installs:

```text
~/.claude/rules/local-coder.md
```

### Tool search / output guardrails / MCP permission

```bash
npm run install:claude-token-saver
```

It safely merges into `~/.claude/settings.json`:

- deferred MCP Tool Search;
- bounded MCP output;
- validation-output compaction hook;
- user-level permission `mcp__local-coder__*`.

Existing `permissions.allow`, `permissions.ask`, `permissions.deny`, env, and hooks are preserved. Claude Code evaluates permission rules in `deny -> ask -> allow` order, so a project/managed `ask` or `deny` may still win; use `/permissions` to locate it.

## Requirements

### Mac/local execution

- Node.js 20+;
- Ollama when using `local` mode;
- configured local models;
- Claude Code/Desktop Code tab with local MCP support.

### Windows worker execution

Mac:

- Node.js 20+;
- Git;
- Claude Code/Desktop;
- this repo built locally for the thin stdio bridge.

Windows:

- Node.js 20+;
- Git for Windows + repository credentials;
- Ollama + NVIDIA driver;
- selected coding model;
- package managers used by target repositories;
- private LAN reachability from the Mac.

See [WINDOWS_REMOTE_SETUP.md](docs/WINDOWS_REMOTE_SETUP.md).

## Install / update

Existing clone:

```bash
git switch main
git pull
npm install --no-package-lock
npm run check
npm run build
npm run install:routing
npm run install:claude-token-saver
```

First local setup:

```bash
npm run install:claude
npm run install:routing
npm run install:claude-token-saver
```

Windows worker setup uses the dedicated guide/installers rather than `install:claude`.

Fully restart Claude Code/Desktop after user-level MCP configuration changes.

## Test without Claude

Local MCP inspector:

```bash
npx @modelcontextprotocol/inspector \
  "$(which node)" \
  "$(pwd)/dist/index.js"
```

Windows worker health from Mac:

```bash
curl \
  -H "Authorization: Bearer $LOCAL_CODER_WINDOWS_WORKER_TOKEN" \
  http://<WINDOWS_IP>:7337/v1/health
```

## Configuration

### Core/local

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama API used in local/worker process |
| `LOCAL_CODER_ADAPTIVE_MODELS` | `true` | local 7B -> 14B adaptive execution |
| `LOCAL_CODER_FAST_MODEL` | `qwen2.5-coder:7b` | local fast model |
| `LOCAL_CODER_STRONG_MODEL` | `qwen2.5-coder:14b` | local strong retry model |
| `LOCAL_CODER_MODEL` | used when adaptive is false | single selected model |
| `LOCAL_CODER_NUM_CTX` | `16384` | Ollama context |
| `LOCAL_CODER_TIMEOUT_MS` | `180000` | model request timeout |
| `LOCAL_CODER_VALIDATION_TIMEOUT_MS` | `180000` | validation timeout |
| `LOCAL_CODER_MAX_FILE_BYTES` | `120000` | per-file limit |
| `LOCAL_CODER_MAX_CONTEXT_BYTES` | `96000` | executor source-context cap |
| `LOCAL_CODER_ALLOWED_COMMANDS` | `npm,pnpm,yarn,bun` | validation executable allowlist |
| `LOCAL_CODER_TELEMETRY_ENABLED` | `true` | metadata-only telemetry |
| `LOCAL_CODER_RUN_STORE_PATH` | `~/.local-coder-mcp/runs` | lazy full run results |
| `LOCAL_CODER_CONTEXT_INDEX_PATH` | `~/.local-coder-mcp/indexes` | persistent context index |

### Remote client

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_CODER_EXECUTION_MODE` | `local` | `local`, `remote`, or `auto` |
| `LOCAL_CODER_REMOTE_WORKER_URL` | — | e.g. `http://192.168.1.50:7337` |
| `LOCAL_CODER_REMOTE_WORKER_TOKEN` | — | bearer token; required for remote/auto |
| `LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS` | `1800000` | remote execution timeout |
| `LOCAL_CODER_REMOTE_MAX_DELTA_BYTES` | `8000000` | tracked+untracked workspace transport cap |

### Windows worker

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_CODER_WORKER_HOST` | `127.0.0.1` | worker listen host; setup script uses `0.0.0.0` + firewall |
| `LOCAL_CODER_WORKER_PORT` | `7337` | worker port |
| `LOCAL_CODER_WORKER_TOKEN` | — | required bearer token |
| `LOCAL_CODER_WORKER_STATE_PATH` | `~/.local-coder-mcp/worker` | repo mirrors/worktrees |
| `LOCAL_CODER_WORKER_MAX_BODY_BYTES` | `12000000` | HTTP body limit |
| `LOCAL_CODER_WORKER_ALLOWED_GIT_HOSTS` | empty in raw config | optional comma-separated host allowlist; setup defaults to `github.com` |
| `LOCAL_CODER_WORKER_BOOTSTRAP` | `none` in raw config | `none` or `auto`; Windows setup defaults to `auto` |

## Safety boundaries

- absolute workspace required;
- relative editable/context file paths only;
- path traversal/symlink escapes rejected;
- secret env files and sensitive directories blocked;
- explicit editable-file allowlist;
- bounded file/context/remote-body sizes;
- validation commands supplied by Claude, not invented by the coding model;
- validation uses `shell: false`;
- task/plan rollback by default;
- strict remote mode has no silent Mac inference fallback;
- Windows worker bearer authentication;
- worker setup uses Mac-IP-restricted Windows Firewall rule;
- remote source application uses SHA-256 conflict preconditions;
- supervised-sensitive changes require full-diff Claude review.

## Telemetry

Control-plane metadata telemetry:

```text
~/.local-coder-mcp/telemetry.jsonl
```

It records route/status/attempt/task/token/duration/count/model metadata, not prompts or source code.

The worker-side Ollama client can record its own local inference metadata under the worker user's configured telemetry path. Remote artifact/index consolidation is a later v0.8 step.

## Roadmap

- [x] MCP + Ollama bridge
- [x] bounded executor + validation/retry/rollback
- [x] deterministic/local/local-supervised/Claude routing
- [x] multi-task transactional orchestrator
- [x] compact/lazy results and review capsules
- [x] persistent context capsules
- [x] Claude Tool Search/output/permission installers
- [x] adaptive local 7B -> 14B execution
- [x] machine-wide local inference lock
- [x] authenticated Windows worker protocol
- [x] remote Git mirror + disposable worktree reconstruction
- [x] dirty tracked/untracked workspace transport
- [x] hash-safe remote result application on Mac
- [x] remote task/plan validation/build execution
- [x] Windows firewall/setup/startup documentation
- [ ] migrate context index/run artifacts fully to Windows worker
- [ ] remote cancellation propagation / active-run status
- [ ] stale worker cache retention policy
- [ ] optional private-overlay/TLS transport for off-LAN use

## License

MIT
