# Parallel Development Handoff

Date: 2026-09-03

This document marks the **Parallel Development Ready Gate** for the shared agent-runtime architecture introduced after PR #75.

It freezes the central extension boundary needed for multiple branches to build tools, execution targets, lifecycle consumers and provider adapters without redefining the core protocol. It does **not** claim that the remaining P1.1–P1.6 product surfaces are finished or already wired through Chat/Cowork. Those integrations are intentionally left to the parallel workstreams below.

## Gate status

The central architecture now provides:

1. a provider-agnostic `AgentRuntime` loop for `model → tool call → Axis execution → tool result → model`;
2. canonical tool definition/call/result/error contracts;
3. exact, immutable `AgentSessionContext` scope for Company, Project, connection, model, execution target, roots, permissions, capabilities and resources;
4. explicit capability negotiation with fail-closed unavailable capabilities;
5. a provider adapter boundary with no auth-kind branching in the runtime;
6. a compatibility `InferenceProviderAgentAdapter` usable by existing Account and API-key `InferenceProvider` connections through the same runtime;
7. an execution-target registry that resolves the exact selected target and never falls back silently;
8. a replaceable permission gate;
9. central cancellation, timeout, progress, error, retry-eligibility and mutation-status semantics;
10. provider-independent lifecycle events sufficient for future Project Memory/tracing consumers; and
11. architecture tests for provider/auth/tool independence, Company isolation, capability negotiation, lifecycle, cancellation, mutation safety and no-fallback selection.

The user-facing filesystem, shell/process, Git/worktree, Project Memory, MCP, browser and UI implementations remain intentionally incomplete.

---

## Frozen contracts

Future parallel branches should treat the following exports from `src/agent-runtime/index.ts` as stable unless a coordinated architecture change is explicitly approved.

### Session and authority

- `AgentSessionContext`
- `AgentConnectionContext`
- `AgentProjectContext`
- `AgentExecutionTargetContext`
- `AgentRoot`
- `AgentResourceBinding`
- `AgentPermissionSet`
- `EffectiveCapabilitySet`
- `assertAgentSessionContext()`
- `freezeAgentSessionContext()`

Important invariant: a session is constructed before execution and is immutable thereafter. Runtime code must not look up an ambient active Company, alternate Project, alternate connection, alternate model, broader root or different execution target while a turn is running.

`connection.companyId === null` is reserved for intentionally shared local capabilities. Every Company-owned connection/root/resource must match `session.companyId`. Project-owned roots/resources must also match `session.project.id`.

### Tool protocol

- `ToolDefinition`
- `ToolCall`
- `ToolResult`
- `ToolError`
- `ToolProgress`
- `ToolActivity`
- `AxisTool`
- `ToolExecutionContext`
- `ToolExecutionOutput`
- `ToolRegistry`

A tool owns input validation and implementation. It does not parse Claude/OpenAI/Ollama/Codex protocols and does not select a provider.

Every tool declares:

- `requiredCapabilities`;
- `requiredPermissions`;
- semantic `effect` (`read`, `mutation`, `command`, `validation`, `external`);
- `mutationRisk`;
- retry policy; and
- optional timeout.

Potentially mutating operations that fail without proving rollback/commit are represented as `mutationStatus: unknown`. The runtime will not label them automatically safe to retry.

### Provider protocol

- `AgentProviderAdapter`
- `AgentProviderRequest`
- `AgentProviderResponse`
- `AgentProviderControl`
- `AgentProviderAdapterCapabilities`
- `InferenceProviderAgentAdapter`

An adapter is constructed for **one exact already-resolved connection + model**. The runtime verifies those identities against the session context before invoking it.

`authKind` is session provenance. It is not part of the adapter dispatch contract. Claude Account, ChatGPT/Codex Account, API Key and local/provider connections therefore use the same agent-runtime architecture.

Existing `InferenceProvider` implementations can participate through `InferenceProviderAgentAdapter`, which uses the common structured-output contract as a safe compatibility tool loop. Provider-specific native tool-calling adapters may replace that bridge later without changing tools or `AgentRuntime`.

### Capability protocol

- `CapabilityOffer`
- `CapabilityRestriction`
- `CapabilityNegotiationInput`
- `negotiateEffectiveCapabilities()`
- `capabilityUnavailableReason()`

Capability IDs are strings, not a central provider enum. A new feature should introduce a namespaced capability ID in its own module and require it from the relevant tool. Session composition supplies offers from native Axis features, the selected provider/model/resources and the exact execution target, then applies Company/Project/session/admin restrictions.

Recommended namespace examples:

- `axis.filesystem.read`
- `axis.filesystem.write`
- `axis.process.exec`
- `axis.git.read`
- `axis.git.mutate`
- `axis.mcp.invoke`
- `axis.browser.navigate`
- `target.workspace.read`
- `target.workspace.write`

No new capability should require adding a provider-specific branch to `AgentRuntime`.

### Permission boundary

- `ToolPermissionGate`
- `ToolPermissionRequest`
- `ToolPermissionDecision`
- `StaticToolPermissionGate`

A future approval UI or policy service replaces the gate implementation; tools and provider adapters remain unchanged.

### Execution-target boundary

- `AgentExecutionTarget`
- `LocalAgentExecutionTarget`
- `ExecutionTargetRegistry`

A target receives the canonical `AxisTool`, `ToolCall` and immutable `ToolExecutionContext`. The local target invokes the tool directly. A future Local Worker target may serialize the same canonical call to the worker.

The registry resolves only `session.executionTarget.id`. A missing target is an explicit failure, never a local/remote fallback decision.

### Lifecycle protocol

- `AgentLifecycleEvent`
- `AgentLifecycleSink`

Canonical lifecycle includes:

- `session.started` / `session.completed`;
- `turn.started` / `turn.completed`;
- `user.input`;
- `provider.started` / `provider.progress` / `provider.completed`;
- `permission.requested` / `permission.resolved`;
- `tool.call` / `tool.progress` / `tool.result`;
- `read`;
- `mutation`;
- `command`;
- `validation`;
- `error`; and
- `cancelled`.

Project Memory/tracing must consume these events instead of instrumenting Claude, Codex, OpenAI API, Anthropic API or Ollama separately.

Lifecycle sinks are observers. A sink failure is isolated from the active operation so persistence/tracing cannot cause a completed provider or mutating tool call to be retried accidentally.

---

## Central files

The following files are central contracts. Parallel feature branches should not modify them without coordination:

### New runtime boundary

- `src/agent-runtime/contracts.ts`
- `src/agent-runtime/capabilities.ts`
- `src/agent-runtime/tools.ts`
- `src/agent-runtime/provider-adapter.ts`
- `src/agent-runtime/runtime.ts`
- `src/agent-runtime/index.ts`

### Existing Company/provider foundation from PR #75 and earlier

- `src/company-context.ts`
- `src/company-connection-ownership.ts`
- `src/project-store.ts`
- `src/provider-connections.ts`
- `src/project-provider-runtime.ts`
- `src/providers/types.ts`
- `src/cancellation.ts`

### Existing legacy/product wiring

The following are integration-sensitive rather than extension contracts. Avoid broad parallel rewrites of them:

- `src/execution-runtime.ts`
- `src/project-engineer-backend.ts`
- `src/project-routed-chat.ts`
- `src/app-runtime.ts`

Parallel branches should implement modules behind the frozen contracts first. A later integration pass can wire completed modules into Chat/Cowork without forcing each feature branch to edit the same composition files.

`package.json` and `CHANGELOG.md` remain required release metadata and may require a small rebase-time conflict resolution when several PRs are merged sequentially. This is expected release bookkeeping, not a runtime-contract dependency.

---

## Extension points

### Create a new tool

1. Create a module outside `src/agent-runtime/`, preferably under `src/agent-tools/<area>/`.
2. Export an object/class implementing `AxisTool`.
3. Define its `ToolDefinition` with JSON Schema input, capability/permission requirements, effect, mutation risk and retry policy.
4. Validate arguments inside the tool.
5. Use only `ToolExecutionContext.session` for Company/Project/connection/root/resource scope.
6. Respect `ToolExecutionContext.signal`.
7. Report long-running work through `reportProgress()`.
8. Report concrete reads/mutations/commands/validations through `reportActivity()` when richer lifecycle metadata is available.
9. Return `mutationStatus` explicitly for potentially mutating work.
10. Register the tool in a `ToolRegistry` at composition time. Do not modify `AgentRuntime` or provider adapters.

### Create a new provider adapter

1. Implement `AgentProviderAdapter` outside `src/agent-runtime/`, preferably under `src/agent-provider-adapters/<provider>/`.
2. Construct it for one selected `connectionId`, `providerFamily` and `modelId`.
3. Translate canonical `AgentMessage[]` + `ToolDefinition[]` to the provider protocol.
4. Translate provider tool calls back to canonical `ToolCall[]`.
5. Translate provider streaming/progress into `AgentProgress`.
6. Honor the supplied `AbortSignal` and timeout.
7. Never select another connection, Company, model or execution target as fallback.
8. Do not import filesystem/shell/Git tool implementations.

If the existing provider already implements `InferenceProvider`, use `InferenceProviderAgentAdapter` until a native tool-calling adapter adds material value.

### Create a lifecycle consumer

1. Implement `AgentLifecycleSink` outside the runtime, for example under `src/project-memory/` or `src/tracing/`.
2. Consume `AgentLifecycleEvent` only.
3. Partition persisted state using the event/session Company + Project + repository/root identity required by `docs/PROJECT_MEMORY.md`.
4. Never infer Company from a provider account label or workspace path.
5. Keep the sink observational. Queue durable writes if persistence is asynchronous or expensive.
6. Do not instrument provider adapters separately for events already present in the common lifecycle.

### Create a capability

1. Pick a namespaced string ID owned by the feature module.
2. Add it to the relevant session capability offers during composition.
3. Add Company/Project/session/admin restrictions as `CapabilityRestriction` layers where required.
4. Put the ID in the tool's `requiredCapabilities`.
5. Add tests for both available and unavailable negotiation.
6. Do not add a provider switch statement to the runtime.

---

## Recommended parallel workstreams

### Chat A — Filesystem tools

- Suggested branch: `feat/runtime-filesystem-tools`
- Ownership: `src/agent-tools/filesystem/**`, focused tests under `test/agent-filesystem-*.test.ts`.
- Consumes: `AxisTool`, `ToolExecutionContext`, `AgentRoot`, capability/permission contracts.
- Do not modify: `src/agent-runtime/**`, provider adapters, Company/Project stores.
- Dependencies: none beyond this gate.
- Completion criteria:
  - scoped list/read/search/stat/write/edit primitives as intentionally chosen for P1.2;
  - path traversal/symlink/root enforcement;
  - cancellation/timeouts;
  - lifecycle read/mutation metadata;
  - explicit mutation status;
  - tests for read/write permissions and Company/Project root isolation.

### Chat B — Shell/process runtime

- Suggested branch: `feat/runtime-process-tools`
- Ownership: `src/agent-tools/process/**`, process-specific tests.
- Consumes: `AxisTool`, `ToolExecutionContext.signal`, command lifecycle, execution-target boundary.
- Do not modify: `src/agent-runtime/**`, provider adapters.
- Dependencies: none beyond this gate.
- Completion criteria:
  - `run_command`/process semantics chosen for P1.3;
  - stdout/stderr/progress and exit metadata;
  - cancellation/timeout/kill semantics;
  - cwd restricted to session roots;
  - command permission + mutation safety tests.

### Chat C — Git/worktrees/review

- Suggested branch: `feat/runtime-git-worktrees`
- Ownership: `src/agent-tools/git/**`, focused extensions to `src/project-git-review.ts` only when needed, Git tests.
- Consumes: canonical tool/lifecycle/session contracts; may reuse existing project Git review parsing.
- Do not modify: `src/agent-runtime/**`, provider adapters, Company/Project identity stores.
- Dependencies: none for read/review/worktree tool implementation. Optional reuse of Chat B helpers should be done only after that helper API lands; do not block the branch on it.
- Completion criteria:
  - Company/Project-root-scoped Git status/diff/worktree operations;
  - mutation permission boundaries;
  - review output compatible with existing review UI data;
  - lifecycle command/mutation/validation events;
  - no arbitrary renderer-supplied repository path.

### Chat D — Project Memory and structured handoff

- Suggested branch: `feat/runtime-project-memory`
- Ownership: `src/project-memory/**`, memory-specific tests; reuse existing repo-intelligence storage through an adapter rather than replacing it wholesale.
- Consumes: `AgentLifecycleEvent`, `AgentLifecycleSink`, immutable session scope.
- Do not modify: provider adapters, native tools, `src/agent-runtime/**`.
- Dependencies: none for the lifecycle consumer. Richer memories can benefit later from A/B/C event metadata.
- Completion criteria:
  - durable Company + Project + repository/root partitioning;
  - event-driven extraction of useful reads/mutations/commands/validations/errors/completion;
  - provider-independent handoff representation;
  - no provider/auth/session as memory owner;
  - cross-Company and cross-Project isolation tests.

### Chat E — MCP host/runtime tools

- Suggested branch: `feat/runtime-mcp-host`
- Ownership: `src/agent-tools/mcp/**` and MCP-specific adapter/tests; avoid rewriting existing `src/mcp-connectors.ts` unless required for a narrow bridge.
- Consumes: `AxisTool`, `ToolRegistry`, session resources/capabilities, permission boundary.
- Do not modify: `src/agent-runtime/**`, provider-specific adapters.
- Dependencies: none for MCP discovery/invocation as canonical Axis tools.
- Completion criteria:
  - session-scoped MCP catalog → `ToolDefinition` bridge;
  - connection/company/resource isolation;
  - explicit capability/permission failure;
  - MCP call/result lifecycle through the common runtime;
  - no provider-specific MCP instrumentation in Project Memory.

### Chat F — Browser tools

- Suggested branch: `feat/runtime-browser-tools`
- Ownership: `src/agent-tools/browser/**`, browser-specific tests.
- Consumes: tool, permission, target, cancellation, lifecycle contracts.
- Do not modify: `src/agent-runtime/**`, provider adapters.
- Dependencies: none for the initial browser tool contract/implementation.
- Completion criteria:
  - browser lifecycle scoped to the session;
  - navigation/read/action capabilities separated;
  - cancellation/timeout;
  - mutation/external-action permission semantics;
  - tool-level tests without provider dependencies.

### Chat G — Additional/native provider adapters

- Suggested branch: `feat/runtime-native-provider-adapters`
- Ownership: `src/agent-provider-adapters/**` and provider-adapter tests. Existing files under `src/providers/**` should be changed only when the provider wire protocol itself requires it.
- Consumes: `AgentProviderAdapter` and canonical messages/tools/progress.
- Do not modify: native tool implementations, `AgentRuntime`, Company/Project stores.
- Dependencies: none beyond this gate.
- Completion criteria:
  - native tool-call translation where supported;
  - structured fallback retained where native tool calling is unavailable/unreliable;
  - exact connection/model identity;
  - cancellation/progress/error mapping;
  - parity tests across Ollama, API-key and Account paths where practical.

### Chat H — UI panes and approvals

- Suggested branch: `feat/runtime-ui-panes`
- Ownership: `app/src/**` for panes/approval/progress/transcript presentation and UI tests.
- Consumes: serialized runtime lifecycle/result/permission concepts; existing Axis/Claude visual system.
- Do not modify: `src/agent-runtime/**` as part of visual work.
- Dependencies: can build UI states in parallel. Final live wiring depends on the selected backend composition/endpoints after tool/provider branches land.
- Completion criteria:
  - tool call/result/progress/error/cancellation presentation;
  - permission request/decision UX;
  - review/terminal panes only to the depth assigned to this branch;
  - required real-Electron visual verification from `AGENTS.md`.

---

## Conflict matrix

Legend: **Yes** = safe to develop concurrently from this gate; **Integrate** = implementation can proceed concurrently but final wiring/reuse should wait; **Sequence** = avoid simultaneous ownership of the same integration file.

| Workstream | A FS | B Process | C Git | D Memory | E MCP | F Browser | G Providers | H UI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A Filesystem | — | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| B Process | Yes | — | Yes | Yes | Yes | Yes | Yes | Yes |
| C Git | Yes | Yes | — | Yes | Yes | Yes | Yes | Yes |
| D Memory | Yes | Yes | Yes | — | Yes | Yes | Yes | Yes |
| E MCP | Yes | Yes | Yes | Yes | — | Yes | Yes | Yes |
| F Browser | Yes | Yes | Yes | Yes | Yes | — | Yes | Yes |
| G Providers | Yes | Yes | Yes | Yes | Yes | Yes | — | Yes |
| H UI | Yes | Yes | Yes | Yes | Yes | Yes | Yes | — |

The remaining intentional sequential point is **product composition/integration**, not contract invention. Once parallel PRs are ready, a narrow integration branch should wire their exported modules into Chat/Cowork/runtime endpoints. That integration pass must consume the frozen interfaces rather than redesign them.

If Chat C elects to reuse a process helper produced by Chat B, that particular refactor is an optional post-merge integration and should not make the Git implementation depend on an unmerged branch.

---

## Validation

Required repository validation for this gate and every merge-intended follow-up remains:

```bash
npm run release:validate
npm run check
```

`npm run check` includes:

- TypeScript build (`tsc -p tsconfig.json`);
- app build (`vite build`);
- all Node/tsx tests.

The gate-specific architecture coverage is in:

- `test/agent-runtime.test.ts`

It verifies:

- two different provider adapters with one runtime/tool protocol;
- Account and API-key auth through the same `InferenceProviderAgentAdapter` architecture;
- Company isolation and fail-closed mixed scopes;
- a provider-neutral tool implementation;
- explicit unavailable-capability behavior;
- provider-independent lifecycle events;
- canonical cancellation;
- timeout + mutation retry safety; and
- no silent provider/model/execution-target fallback.

CI remains the source of truth when local execution is unavailable. PR CI must be green before this gate is considered merge-ready.
