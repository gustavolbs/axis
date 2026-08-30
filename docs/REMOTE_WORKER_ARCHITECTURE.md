# v0.8 Remote Execution Worker architecture

## Goal

Make the Mac the **control plane** and the Windows workstation the **execution plane** without mounting the live Mac repository over SMB/SSHFS.

```text
Mac control plane
Claude Code
  -> thin local-coder MCP bridge
      -> authenticated LAN request
          -> Windows execution worker
              -> repository mirror/cache
              -> disposable worktree
              -> reconstructed Mac workspace state
              -> local model
              -> edits + retries
              -> lint/tests/typecheck/build
              -> bounded changed-file payloads
      <- execution result + changes
  -> compare-and-swap source-state verification
  -> apply changes locally
  -> Claude review
```

## v0.8 implementation status

Implemented in this release:

- `LOCAL_CODER_EXECUTION_MODE=local|remote|auto`;
- authenticated HTTP worker protocol version 1;
- strict remote mode with no silent Mac inference fallback;
- Windows repository mirror/cache;
- disposable worktree per run;
- tracked dirty-patch transport;
- safe untracked-file transport;
- editable-file SHA-256 preconditions;
- existing task executor on Windows;
- existing plan/orchestrator on Windows;
- validation/retry/build execution on Windows;
- bounded changed-file return;
- conflict-safe/rollback-safe apply on the Mac;
- Windows Firewall/setup/startup scripts.

Still intentionally control-plane-local in the first v0.8 cut:

- `prepare_local_context` index/capsule generation;
- compact run store used by `get_local_run`;
- aggregate control-plane telemetry.

Those components are much lighter than model inference/builds and are candidates for the next migration phase.

## Why not edit the Mac filesystem over a network share

Direct SMB/SSHFS editing would add avoidable failure modes:

- Windows and macOS filesystem semantics differ;
- package-manager/native dependencies can be platform-specific;
- Node build/watch tools can behave differently over network filesystems;
- locking becomes less predictable;
- a network interruption can occur during a live write;
- tests/builds would still exercise the Mac's live workspace/I/O.

Instead, the worker reconstructs the invocation source state locally and returns task-produced changes.

## Workspace identity

Each remote run is tied to:

```text
origin repository URL
+ base commit SHA
+ workspace-relative root
+ tracked dirty binary patch
+ safe untracked files
+ expected SHA-256 hashes for editable files
```

This preserves dirty working-tree state without requiring a commit before delegation.

Sensitive paths already blocked by the local-coder workspace policy are not transported, including real `.env*` secret files, `.ssh`, `.git`, and `node_modules`.

## Protocol v1

Every endpoint requires:

```text
Authorization: Bearer <worker-token>
```

The worker rejects a mismatched protocol version.

### Health

```text
GET /v1/health
```

Reports worker/protocol version, Windows hostname/platform, configured model, bootstrap policy, and Ollama health.

### Read-only model generation

```text
POST /v1/chat
```

Used by `delegate_code_task` in remote mode so even read-only model generation stays off the Mac.

### Execute bounded task

```text
POST /v1/execute-task
Content-Type: application/json
```

Conceptual request:

```json
{
  "protocolVersion": 1,
  "workspace": {
    "repositoryUrl": "git@github.com:org/repo.git",
    "baseSha": "...",
    "workspaceRelativePath": "...",
    "dirtyPatchBase64": "...",
    "untrackedFiles": [],
    "expectedFiles": []
  },
  "input": {
    "task": "...",
    "editableFiles": [],
    "contextFiles": [],
    "validation": []
  }
}
```

### Execute Claude-planned task graph

```text
POST /v1/execute-plan
```

The same workspace snapshot is reconstructed once; the existing transactional plan executor runs in that worktree.

## Worker run lifecycle

For a task or plan the worker:

1. validates authentication/protocol/body limits;
2. checks the repository host allowlist when configured;
3. clones a bare mirror or fetches/prunes an existing mirror;
4. checks out the exact requested base SHA into a unique detached worktree;
5. applies the binary tracked delta;
6. restores safe untracked files;
7. verifies expected editable-file hashes;
8. bootstraps dependencies according to worker policy;
9. executes the bounded executor/orchestrator using local Windows Ollama;
10. runs requested validation/retries on Windows;
11. returns only changed editable files plus the normal execution result;
12. removes/prunes the disposable worktree in `finally`.

Heavy worker execution is serialized initially to avoid concurrent large model/build workloads on the workstation.

## Mac apply lifecycle

The worker never writes directly to the Mac.

Before applying a response, the bridge snapshots all target files and verifies every current hash against the precondition captured at invocation start.

```text
all hashes still match
    -> apply bounded changed files

any hash changed
    -> apply nothing
    -> report conflict
```

If a local write fails after apply begins, all target files are restored to their pre-apply snapshots.

This prevents a delayed remote result from overwriting developer/Claude edits made while Windows was working.

## Repository authentication on Windows

The worker does not receive GitHub credentials from the Mac.

Windows must already be able to clone/fetch the origin URL through normal developer authentication, e.g.:

- Git Credential Manager for HTTPS;
- SSH key + agent;
- GitHub CLI-backed Git credentials;
- company-specific GitHub Enterprise credentials.

Credentials stay on Windows and are never included in worker requests/telemetry.

## Worker authentication / network boundary

Worker mode uses a high-entropy pre-shared bearer token plus host firewall restriction.

The provided Windows setup does the following:

- worker listens on TCP `7337`;
- Windows Firewall allows only the supplied Mac IP on `Private` profiles;
- every endpoint, including health, requires the token;
- request bodies have a size limit;
- repository Git hosts can be allowlisted;
- Ollama remains on Windows loopback (`127.0.0.1:11434`);
- no router port forwarding is required or recommended.

The worker currently uses HTTP on the trusted LAN. Do not expose it to an untrusted/public network. A private overlay/TLS transport is a future hardening option.

## Worker state

Default root:

```text
%USERPROFILE%\.local-coder-mcp\worker\
```

Current worker uses:

```text
repos\       bare Git mirrors
worktrees\   disposable run workspaces
```

Future worker-side index/run artifact migration can add:

```text
indexes\
runs\
telemetry\
```

## Model policy

The protocol is model-agnostic.

The provided Windows installer currently selects:

```text
qwen3.6:35b-a3b-coding
num_ctx=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
```

Model selection is configuration, not protocol state.

## Dependency/bootstrap policy

Worker bootstrap modes:

```text
none
  do not install dependencies before execution

auto
  detect root package-manager lockfile and install dependencies on Windows
```

`auto` currently maps:

```text
pnpm-lock.yaml     -> pnpm install --frozen-lockfile
yarn.lock          -> yarn install --frozen-lockfile
bun.lock/bun.lockb -> bun install --frozen-lockfile
package-lock.json  -> npm ci
package.json only  -> npm install
```

Bootstrap commands are host policy; the model cannot invent an arbitrary bootstrap shell command.

## Execution modes

```text
LOCAL_CODER_EXECUTION_MODE=local
  existing laptop behavior

LOCAL_CODER_EXECUTION_MODE=remote
  Windows worker required; never silently fall back to Mac inference

LOCAL_CODER_EXECUTION_MODE=auto
  prefer worker; local fallback only when the worker is classified unavailable
```

For the dedicated Windows-workstation topology, `remote` is recommended so a network outage cannot unexpectedly load Qwen on the Mac.

## What stays on the Mac in current v0.8

- Claude reasoning/planning/review;
- stdio MCP process expected by Claude Code;
- routing/sensitive-decision metadata;
- Git source-state snapshot/delta creation;
- authenticated worker transport;
- conflict-safe application of returned file changes;
- context-capsule index (for now);
- compact run store/aggregate telemetry (for now).

## What moves to Windows in current v0.8

- model weights/KV cache/inference;
- repo mirror/worktree I/O;
- bounded edits/retries;
- task/final validation;
- lint/test/typecheck/build initiated by the execution plan;
- dependency bootstrap for disposable worktrees.

## Next reliability work

Planned follow-ups:

- move context index/run artifacts fully to worker;
- cancellation propagation and active-run status;
- stale mirror/worktree/cache retention policy;
- dependency cache/template worktrees;
- worker token rotation helper;
- optional Tailscale/private-overlay + TLS for off-LAN use.

## Acceptance criteria for this v0.8 cut

- same preferred MCP tool names/contracts from Claude's perspective;
- dirty tracked and safe untracked Mac state can be reconstructed remotely;
- task/plan validation executes on Windows;
- remote mode performs no local Ollama generation on the Mac;
- returned files cannot overwrite source modified after run start;
- failed/rolled-back remote runs do not apply worker changes to the Mac;
- `local-supervised` still forces mandatory full-diff Claude review;
- worker unavailability/conflict is explicit in strict remote mode;
- worker serializes heavy execution to avoid concurrent workstation overload.
