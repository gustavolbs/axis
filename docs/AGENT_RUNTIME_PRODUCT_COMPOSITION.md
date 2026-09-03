# AgentRuntime Product Composition

Status: canonical desktop Chat/Cowork composition for Axis 0.22.0.

This document records the product boundary introduced by CHAT I after the provider-neutral runtime, tools, provider adapters, Project Memory and Runtime UI workstreams were merged.

## Canonical product path

```text
Chat ──────┐
           ├─> persisted conversation/API shell
Cowork ────┘          │
                      v
             AgentProductExecutionBridge
                      │
                      v
               AgentProductRuntime
                      │
                      v
                 AgentRuntime
          ┌───────────┼────────────┐
          │           │            │
   exact provider   Axis tools   lifecycle
      adapter          │            │
                       │            ├─> Runtime UI
                       │            └─> Project Memory
                       │
          ┌────────────┼───────────────┐
          │            │               │
       filesystem    process           Git
          │            │               │
          └──── MCP / browser / future tools
```

`AgentRuntime` is the only Chat/Cowork execution engine in desktop product composition. `StandaloneJobManager` remains temporarily because it owns durable conversation state, the existing `/jobs` API and follow-up/retry semantics. It is a compatibility shell, not a second agent engine.

`execution-runtime.ts`, `ProjectEngineerBackend`, `ProjectRoutedChatClient`, `premium-agent` and the older planning/execution pipeline remain available for unrelated compatibility surfaces while they are removed incrementally. The desktop `/jobs` Chat/Cowork path does not silently choose them when AgentRuntime is selected.

## Immutable session authority

Before the first provider call, `AgentProductRuntime` resolves one immutable `AgentSessionContext` containing:

- canonical `companyId`;
- optional exact Project;
- exact Connection;
- provider family;
- `authKind`;
- exact model;
- exact execution target;
- roots;
- resource bindings;
- permissions;
- effective capabilities.

Company identity is resolved from `CompanyContextSnapshot`. Workspace paths, account/provider labels, provider family, API-key identity and legacy organization metadata do not select Company.

The runtime fails closed if the exact Project/Connection is absent from the canonical Company graph or belongs to another Company. Shared local connections remain session-scoped and have `connection.companyId = null`; they do not transfer Company authority.

## Exact provider resolution

Authentication changes only the provider adapter at the boundary. It does not select another runtime.

Supported canonical adapters are the adapters present on `main`:

- Ollama/local;
- OpenAI API Key;
- Anthropic API Key;
- Claude Account;
- future safe adapters using the same contract.

ChatGPT/Codex Account remains intentionally fail-closed under the accepted G2 blocker. Codex app-server v2 can expose client dynamic tools but does not yet provide a proven exact model-visible tool allowlist/dynamic-tools-only mode. Axis therefore does not fall back to another Connection, API key, Account, model or Company.

A session must reach composition with an exact Connection and model. `auto` is a product-selection concern before AgentRuntime authority is frozen; AgentRuntime composition does not silently reroute after that point.

## Tool composition

The product registers tools from the merged provider-neutral tool suites and then lets `AgentRuntime` expose only tools whose required capabilities are effective for the immutable session.

### Filesystem

Cowork can receive the P1.2 filesystem catalog, including reads/search/stat and create/write/edit/patch/operations. Chat can receive read/validation tools when it has a Project/root. Projectless Chat has no filesystem authority.

### Process

Cowork can receive `process_exec`, background process lifecycle controls and `process_which` when a write-capable workspace root exists. Chat does not receive command/mutation tools merely because it uses the same runtime.

### Git

Cowork can receive the merged Git/status/diff/branch/stage/worktree tools. Git still validates the exact authorized root and repository identity itself.

### Browser

The built-in product fallback is the provider-neutral fetch backend, which exposes only its actually implemented read surface: navigate, read, state and static inspect. No unsupported interaction/screenshot/developer tool is announced by that backend.

### MCP

When an Axis `McpHost` is bound, product composition first creates session resource bindings and then asks the host for tools visible to that exact Company/Project resource set. MCP authority is revalidated inside the host against Company, Project and source Connection ownership.

MCP discovery does not execute through the inference provider. Provider/account MCP configuration is provenance/configuration input only; actual tool execution belongs to Axis MCP Host.

### Future tools

Additional tools enter through the same `AxisTool` contract. New providers do not get provider-specific filesystem/process/Git implementations.

## Chat versus Cowork

Chat and Cowork differ by authority, not engine.

| Concern | Chat | Cowork |
| --- | --- | --- |
| Engine | `AgentRuntime` | `AgentRuntime` |
| Project root | read-only when present | write-capable |
| Read/search tools | allowed when scoped | allowed |
| Mutation tools | not exposed by default | exposed when scoped |
| Process/Git mutation | not exposed by default | exposed when scoped |
| Browser reads | may be exposed | may be exposed |
| MCP reads | may be exposed | may be exposed |
| MCP mutation | approval-gated | approval-gated |
| Project Memory | same Project/root ownership | same Project/root ownership |

Cowork therefore supports the dynamic sequence expected from a real coding agent:

```text
search
→ read
→ reason
→ search
→ edit
→ run test
→ inspect failure
→ edit
→ validate
→ git diff
→ complete
```

No editable-file list is required before repository exploration.

## Permission and decision pause/resume

The canonical `AgentRuntime` performs permission authorization before invoking a tool. If static policy returns `requiresApproval`, runtime emits permission/decision lifecycle events and pauses before the tool target is called.

The compatibility shell translates the current product picker response into `AgentDecisionResolution`. For a permission pause, product composition remembers:

- request ID;
- exact tool name;
- SHA-256 fingerprint of canonical tool arguments.

An approval applies to one matching re-issued tool call only. A denial produces a canonical permission error without executing the tool. This preserves the audit trail and prevents a pending local mutation from being duplicated by a broad resume token.

Provider-originated clarification/confirmation decisions use the same pause/resume contract.

## Cancellation

The persisted job controller is installed through the existing cancellation context. Product composition passes that signal to `AgentRuntime`, which propagates it to provider invocation and tool execution. Process, MCP and browser implementations receive the same canonical tool cancellation signal.

Cancellation never selects another execution target.

## Execution target

The 0.22.0 desktop composition registers only the selected desktop target. If a future Worker session selects `worker`, that target must be explicitly registered with matching capabilities. There is no desktop → worker or worker → desktop automatic fallback inside AgentRuntime.

Worker health/settings remain in the legacy execution runtime until the Worker receives its own canonical `AgentExecutionTarget` implementation.

## Project Memory

Project Memory is installed as a real `AgentLifecycleSink`. Before a Project session starts, `loadProjectMemoryContext` retrieves context/handoff using the existing ownership contract:

`Company + Project + repository/root identity`.

Provider family, model, Account, API key and conversation are provenance only. They are not memory ownership keys.

Lifecycle persistence stores structured, redacted events and never raw chain-of-thought.

## Runtime UI

The desktop snapshot now carries the bounded canonical lifecycle for the active product session. `AgentRuntimeTimeline` can render provider progress, reads, mutations, commands, validations, tool progress, errors, cancellation, pause/completion and permission/decision requests from the real runtime rather than fixture-only data.

The existing job decision endpoint is temporarily retained as the transport for approvals while the backend converts its selection to `AgentDecisionResolution`. Removing that compatibility transport is a later cleanup; it must not reintroduce a second execution engine.

## Legacy-removal plan

The compatibility sequence is explicit:

1. keep `StandaloneJobManager` only for durable conversation state/API compatibility;
2. move remaining snapshot/decision transport concepts to canonical session/turn storage;
3. remove the legacy engineer-specific result projection once the UI consumes canonical AgentRuntime output directly;
4. delete unused Chat/Cowork dispatch through `ProjectEngineerBackend` / `ProjectRoutedChatClient` / premium-agent;
5. implement Worker as an explicit canonical execution target rather than reusing auto-fallback execution runtime behavior.

Until those cleanups land, tests must prove desktop Chat/Cowork reach `AgentRuntime` and do not silently invoke a second engine for the same operation.
