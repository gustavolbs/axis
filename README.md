# local-coder-mcp

Claude-facing local software engineering agent. Claude remains the interface; normal repository investigation, planning, implementation, validation and review can run on local Ollama hardware, including an authenticated Windows execution worker.

## v0.9 architecture

Recommended topology:

```text
Developer
   |
   v
Claude Desktop / Claude Code
   |
   | stdio MCP on Mac
   v
local-coder control bridge
   |
   | authenticated private LAN
   v
Windows local-coder worker :7337
   |
   +--> Git mirror + disposable worktree
   +--> bounded evidence/search
   +--> Qwen reasoning/planning
   +--> Qwen coding/retries
   +--> lint/tests/typecheck/build
   +--> adversarial local review/repair
   |
   +--> success ----------------------> bounded changes -> Mac -> Claude summary
   |
   +--> needs-claude / escalated
              |
              v
       compact escalation capsule
              |
              v
       Claude resolves exact gap
       (premium reasoning/research)
              |
              | claudeGuidance
              v
       local_engineer resumes
```

Claude is therefore the **control/interface layer**, not the mandatory implementation planner for every task.

## `local_engineer`

For an open-ended request such as:

```text
Temos um repo chamado Work Broker MCP e quero usar React nele.
Entenda o projeto, quebre em etapas e faça a alteração.
```

Claude should normally call `local_engineer` with the active Project/session workspace and the user's goal.

The worker performs:

```text
Observe / map repository
        ↓
collect bounded evidence
        ↓
investigate + reason
        ↓
targeted repository searches
        ↓
evidence-backed plan
        ↓
small exact-file tasks
        ↓
code + retry
        ↓
deterministic validation
        ↓
adversarial local review
        ↓
bounded repair
        ↓
success OR compact Claude escalation
```

If external/current information or a premium judgment is required, local-coder returns only the unresolved questions, research requests and evidence. Claude resolves that gap and calls `local_engineer` again with `claudeGuidance`.

See **[docs/LOCAL_ENGINEER.md](docs/LOCAL_ENGINEER.md)**.

## Why use a structured local agent instead of pretending Qwen is Opus

The design does not assume the local model has Claude/Opus-level raw reasoning.

It compensates with an explicit engineering protocol:

- evidence before conclusions;
- bounded repository discovery;
- targeted searches instead of broad context dumps;
- structured plans with exact editable files;
- transactional execution/rollback;
- real tests/typecheck/lint/build;
- adversarial diff review;
- confidence gates;
- targeted premium escalation.

The target is **similar engineering outcomes on a large share of normal work**, while reserving Claude tokens for the smaller set of decisions where stronger reasoning or web research materially improves correctness.

## Multiple Claude sessions / companies / projects

There is one Windows worker service, but any number of Claude Desktop/Code sessions may submit jobs through their own stdio MCP process.

Safe default:

```text
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
OLLAMA_NUM_PARALLEL=1
```

Example:

```text
Claude session A -> engineering job A -> running
Claude session B -> engineering job B -> queued
Claude session C -> engineering job C -> queued
```

The sessions remain isolated; only the heavyweight Windows resource is serialized.

The worker scheduler:

- has an explicit queue;
- reports active/queued counts through `local_coder_health`;
- hashes the concrete Mac checkout/worktree into an opaque isolation key;
- never overlaps jobs that target the same concrete checkout;
- may overlap different worktrees only when `LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS` is explicitly raised;
- still serializes Ollama inference machine-wide.

This matches the Claude Engineering OS model: Project/session/worktree identity remains authoritative outside local-coder. Work Broker remains responsible for company-scoped integrations/credentials. local-coder never merges company context or invents a cross-company workspace.

For the initial Ryzen 9 / RTX 3060 12 GB / 64 GB Windows host, **keep concurrency at 1** until actual resource behavior justifies raising it.

## Windows remote worker

Recommended deployment:

```text
Mac = control plane / Claude UI
Windows = execution plane / Ollama / Git worktrees / builds
```

Full Worker mode exposes only the authenticated worker port `7337` to the private LAN. Ollama stays on Windows loopback (`127.0.0.1:11434`). Windows Firewall is restricted to the Mac IP and Private network profile.

Do not port-forward the worker or Ollama ports on the router.

Full installation, firewall, Git authentication, startup, Mac/Claude connection, troubleshooting and rollback:

**[docs/WINDOWS_REMOTE_SETUP.md](docs/WINDOWS_REMOTE_SETUP.md)**

Remote source-state/worktree design:

**[docs/REMOTE_WORKER_ARCHITECTURE.md](docs/REMOTE_WORKER_ARCHITECTURE.md)**

### Windows quick setup

PowerShell as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp <MAC_LAN_IP> `
  -Mode Worker `
  -MaxConcurrentJobs 1 `
  -StartWorker
```

Default Windows executor configuration:

```text
qwen3.6:35b-a3b-coding
num_ctx=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
worker heavy-job concurrency=1
```

Copy the generated token. On the Mac:

```bash
npm run install:claude:worker -- \
  --host <WINDOWS_LAN_IP> \
  --token '<WORKER_TOKEN>'
```

Then reinstall the v0.9 routing rule:

```bash
npm run install:routing
```

Fully restart Claude Code/Desktop and ask it to check `local_coder_health`.

## Execution modes

| Mode | Behavior |
| --- | --- |
| `local` | Ollama + repository execution on the same machine. |
| `remote` | Authenticated Windows worker required; **no silent Mac fallback**. Recommended. |
| `auto` | Prefer remote, but may fall back locally when worker is unavailable. Use only when this is intentionally desired. |

```text
LOCAL_CODER_EXECUTION_MODE=local|remote|auto
```

## MCP tools

v0.9 exposes thirteen tools:

- `local_coder_health`
- `classify_local_code_task`
- `discover_local_workspace`
- `search_local_workspace`
- `prepare_local_context`
- `delegate_code_task`
- `execute_local_code_task`
- `execute_local_code_task_compact`
- `execute_local_code_plan`
- `execute_local_code_plan_compact`
- **`local_engineer`** — preferred for open-ended engineering goals
- `get_local_run`
- `local_coder_telemetry`

Use `execute_local_code_task_compact` when the solution and exact editable files are already known.

Use `execute_local_code_plan_compact` when Claude already has a detailed dependency-ordered plan.

Use `local_engineer` when the user specifies an outcome and expects investigation/decomposition/implementation.

## Claude routing

Install/update the global Claude rule:

```bash
npm run install:routing
```

It installs:

```text
~/.claude/rules/local-coder.md
```

The v0.9 policy is:

```text
normal open-ended engineering
    -> local_engineer first

local success
    -> do not redo broad work in Claude

local needs-claude/escalated
    -> Claude resolves only escalation.questions/researchRequests
    -> local_engineer resumes with claudeGuidance

explicit premium/high-risk decision
    -> Claude
    -> bounded implementation can return local
```

Project-specific rules remain authoritative when they conflict with the global default.

## Sensitive / premium boundaries

The local engineer may safely infer ordinary implementation choices from repository evidence, but must escalate material unresolved sensitive decisions.

Host-level premium gates include cryptographic design, destructive production-data actions and production access-control/IAM decisions. The planner can additionally ask Claude for product/architecture judgment, current external documentation or another decision it cannot establish confidently from repository evidence.

Existing `local-supervised` remains available for already-resolved bounded auth/credential/permission implementation and retains mandatory full-diff Claude review.

## Remote workspace safety

Windows never mounts or directly edits the live Mac repository.

The Mac sends:

```text
origin repository URL
+ HEAD/base commit SHA
+ safe tracked dirty binary patch
+ safe untracked files
+ editable-file hash preconditions where known
+ opaque concrete-checkout isolation key
```

Windows reconstructs the state in a disposable worktree, executes locally and returns bounded changes.

The Mac verifies `beforeSha256` before applying returned changes. If the developer/Claude changed a returned file while the Windows job was running, application is rejected instead of overwriting newer work.

Traversal, symlink escapes, `.git`, `node_modules`, `.ssh`, and real `.env*` files remain blocked by workspace policy.

## Compact results / Token Killer

Full execution state is persisted under:

```text
~/.local-coder-mcp/runs/<runId>/run.json
~/.local-coder-mcp/runs/<runId>/diff.patch
```

Claude receives a compact initial `local_engineer` result containing:

- status/phase/summary;
- plan confidence/task count;
- changed-file count;
- validation summary;
- local-review verdict/confidence;
- repair rounds;
- local reasoning token/time metadata;
- escalation capsule when needed;
- `runId`.

Use `get_local_run` with `summary`, `diff`, `validation` or `full` only when required. Do not load full plans/diffs into Claude context by default.

Claude-side Tool Search/output guards:

```bash
npm run install:claude-token-saver
```

This preserves existing settings while installing MCP Tool Search/output compaction and user-level `mcp__local-coder__*` permission support.

## Telemetry

Metadata-only telemetry is stored locally; prompts and source code are not recorded.

`local_coder_telemetry` now includes an `engineering` section with:

```text
total
success
needsClaude
escalated
errors
localSuccessRate
claudeEscalationRate
repairRounds
averageRepairRounds
plannedTasks
changedFiles
```

These are the key v0.9 metrics. The target is to increase `localSuccessRate` while keeping review/validation quality stable, not merely to maximize local routing.

Worker-local Ollama telemetry retains exact per-generation model/token/duration data.

## Configuration

### Core / model

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama API used by local/worker process |
| `LOCAL_CODER_ADAPTIVE_MODELS` | `true` | legacy local 7B -> 14B adaptive mode |
| `LOCAL_CODER_MODEL` | single model when adaptive=false | selected executor/reasoner |
| `LOCAL_CODER_NUM_CTX` | `16384` | Ollama context |
| `LOCAL_CODER_TIMEOUT_MS` | `180000` raw default | individual model request timeout |
| `LOCAL_CODER_VALIDATION_TIMEOUT_MS` | `180000` | validation timeout |
| `LOCAL_CODER_MAX_FILE_BYTES` | `120000` | per-file limit |
| `LOCAL_CODER_MAX_CONTEXT_BYTES` | `96000` | bounded local context cap |
| `LOCAL_CODER_ALLOWED_COMMANDS` | `npm,pnpm,yarn,bun` | validation executable allowlist |

### Remote Mac client

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_CODER_EXECUTION_MODE` | `local` | `local`, `remote`, `auto` |
| `LOCAL_CODER_REMOTE_WORKER_URL` | — | Windows worker URL |
| `LOCAL_CODER_REMOTE_WORKER_TOKEN` | — | bearer token |
| `LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS` | `1800000` raw default | total remote request timeout; installer uses `7200000` for queued engineering |
| `LOCAL_CODER_REMOTE_MAX_DELTA_BYTES` | `8000000` | tracked+untracked transport cap |

### Windows worker

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_CODER_WORKER_HOST` | `127.0.0.1` | setup uses `0.0.0.0` + restricted firewall |
| `LOCAL_CODER_WORKER_PORT` | `7337` | authenticated worker port |
| `LOCAL_CODER_WORKER_TOKEN` | — | required bearer token |
| `LOCAL_CODER_WORKER_STATE_PATH` | `~/.local-coder-mcp/worker` | mirrors/worktrees |
| `LOCAL_CODER_WORKER_ALLOWED_GIT_HOSTS` | empty raw config | setup defaults to `github.com` |
| `LOCAL_CODER_WORKER_BOOTSTRAP` | `none` raw config | setup defaults to `auto` |
| `LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS` | `1` | heavy worker jobs; 1 queues safely |

## Requirements

Mac control plane:

- Node.js 20+;
- Git;
- Claude Desktop/Code with local MCP support;
- this repository built locally.

Windows execution plane:

- Node.js 20+;
- Git for Windows + credentials for target repositories;
- NVIDIA driver;
- Ollama;
- selected model;
- package managers required by target repositories;
- private LAN reachability from Mac.

## Install / update

Mac repository:

```bash
git switch main
git pull
npm install --no-package-lock
npm run check
npm run build
npm run install:routing
npm run install:claude-token-saver
```

First local-only setup:

```bash
npm run install:claude
```

For Windows worker deployment use [WINDOWS_REMOTE_SETUP.md](docs/WINDOWS_REMOTE_SETUP.md) and `npm run install:claude:worker` instead.

## Safety boundaries

- explicit workspace and file boundaries;
- path traversal/symlink escape protection;
- secret environment files blocked;
- bounded context/body sizes;
- validation uses allowlisted executables with `shell:false`;
- transactional task/plan/local-engineer rollback;
- authenticated Windows worker + Mac-IP firewall rule;
- no silent Mac fallback in strict remote mode;
- per-checkout worker mutual exclusion;
- machine-wide Ollama inference serialization;
- compact premium escalation instead of unsafe guessing.

## Roadmap

- [x] MCP + Ollama bridge
- [x] bounded executor / validation / retry / rollback
- [x] compact/lazy results + context/review capsules
- [x] local-supervised sensitive implementation route
- [x] adaptive local models + machine-wide inference lock
- [x] authenticated Windows remote worker
- [x] Git mirror + disposable worktree reconstruction
- [x] dirty tracked/untracked transport + conflict-safe Mac apply
- [x] Windows tests/build execution
- [x] `local_engineer` evidence -> reason -> plan -> code -> validate -> review loop
- [x] Claude escalation / `claudeGuidance` resume contract
- [x] multi-session worker queue + per-worktree isolation
- [x] local-engineer success/escalation telemetry
- [ ] cancellation propagation / active-run cancellation
- [ ] stale worker mirror/index/run retention policy
- [ ] dependency/template worktree cache optimization
- [ ] optional private-overlay/TLS transport for off-LAN use

## License

MIT
