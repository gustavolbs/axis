# AgentRuntime Product Composition

Status: canonical desktop Chat/Cowork composition for Axis 0.23.0.

This document records the product boundary introduced by CHAT I after the provider-neutral runtime, tools, provider adapters, Project Memory and Runtime UI workstreams were merged, plus the runtime security/policy boundary introduced by CHAT J.

See also `docs/RUNTIME_SECURITY_POLICIES.md` for the complete authority, policy, network, redaction, audit and Effective Context contract.

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
          ┌───────────┼──────────────┐
          │           │              │
          v           v              v
   RuntimePolicy   Effective      AgentRuntime
      Engine        Context           │
          │                           │
          └──── permission gate ──────┤
                                      │
                           ┌──────────┼────────────┐
                           │          │            │
                    exact provider  Axis tools   lifecycle
                       adapter          │            │
                                        │            ├─> redaction
                                        │            ├─> Runtime UI
                                        │            ├─> security audit
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

CHAT J adds a second immutable input to authorization: Company/Project runtime policy. Tool, browser, repository, MCP and provider content cannot mutate either the frozen session authority or the trusted policy source during execution.

## Exact provider resolution

Authentication changes only the provider adapter at the boundary. It does not select another runtime.

Supported canonical adapters are the adapters present on `main`:

- Ollama/local;
- OpenAI API Key;
- Anthropic API Key;
- Claude Account;
- future safe adapters using the same contract.

ChatGPT/Codex Account remains intentionally fail-closed under the accepted G2 blocker. Codex app-server v2 can expose client dynamic tools but does not yet provide a proven exact model-visible tool allowlist/dynamic-tools-only mode. Axis therefore does not fall back to another Connection, API key, Account, model or Company.

### `auto` is resolved before the session freezes

`AgentRuntime` itself never receives an `auto` Connection/model selection. Product composition resolves it first and then freezes the exact result into `AgentSessionContext`.

For a Project:

1. every Connection eligible for the requested Chat/Cowork scope is first checked against the canonical Company graph;
2. Chat resolves the Project Chat selection using the existing Project connection/model policy;
3. Cowork resolves an implementation-stage candidate through the existing Project routing catalog and routing policy;
4. the selected Connection/model becomes immutable session authority;
5. no later model/provider/Company/execution-target fallback occurs inside `AgentRuntime`.

This preflight matters because provider catalog discovery can touch credentials or Account transports. A foreign allowed Connection is rejected by the Company graph before routing/provider resolution starts.

Projectless Personal Chat has no Project policy from which to resolve `auto`, so it must arrive with an exact selected Connection and model.

## Runtime security and policy gate

Every canonical tool call now crosses `RuntimePolicyPermissionGate` before execution.

The gate combines:

- the existing static capability/permission checks;
- Company policy;
- Project policy;
- an optional trusted session override;
- one-shot Runtime UI approval when the effective decision is `ask`.

Authority composition is monotonic. Company/Project/session scopes can make an operation stricter but cannot widen a parent deny. `deny` wins over `ask` and `allow`, and user approval can satisfy `ask` only; it cannot override `deny`.

The normalized modes are `plan`, `ask-before`, `workspace-write`, `auto` and explicit `full-access`.

Approval identity is captured from the raw permission request before lifecycle redaction and is bound to session, Company, tool and argument fingerprint. It is consumed once.

## Tool composition

The product registers tools from the merged provider-neutral tool suites and then lets `AgentRuntime` expose only tools whose required capabilities are effective for the immutable session.

### Filesystem

Cowork can receive the P1.2 filesystem catalog, including reads/search/stat and create/write/edit/patch/operations. Chat can receive read/validation tools when it has a Project/root. Projectless Chat has no filesystem authority.

Runtime policy can further allow, ask or deny filesystem operations. Tool-local exact-root, symlink and traversal checks remain defense in depth.

### Process

Cowork can receive `process_exec`, background process lifecycle controls and `process_which` when a write-capable workspace root exists. Chat does not receive command/mutation tools merely because it uses the same runtime.

Runtime policy can match the canonical command descriptor, for example `npm test`, `npm run lint`, `npm install` or `rm *`. Ambient process credentials are still filtered by the process environment boundary before spawn.

### Git

Cowork can receive the merged Git/status/diff/branch/stage/worktree tools. Git still validates the exact authorized root and repository identity itself.

Destructive Git operations remain subject to the common destructive-policy classification in addition to Git's own root/worktree safety checks.

### Browser

The built-in product fallback is the provider-neutral fetch backend, which exposes only its actually implemented read surface: navigate, read, state and static inspect. No unsupported interaction/screenshot/developer tool is announced by that backend.

Browser navigation now delegates host classification/authorization to the shared runtime network boundary. Private/link-local/metadata targets and credential-bearing URLs are rejected unless the relevant local/private capability is explicitly configured, and redirect destinations are re-authorized.

### MCP

When an Axis `McpHost` is bound, product composition first creates session resource bindings and then asks the host for tools visible to that exact Company/Project resource set. MCP authority is revalidated inside the host against Company, Project and source Connection ownership.

MCP discovery does not execute through the inference provider. Provider/account MCP configuration is provenance/configuration input only; actual canonical tool execution belongs to Axis MCP Host.

Native Streamable HTTP/SSE MCP transport now uses the same outbound network boundary as browser/provider/worker clients. A server-provided legacy SSE message endpoint is re-authorized and must remain on the configured origin.

The desktop constructor does **not** silently import provider-owned Claude/Codex MCP OAuth sessions into a native `McpHost`. Those account connectors can remain visible/configurable through their provider-owned flows, but they are not advertised as native Axis MCP tools unless a safe Axis host binding is explicitly composed. This preserves the rule that provider-managed MCP execution cannot bypass canonical permission/lifecycle handling.

### Future tools

Additional tools enter through the same `AxisTool` contract. New providers do not get provider-specific filesystem/process/Git implementations and external clients should reuse the shared network/redaction boundaries rather than implementing parallel security rules.

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
| MCP reads | when an Axis MCP host/resource is bound | when an Axis MCP host/resource is bound |
| MCP mutation | policy/approval-gated when bound | policy/approval-gated when bound |
| Project Memory | same Project/root ownership | same Project/root ownership |
| Runtime policy | Company/Project-aware | Company/Project-aware |

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

The canonical `AgentRuntime` performs permission authorization before invoking a tool. If the effective static/runtime policy returns `requiresApproval`, runtime emits permission/decision lifecycle events and pauses before the tool target is called.

The compatibility shell translates the current product picker response into `AgentDecisionResolution`. For a permission pause, product composition remembers:

- request ID;
- exact session and Company;
- exact tool name;
- SHA-256 fingerprint of canonical raw tool arguments.

The fingerprint is retained inside the trusted gate before UI-visible lifecycle redaction. Secrets therefore do not need to remain visible merely to bind approval correctly.

An approval applies to one matching re-issued tool call only. A denial produces a canonical permission error without executing the tool. A Company/Project `deny` remains a deny even if a user attempts to approve the operation.

Provider-originated clarification/confirmation decisions use the same pause/resume contract but do not gain security authority merely by being provider content.

## External content authority

The runtime system prompt explicitly classifies repository files, browser/web content, MCP results and tool output as untrusted data with respect to authority.

They cannot change Company, Project, Connection, model, execution target, roots, resources, permissions, MCP enablement, network policy or mutation approval. Trusted session policy overrides require the internal `trusted-session-config` provenance marker and are not built from tool/model content.

## Network clients

The product now has one reusable outbound URL policy plus redirect-safe fetch helper.

It is used by:

- browser navigation;
- provider HTTP;
- native MCP HTTP/SSE;
- Local Worker requests.

Cloud providers require public HTTPS. Ollama gets a deliberate loopback HTTP exception. Local Worker reachability is narrowed to the explicitly configured worker hostname. Cross-origin redirects strip sensitive request headers before the next hop.

## Secret redaction

Product lifecycle is redacted before fan-out to Runtime UI, Project Memory or audit consumers. The same transversal redactor handles structured secret fields, common token/key formats, private keys, auth headers, cookies, secret refs and credential-bearing URLs.

Project Memory reuses this runtime redaction implementation instead of maintaining a separate pattern list.

## Effective Context Inspector

`AgentProductRuntime` snapshots a canonical secret-free Effective Context for each composed session and exposes it through `effectiveRuntimeContext(sessionId)`.

The inspector is derived from the same frozen session and policy engine used for actual authorization. It includes:

- Company and Project;
- Connection/provider/auth kind/shared-local status;
- exact model;
- execution target;
- effective authority mode;
- roots and read/write access;
- MCP enabled/denied status;
- permission entries;
- scoped policy rules;
- invariant network protections.

It does not reconstruct authority from labels or UI state and never exposes secrets.

## Security audit

When a security audit sink is configured, Axis records policy decisions and security-sensitive lifecycle transitions with the exact effective session/Company/Project/Connection/model/target identity.

Audit payloads are redacted before delivery. Raw tool arguments are not retained merely for audit display.

## Cancellation

The persisted job controller is installed through the existing cancellation context. Product composition passes that signal to `AgentRuntime`, which propagates it to provider invocation and tool execution. Process, MCP and browser implementations receive the same canonical tool cancellation signal when present.

Cancellation never selects another execution target.

## Execution target

The current desktop composition registers only the selected desktop target. If a future Worker session selects `worker`, that target must be explicitly registered with matching capabilities. There is no desktop → worker or worker → desktop automatic fallback inside AgentRuntime.

Worker health/settings remain in the legacy execution runtime until the Worker receives its own canonical `AgentExecutionTarget` implementation. Worker HTTP transport already uses the shared network boundary.

## Project Memory

Project Memory is installed as a real `AgentLifecycleSink`. Before a Project session starts, `loadProjectMemoryContext` retrieves context/handoff using the existing ownership contract:

`Company + Project + repository/root identity`.

Provider family, model, Account, API key and conversation are provenance only. They are not memory ownership keys.

Lifecycle persistence stores structured, redacted events and never raw chain-of-thought or unredacted tool arguments.

## Runtime UI

The desktop snapshot carries the bounded canonical lifecycle for the active product session. `AgentRuntimeTimeline` can render provider progress, reads, mutations, commands, validations, tool progress, errors, cancellation, pause/completion and permission/decision requests from the real runtime rather than fixture-only data.

CHAT J additionally provides the Effective Context representation for an inspector surface. The representation comes from product runtime authority rather than renderer inference and is safe to expose because credential values are excluded/redacted.

The existing job decision endpoint is temporarily retained as the transport for approvals while the backend converts its selection to `AgentDecisionResolution`. Removing that compatibility transport is a later cleanup; it must not reintroduce a second execution engine or permit approvals to escape their session/Company/tool/argument binding.

## Validation matrix

Product-composition coverage is intentionally above the feature-specific tool/runtime suites:

- `test/agent-product-runtime.test.ts` proves a real Cowork search → read → edit → failing process validation → repair → passing validation → Git diff loop, Project Memory capture, Chat/Cowork authority differences, approval pause/resume, cancellation, shared Ollama scope, concurrent multi-Company/multi-provider execution, and cross-scope refusal;
- `test/agent-product-auto-selection.test.ts` proves Project `auto` resolves to one exact Cowork Connection/model before session freeze and rejects a foreign candidate before provider catalog resolution;
- `test/runtime-security-policies.test.ts` pins Company policy isolation, monotonic overrides, deny-wins, session/Company-bound approvals, redirect/metadata protection, cross-Company MCP refusal, browser/private-network protection, process secret filtering, transversal redaction, external-content non-authority, Effective Context equivalence, shared-local Connection isolation and destructive authority;
- provider-adapter, filesystem, process, Git, MCP, browser, Project Memory and runtime-UI suites continue to prove their own provider-neutral contracts independently;
- repository CI runs release metadata validation, full TypeScript/app build, the complete test suite, macOS desktop contract/visual/package checks and Windows full build/test coverage.

## Legacy-removal plan

The compatibility sequence is explicit:

1. keep `StandaloneJobManager` only for durable conversation state/API compatibility;
2. move remaining snapshot/decision transport concepts to canonical session/turn storage;
3. expose the Effective Context inspector through the final renderer transport without reconstructing authority client-side;
4. remove the legacy engineer-specific result projection once the UI consumes canonical AgentRuntime output directly;
5. delete unused Chat/Cowork dispatch through `ProjectEngineerBackend` / `ProjectRoutedChatClient` / premium-agent;
6. implement Worker as an explicit canonical execution target rather than reusing auto-fallback execution runtime behavior.

Until those cleanups land, tests must prove desktop Chat/Cowork reach `AgentRuntime` and do not silently invoke a second engine for the same operation.
