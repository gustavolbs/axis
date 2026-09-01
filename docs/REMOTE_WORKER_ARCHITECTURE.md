# Remote inference worker architecture

## Goal

Keep the Mac application as the source of truth for Projects, repository state, routing, planning, validation and Repo Intelligence while optionally using a Windows workstation for heavier local inference.

```text
Mac
Local Coder.app
  -> DesktopAppRuntime
      -> Agent Runtime
          -> authenticated LAN / NordVPN Meshnet
              -> Windows worker
                  -> Qwen/Ollama inference
                  -> bounded disposable execution workspace when requested
          <- bounded result / inference output
      -> verify local source state
      -> apply validated changes on the Mac
```

The Windows worker is infrastructure for the standalone app. It is not a control plane, UI host, MCP server or product entrypoint.

## Why not edit the Mac filesystem remotely

Direct SMB/SSHFS editing introduces avoidable failure modes:

- Windows/macOS filesystem semantics differ;
- package-manager/native dependencies can be platform-specific;
- build/watch tools behave poorly over network filesystems;
- locking is less predictable;
- a network interruption can happen during a live write;
- tests/builds would contend with the Mac workspace.

Instead, Windows reconstructs a bounded invocation state locally and returns only task-produced changes or inference output.

## Workspace snapshot

A remote execution run may carry:

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

`isolationKey` is derived from the concrete Mac checkout/worktree. It prevents mutable jobs targeting that checkout from overlapping.

`memoryScopeKey` is derived from Git's common directory on the Mac. Linked worktrees from one clone share it, while a separate clone receives a different opaque key even when both use the same origin.

```text
clone A
  worktree A1 ─┐
  worktree A2 ─┼─ shared Repo Intelligence
               │
clone B        │
  worktree B1 ─── independent memory scope
```

The raw Mac filesystem path is never required by the Windows worker.

## Protocol

Every worker endpoint requires:

```text
Authorization: Bearer <worker-token>
```

The worker rejects incompatible protocol versions and validates bounded request bodies.

### Health

```text
GET /v1/health
```

Reports worker/protocol version, host/platform, configured model, queue/scheduler state, Repo Intelligence state and Ollama health.

### Read-only generation

```text
POST /v1/chat
```

Uses the Windows model for a routed cognitive stage while the Agent Runtime remains on the Mac.

### Execute bounded task

```text
POST /v1/execute-task
```

Used when the solution and editable files are already known.

### Execute implementation graph

```text
POST /v1/execute-plan
```

Runs the transactional dependency-ordered executor in one disposable Windows worktree.

### Execute open-ended engineering

```text
POST /v1/engineer
```

Runs the bounded engineering pipeline on reconstructed source state when remote execution is selected:

```text
Repo Intelligence retrieval
-> current evidence
-> investigation
-> planning
-> bounded coding/retries
-> deterministic validation
-> adversarial review
-> bounded repair
-> successful-run learning
```

If a material user decision or unresolved external fact remains, the result is a neutral `needs-guidance` checkpoint that the standalone app presents to the user.

## Worker run lifecycle

For a remote job the worker:

1. validates bearer authentication, protocol and body limits;
2. validates repository-host policy;
3. queues the job according to worker concurrency/isolation rules;
4. clones/fetches a local bare mirror;
5. checks out the requested base SHA into a unique detached worktree;
6. applies tracked dirty state and safe untracked files;
7. verifies expected file hashes where supplied;
8. bootstraps dependencies according to host policy;
9. resolves Repo Intelligence identity using the Mac clone scope;
10. executes the requested inference/task/plan/engineering operation;
11. runs Windows-side validation when execution is remote;
12. returns bounded changed files and execution metadata;
13. cleans the disposable worktree in `finally`.

## Queue and concurrency

Default:

```text
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
OLLAMA_NUM_PARALLEL=1
```

The Local Coder app may queue several jobs, but one heavy worker job runs at a time initially.

If worker concurrency is later raised:

- jobs for the same concrete checkout never overlap;
- different worktrees may overlap in non-inference phases;
- Ollama inference remains serialized machine-wide unless the operator deliberately changes that policy.

## Mac apply lifecycle

The worker never writes directly to the Mac workspace.

Before applying returned changes, Local Coder verifies every target file against the before-state hash captured when the job started.

```text
all hashes match
    -> apply bounded changed files

any hash changed
    -> apply nothing
    -> explicit conflict
```

If a local write fails after apply begins, target files are restored to their pre-apply snapshots.

## Repo Intelligence lifecycle

Persistent memory stays outside company repositories.

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

See [REPO_INTELLIGENCE.md](./REPO_INTELLIGENCE.md).

## Model and resource policy

Recommended baseline for the 27B worker path:

```text
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
```

The advertised model context may be larger, but 16K is the intentional initial operating point. Local Coder should improve retrieval/evidence quality before increasing context aggressively.

## Security boundary

- bearer-authenticated worker protocol;
- source-address firewall restrictions where configured;
- bounded request and changed-file payloads;
- blocked secret/workspace paths;
- disposable worktrees;
- compare-and-swap file application on the Mac;
- local inference lock and checkout mutation exclusion;
- no product UI or provider credentials hosted by the worker.

See [WINDOWS_REMOTE_SETUP.md](./WINDOWS_REMOTE_SETUP.md) and [NORDVPN_MESHNET.md](./NORDVPN_MESHNET.md).
