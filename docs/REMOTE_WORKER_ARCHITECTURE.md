# v0.10 Remote Execution Worker architecture

## Goal

Keep the Mac as **source of truth + Claude control plane** and the Windows workstation as the **execution/intelligence plane**, without mounting the live Mac repository over SMB/SSHFS.

```text
Mac
Claude Desktop / Claude Code
  -> thin stdio local-coder bridge
      -> authenticated LAN / NordVPN Meshnet
          -> Windows worker
              -> repository mirror/cache
              -> disposable worktree
              -> reconstructed Mac source state
              -> persistent repo intelligence
              -> Qwen3.8 reasoning/coding/review
              -> lint/tests/typecheck/build
              -> bounded changed-file payloads
      <- execution result + changes
  -> compare-and-swap source verification
  -> apply changes locally
```

## Why not edit the Mac filesystem remotely

Direct SMB/SSHFS editing introduces avoidable failure modes:

- Windows/macOS filesystem semantics differ;
- package-manager/native dependencies can be platform-specific;
- build/watch tools behave poorly over network filesystems;
- locking is less predictable;
- a network interruption can happen during a live write;
- tests/builds would still contend with the Mac workspace.

Instead, Windows reconstructs invocation state locally and returns only task-produced changes.

## Workspace snapshot

Each remote run carries:

```text
origin repository URL
base commit SHA
workspace-relative root
tracked dirty binary patch
safe untracked files
expected hashes for known editable files
opaque checkout isolation key
opaque Git-clone memory scope key
```

Real `.env*` secrets, `.ssh`, `.git`, `node_modules` and other blocked workspace paths are not transported.

### Two independent isolation keys

`isolationKey` is derived from the **concrete Mac checkout/worktree**. It prevents mutable jobs targeting that checkout from overlapping.

`memoryScopeKey` is derived from Git's **common-dir** on the Mac. Linked worktrees from one clone share it, while a separate clone receives a different opaque key even if both clones use the same Git origin.

This gives the intended behavior:

```text
clone A
  worktree A1 ─┐
  worktree A2 ─┼─ shared repo intelligence
               │
clone B        │
  worktree B1 ─── independent memory scope
```

The raw Mac filesystem paths are never required by the Windows worker.

## Protocol v1

Every endpoint requires:

```text
Authorization: Bearer <worker-token>
```

The worker rejects incompatible protocol versions and validates bounded request bodies.

### Health

```text
GET /v1/health
```

Reports worker/protocol version, host/platform, configured model, queue/scheduler state, repo-intelligence state and Ollama health.

### Read-only generation

```text
POST /v1/chat
```

Keeps model inference off the Mac even for read-only delegation.

### Execute bounded task

```text
POST /v1/execute-task
```

Used when the solution and editable files are already known.

### Execute Claude-planned graph

```text
POST /v1/execute-plan
```

Runs the transactional dependency-ordered executor in one disposable Windows worktree.

### Execute open-ended local engineering

```text
POST /v1/engineer
```

Runs:

```text
repo intelligence retrieval
-> current evidence
-> investigation/reasoning
-> planning
-> bounded coding/retries
-> deterministic validation
-> adversarial review
-> bounded repair
-> successful-run learning
```

If unresolved premium reasoning/current external research is needed, the response contains a compact Claude escalation instead of silently guessing.

## Worker run lifecycle

For a remote job the worker:

1. validates bearer authentication/protocol/body limits;
2. validates repo host policy;
3. queues the job according to worker concurrency/isolation rules;
4. clones/fetches a local bare mirror;
5. checks out the requested base SHA into a unique detached worktree;
6. applies tracked dirty state and safe untracked files;
7. verifies expected file hashes where supplied;
8. bootstraps dependencies according to host policy;
9. resolves repo-intelligence identity using the Mac clone scope;
10. executes task/plan/local-engineer logic;
11. runs Windows validation/builds;
12. returns bounded changed files and execution metadata;
13. cleans the disposable worktree in `finally`.

## Queue and concurrency

Default:

```text
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
OLLAMA_NUM_PARALLEL=1
```

Multiple Claude sessions may submit jobs simultaneously, but one heavy job runs at a time initially.

If worker concurrency is later raised:

- jobs for the same concrete checkout never overlap;
- different worktrees may overlap in non-inference phases;
- Ollama inference remains serialized machine-wide.

## Mac apply lifecycle

The worker never writes directly to the Mac.

Before applying returned changes, the bridge verifies every target file against the before-state hash captured when the job started.

```text
all hashes match
    -> apply bounded changed files

any hash changed
    -> apply nothing
    -> explicit conflict
```

If a local write fails after apply begins, target files are restored to their pre-apply snapshots.

## Repo intelligence lifecycle

Persistent memory lives under the worker state directory rather than inside company repositories.

Each durable fact is source-backed and carries source fingerprints, confidence and Git validation metadata.

Before each run:

```text
load memory
-> detect committed changes
-> compare source fingerprints
-> mark stale facts
-> retrieve only goal-relevant knowledge
```

After successful work:

```text
bounded result/diff
-> low-effort learner
-> reusable source-backed facts
-> atomic memory update
```

Repo-memory writes are protected by per-identity filesystem locks and atomic replacement.

See [REPO_INTELLIGENCE.md](./REPO_INTELLIGENCE.md).

## Model policy

The protocol remains model-agnostic. The v0.10 Windows installer selects:

```text
qwen3.8:27b
num_ctx=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
```

16K is intentionally conservative for the RTX 3060 12 GB / 64 GB RAM workstation. Repo-memory/evidence quality should be improved before increasing context.

### Reasoning normalization

local-coder stages use a model-agnostic intent:

```text
high | medium | low | false
```

Qwen3.8's current template uses `xhigh` as maximum/default and does not accept literal `high`. The Ollama client therefore translates:

```text
qwen3.8 + high -> think:true -> model default xhigh
```

Other reasoning levels and other model families remain unchanged.

## Repository authentication on Windows

The worker does not receive Git credentials from the Mac.

Windows must already be able to clone/fetch target origin URLs through normal developer authentication, such as Git Credential Manager, SSH agent, or company-specific GitHub Enterprise credentials.

Credentials are not included in worker requests or telemetry.

## Network/authentication boundary

Worker mode uses:

```text
private LAN or NordVPN Meshnet
+ source-address restricted Windows Firewall
+ high-entropy bearer token
```

Ollama stays on Windows loopback:

```text
127.0.0.1:11434
```

The worker listens on `7337` according to setup policy. Do not router-port-forward either `7337` or `11434`.

For travel, use [NORDVPN_MESHNET.md](./NORDVPN_MESHNET.md).

## Dependency/bootstrap policy

Worker bootstrap modes:

```text
none
  no dependency install

auto
  detect root package manager/lockfile and install on Windows
```

`auto` maps:

```text
pnpm-lock.yaml      -> pnpm install --frozen-lockfile
yarn.lock           -> yarn install --frozen-lockfile
bun.lock/bun.lockb  -> bun install --frozen-lockfile
package-lock.json   -> npm ci
package.json only   -> npm install
```

Bootstrap commands are host policy; the model cannot invent arbitrary bootstrap shell commands.

## Execution modes

```text
LOCAL_CODER_EXECUTION_MODE=local
  same-machine execution

LOCAL_CODER_EXECUTION_MODE=remote
  Windows worker required; no silent Mac fallback

LOCAL_CODER_EXECUTION_MODE=auto
  remote preferred; local fallback only when worker is unavailable
```

The recommended Mac/Windows topology uses strict `remote` mode so a network outage cannot unexpectedly load the heavyweight model/build workload on the Mac.

## Worker state

Default Windows root:

```text
%USERPROFILE%\.local-coder-mcp\worker\
```

Contains logically:

```text
repos\               Git mirrors
worktrees\           disposable execution workspaces
repo-intelligence\   persistent learned repository knowledge
```

Control-plane compact run artifacts may still live on the Mac; heavy model/repo/build work is on Windows.

## Safety invariants

- no direct remote writes to the Mac filesystem;
- no silent local heavyweight fallback in strict remote mode;
- bounded workspace transport;
- blocked secret/sensitive paths;
- compare-and-swap Mac apply;
- per-checkout mutation isolation;
- machine-wide inference serialization;
- clone-scoped learned memory;
- stale-memory detection against current source;
- deterministic validation remains independent evidence;
- Claude escalation is explicit and resumable.
