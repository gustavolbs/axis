# v0.8 Remote Execution Worker architecture

## Goal

Make the Mac the **control plane** and the Windows workstation the **execution plane**.

The final design keeps Claude Code on macOS but moves heavy local work to Windows without mounting the live Mac repository over SMB/SSHFS.

```text
Mac control plane
Claude Code
  -> thin local-coder MCP bridge
      -> authenticated LAN request
          -> Windows execution worker
              -> repository mirror/cache
              -> disposable worktree
              -> Mac workspace delta
              -> context/index
              -> local model
              -> edits + retries
              -> lint/tests/typecheck/build
              -> result + changed-file payloads
      <- compact result + bounded changes
  -> compare-and-swap source-state verification
  -> apply changes locally
  -> Claude review
```

## Why not edit the Mac filesystem over a network share

A direct SMB/SSHFS workspace would create several avoidable problems:

- Windows and macOS filesystem semantics differ;
- package-manager/native dependencies can be platform-specific;
- Node build tools may behave differently over network filesystems;
- lock/watch behavior becomes less predictable;
- a network interruption can occur during a write;
- validation would still exercise the Mac's live workspace and disk.

Instead, Windows receives enough source-state information to reconstruct the Mac workspace in a local disposable worktree. It returns only task-produced changes.

## Workspace identity

Each remote run is tied to:

```text
repository remote identity
+ base commit SHA
+ workspace-relative root
+ dirty tracked patch
+ relevant untracked files
+ expected hashes for editable files
```

This lets the worker faithfully reconstruct a dirty working tree without forcing the developer to commit before delegation.

## Proposed protocol

Protocol versioning is mandatory from the first remote-worker release.

### Worker health

```text
GET /v1/health
Authorization: Bearer <worker-token>
```

Response contains:

- protocol version;
- worker version;
- Windows hostname/platform;
- configured execution model;
- Ollama health;
- available model(s);
- execution queue state/capabilities.

### Execute bounded task

```text
POST /v1/execute-task
Authorization: Bearer <worker-token>
Content-Type: application/json
```

Request conceptually contains:

```json
{
  "protocolVersion": 1,
  "workspace": {
    "repository": "git@github.com:org/repo.git",
    "baseSha": "...",
    "workspaceRelativePath": "...",
    "dirtyPatch": "...",
    "untrackedFiles": [],
    "editableFileHashes": {}
  },
  "task": {
    "task": "...",
    "editableFiles": [],
    "contextFiles": [],
    "validation": []
  }
}
```

The worker:

1. resolves/updates its local repository mirror;
2. verifies the requested base SHA;
3. creates a unique disposable worktree;
4. applies the tracked dirty delta;
5. restores relevant untracked files;
6. verifies editable-file hashes;
7. prepares dependencies/workspace according to worker policy;
8. executes the existing bounded executor;
9. validates/retries on Windows;
10. returns compact metadata plus actual changed file contents/hash preconditions;
11. destroys/prunes the disposable worktree.

### Apply result on Mac

The Mac bridge must never blindly overwrite files.

Before writing anything it verifies that **all** editable files still have the same hashes captured when the remote run started.

```text
hashes still match
    -> atomically apply bounded file changes

hash changed while worker ran
    -> apply nothing
    -> return conflict/escalation to Claude
```

If any write fails midway, the bridge restores its pre-apply snapshots.

This compare-and-swap behavior prevents a delayed worker result from overwriting developer/Claude edits made while the remote task was running.

## Repository authentication on Windows

The worker does not receive GitHub credentials from the Mac.

Windows must already be able to clone/fetch the relevant repositories through normal developer authentication, for example:

- Git Credential Manager for HTTPS;
- SSH key + agent;
- GitHub CLI-backed Git credential setup;
- company-specific GitHub Enterprise credentials.

Credentials remain on Windows and are not included in worker API payloads or telemetry.

## Worker authentication

Unlike raw Ollama LAN access used by v0.8 Phase 0, the execution worker will require a high-entropy pre-shared bearer token.

Controls:

- bind to a private interface only;
- Windows Firewall restricts the worker port to the Mac IP;
- bearer token required for every endpoint, including health;
- request/body size limits;
- optional Git host allowlist;
- no internet/router port forwarding;
- token is never written to repository files.

## Execution isolation

Each run gets a unique ID and worktree.

Worker state:

```text
%USERPROFILE%\.local-coder-mcp\worker\
  repos\         bare repository mirrors
  worktrees\     disposable run workspaces
  runs\          compact run metadata/artifacts
  indexes\       persistent repo indexes
  telemetry\     metadata-only telemetry
```

The worker will serialize model inference machine-wide and initially serialize heavy execution to avoid simultaneously running multiple TypeScript builds/tests and large-model generations on the workstation.

## Model policy

The remote protocol is model-agnostic.

The initial Windows deployment uses:

```text
qwen3.6:35b-a3b-coding
num_ctx=16384
parallel=1
max loaded models=1
```

The model is configuration, not part of the protocol contract. Future model upgrades do not require changing Claude's MCP tool workflow.

## Dependency/bootstrap policy

A disposable worktree needs dependencies before validation can run. The first implementation should support explicit worker bootstrap policies:

```text
none
  caller/repository guarantees validation does not need installed dependencies

auto
  detect lockfile/package manager and perform frozen/reproducible install

command
  administrator-configured worker bootstrap command; never supplied by the model
```

Longer term, repo-specific dependency caches/template worktrees can eliminate repeated installs.

## What stays on the Mac

Final remote mode keeps only low-cost control responsibilities:

- Claude reasoning/planning/review;
- MCP stdio connection expected by Claude Code;
- routing/sensitive-decision metadata;
- Git source-state snapshot/delta creation;
- remote request/response transport;
- conflict-safe application of returned file changes.

No local Ollama generation is required in `remote` mode.

## What moves to Windows

- local model weights/KV cache/inference;
- repository mirror/worktree I/O;
- context index/capsule generation;
- bounded edits and retries;
- lint/test/typecheck/build;
- remote run artifacts;
- execution telemetry.

## Modes

Target configuration:

```text
LOCAL_CODER_EXECUTION_MODE=local
  current laptop behavior

LOCAL_CODER_EXECUTION_MODE=remote
  Windows worker required; never silently fall back to Mac inference

LOCAL_CODER_EXECUTION_MODE=auto
  prefer worker; optional explicit fallback policy
```

`remote` must fail clearly when the worker is unavailable. This prevents a network outage from unexpectedly loading a large model on the Mac.

## Delivery phases

### Phase 0 — remote inference

Implemented first because it provides immediate thermal relief with minimal moving parts.

- Ollama/model on Windows;
- restricted LAN firewall rule;
- Mac MCP points `OLLAMA_BASE_URL` at Windows;
- model inference leaves the Mac.

### Phase 1 — worker API and authentication

- health/version negotiation;
- bearer auth;
- task/plan endpoints;
- request limits/queue;
- worker installer/startup.

### Phase 2 — Git workspace reconstruction

- repository mirror;
- base SHA verification;
- dirty tracked patch;
- untracked file transport;
- editable-file hash preconditions;
- disposable worktrees.

### Phase 3 — remote execution integration

- existing executor/orchestrator run on Windows;
- validation/build run on Windows;
- bounded file changes returned and conflict-safely applied on Mac;
- compact/full run semantics preserved.

### Phase 4 — index/artifact migration

- context index generated/stored on worker;
- run store/telemetry moved to worker;
- lazy `get_local_run` fetches remote artifacts.

### Phase 5 — reliability

- cancellation propagation;
- stale run/worktree cleanup;
- restart recovery;
- dependency caches;
- token rotation;
- optional Tailscale/private-overlay support for off-LAN use.

## Acceptance criteria

The remote execution milestone is complete when:

- Claude sees the same preferred MCP tool names/contracts;
- dirty tracked and relevant untracked Mac state can be reconstructed remotely;
- tests/build execute on Windows;
- Mac does not run local model inference in remote mode;
- returned changes cannot overwrite files modified after the run started;
- failed/rolled-back remote runs leave the Mac unchanged;
- supervised-sensitive runs preserve mandatory full-diff Claude review;
- worker unavailable/conflict/cancellation are explicit states, not silent local fallback;
- two Claude sessions cannot concurrently overload the worker or corrupt the same source state.
