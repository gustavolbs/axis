# local-coder-mcp

Claude-facing local software engineering agent. Claude remains the user interface and premium escalation layer; normal repository investigation, planning, implementation, validation, review, repair and repository learning can run on a local/remote Ollama worker.

## v0.10 recommended architecture

```text
Developer
   |
   v
Claude Desktop / Claude Code
   |
   | user-scoped stdio MCP on Mac
   v
local-coder control bridge
   |
   | authenticated LAN / NordVPN Meshnet
   v
Windows local-coder worker :7337
   |
   +--> Git mirror + disposable worktree
   +--> persistent repo intelligence
   +--> bounded repository evidence/search
   +--> Qwen3.8 reasoning/planning
   +--> bounded coding/retries
   +--> lint/tests/typecheck/build
   +--> adversarial review/repair
   +--> learn reusable source-backed facts
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
       (premium reasoning / web research)
              |
              | claudeGuidance
              v
       local_engineer resumes
```

Claude is the **control/interface layer**, not the mandatory planner/implementer for every engineering task.

## `local_engineer`

For an open-ended request such as:

```text
Temos um repo chamado Work Broker MCP e quero usar React nele.
Entenda o projeto, quebre em etapas e faça a alteração.
```

Claude should normally call `local_engineer` with the active Project/session workspace and the user's goal.

The worker performs:

```text
retrieve repo intelligence
        ↓
map current repository
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
adversarial review
        ↓
bounded repair
        ↓
learn source-backed repo facts
        ↓
success OR compact Claude escalation
```

If external/current information or premium judgment is required, local-coder returns only the unresolved questions, research requests and evidence. Claude resolves that gap and calls `local_engineer` again with `claudeGuidance`.

See [docs/LOCAL_ENGINEER.md](docs/LOCAL_ENGINEER.md).

## Persistent Repo Intelligence — v0.10

`local_engineer` gets progressively more effective on repositories it has already worked with without fine-tuning model weights.

Worker-local memory can retain:

```text
architecture boundaries
conventions
invariants
procedures
successful task lessons
failure/review lessons
recent Git changes
```

Memory is evidence-backed and advisory:

```text
current source/tests > repo intelligence > generic model memory
```

Source fingerprints and Git SHA tracking mark learned facts stale when supporting code changes, including uncommitted changes.

After successful work, a low-effort local learner extracts a small number of reusable source-backed facts. Failed/escalated runs are recorded historically but do not become durable architecture truth.

See [docs/REPO_INTELLIGENCE.md](docs/REPO_INTELLIGENCE.md).

## Default Windows model: Qwen3.8 27B

The v0.10 Windows worker defaults to:

```text
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
```

The model advertises a much larger context, but 16K is deliberate for the RTX 3060 12 GB / 64 GB RAM worker. The system should first improve evidence selection and repo-memory retrieval rather than spend RAM/KV cache on indiscriminate context.

Reasoning stages express model-agnostic intent. For Qwen3.8, the Ollama client maps our `high` intent to `think:true`, allowing the model's current template to use its default **xhigh** reasoning mode. `medium`, `low` and `false` remain unchanged.

## Multiple Claude sessions / projects / companies

There is one Windows worker service, but any number of Claude sessions may submit jobs through independent stdio MCP processes.

Safe default:

```text
Claude session A -> job A -> running
Claude session B -> job B -> queued
Claude session C -> job C -> queued
```

The worker scheduler:

- accepts jobs from independent Claude sessions;
- defaults to one heavy job at a time;
- never overlaps mutable jobs for the same concrete checkout;
- may overlap different worktrees only if worker concurrency is explicitly raised;
- keeps Ollama inference serialized machine-wide.

Claude Engineering OS remains authoritative for Project/session/worktree identity. Work Broker remains authoritative for company-scoped integrations/credentials. local-coder never merges company context.

Repo-intelligence isolation adds another boundary:

- linked worktrees from the same Git clone share learned repo knowledge;
- separate clones get different opaque memory scopes even when the origin URL is identical;
- monorepo sub-workspaces remain distinct identities.

## Remote worker / travel

Recommended deployment:

```text
Mac = Claude UI + source of truth + thin MCP control plane
Windows = Qwen + repo mirrors/worktrees + repo intelligence + builds/tests
```

Ollama remains Windows-loopback only at `127.0.0.1:11434`. Only the authenticated worker port `7337` is reachable from the allowed Mac address.

For a stable home/travel path, use **NordVPN Meshnet** rather than router port forwarding:

- [docs/NORDVPN_MESHNET.md](docs/NORDVPN_MESHNET.md)
- [docs/WINDOWS_REMOTE_SETUP.md](docs/WINDOWS_REMOTE_SETUP.md)
- [docs/REMOTE_WORKER_ARCHITECTURE.md](docs/REMOTE_WORKER_ARCHITECTURE.md)

Never expose `7337` or `11434` through public router/NAT port forwarding.

## Windows quick setup

PowerShell as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-host.ps1 `
  -MacIp <MAC_LAN_OR_MESHNET_IP> `
  -Mode Worker `
  -MaxConcurrentJobs 1 `
  -StartWorker
```

This pulls `qwen3.8:27b`, configures the worker/firewall, enables repo intelligence, builds/tests the project and prints a worker token.

On the Mac:

```bash
npm run install:claude:worker -- \
  --host <WINDOWS_LAN_IP_OR_NORD_NAME> \
  --token '<WORKER_TOKEN>'

npm run install:routing
npm run install:claude-token-saver
```

Fully restart Claude Desktop/Code and ask it to check `local_coder_health`.

## Execution modes

| Mode | Behavior |
| --- | --- |
| `local` | Ollama + repository execution on the same machine. |
| `remote` | Authenticated Windows worker required; **no silent Mac fallback**. Recommended. |
| `auto` | Prefer remote, but may fall back locally when worker is unavailable. Use only intentionally. |

```text
LOCAL_CODER_EXECUTION_MODE=local|remote|auto
```

## MCP tools

v0.10 exposes thirteen tools:

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

Use `execute_local_code_plan_compact` when Claude already has a concrete dependency-ordered plan.

Use `local_engineer` when the user gives an outcome and expects investigation/decomposition/implementation.

## Claude routing

Install/update the global rule:

```bash
npm run install:routing
```

It installs:

```text
~/.claude/rules/local-coder.md
```

The intended policy is:

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

Project-specific rules remain authoritative when they conflict with this global default.

## Sensitive / premium boundaries

The local engineer may infer ordinary implementation choices from repository evidence, but escalates material unresolved sensitive decisions.

Hard premium gates include cryptographic design, destructive production-data actions and production access-control/IAM decisions. The planner may also request Claude for product/architecture judgment or current external documentation that cannot be established locally.

Existing `local-supervised` remains available for already-resolved bounded auth/credential/permission implementation and keeps mandatory full-diff Claude review.

## Remote workspace safety

Windows never mounts or directly edits the live Mac repository.

The Mac sends:

```text
origin repository URL
HEAD/base SHA
safe tracked dirty binary patch
safe relevant untracked files
editable-file hash preconditions
opaque concrete-checkout isolation key
opaque Git-clone memory scope key
```

Windows reconstructs the state in a disposable worktree and returns bounded changes.

Before applying anything, the Mac verifies `beforeSha256`. If the Mac worktree changed while Windows was working, the result is rejected instead of overwriting newer work.

Traversal, symlink escapes, `.git`, `node_modules`, `.ssh`, and real `.env*` files remain blocked by workspace policy.

## Compact results / Token Killer

Full execution state remains lazy. Claude initially receives compact status/plan/validation/review/reasoning/repo-intelligence metadata plus a `runId`.

Use `get_local_run` with `summary`, `diff`, `validation` or `full` only when needed. Do not load full local plans/diffs into Claude context by default.

Claude-side Tool Search/output guards:

```bash
npm run install:claude-token-saver
```

## Telemetry

Metadata-only telemetry records route/status/attempt/model/token/duration/count data, not prompts or source code.

Key local-engineer metrics include:

```text
localSuccessRate
claudeEscalationRate
repairRounds
plannedTasks
changedFiles
```

The objective is to increase local success while deterministic validation/review quality remains stable, not merely maximize local routing.

## Core configuration

| Variable | Default / setup value | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama API used by local/worker process |
| `LOCAL_CODER_MODEL` | Windows setup: `qwen3.8:27b` | selected executor/reasoner |
| `LOCAL_CODER_NUM_CTX` | `16384` | bounded Ollama context |
| `LOCAL_CODER_EXECUTION_MODE` | raw default `local`; recommended `remote` | execution topology |
| `LOCAL_CODER_REMOTE_WORKER_URL` | — | Windows worker URL |
| `LOCAL_CODER_REMOTE_WORKER_TOKEN` | — | bearer token |
| `LOCAL_CODER_WORKER_PORT` | `7337` | authenticated worker port |
| `LOCAL_CODER_WORKER_STATE_PATH` | `~/.local-coder-mcp/worker` | mirrors/worktrees/repo intelligence |
| `LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS` | `1` | heavy worker jobs |
| `LOCAL_CODER_REPO_INTELLIGENCE_ENABLED` | `true` | persistent per-repo learning |
| `LOCAL_CODER_REPO_INTELLIGENCE_PATH` | under worker state | optional memory location override |

Legacy local-only adaptive 7B -> 14B configuration remains for backwards compatibility; the recommended Windows worker disables adaptive tiers and uses one strong Qwen3.8 model.

## Requirements

Mac control plane:

- Node.js 20+;
- Git;
- Claude Desktop/Code with local MCP support;
- this repository built locally.

Windows execution plane:

- Node.js 20+;
- Git for Windows + repo credentials;
- NVIDIA driver;
- Ollama;
- `qwen3.8:27b`;
- package managers required by target repositories;
- LAN or NordVPN Meshnet reachability from the Mac.

## Install / update

Mac repository after the PR stack lands:

```bash
git switch main
git pull
npm install --no-package-lock
npm run check
npm run build
npm run install:routing
npm run install:claude-token-saver
```

For Windows worker deployment use [docs/WINDOWS_REMOTE_SETUP.md](docs/WINDOWS_REMOTE_SETUP.md).

## Safety boundaries

- explicit workspace/file boundaries;
- path traversal/symlink escape protection;
- secret environment files blocked;
- bounded context/body sizes;
- validation uses allowlisted executables with `shell:false`;
- transactional task/plan/local-engineer rollback;
- authenticated Windows worker + source-address firewall rule;
- no silent Mac fallback in strict remote mode;
- per-checkout worker mutual exclusion;
- machine-wide Ollama inference serialization;
- clone-scoped repo-intelligence isolation;
- stale-memory invalidation;
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
- [x] persistent repo intelligence + familiarity/staleness tracking
- [x] clone-scoped memory isolation across Engineering OS worktrees
- [x] Qwen3.8 27B Windows default + reasoning normalization
- [ ] cancellation propagation / active-run cancellation
- [ ] stale worker mirror/index/run retention policy
- [ ] dependency/template worktree cache optimization

## License

MIT
