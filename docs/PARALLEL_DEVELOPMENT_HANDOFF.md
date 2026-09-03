# Parallel Development Handoff

Date: 2026-09-03

This document is the authoritative handoff for the **Parallel Development Ready Gate** introduced after PR #75.

Its purpose is to freeze the shared runtime protocol before filesystem, process, Git, Project Memory, MCP, browser, UI and additional provider work is distributed across independent branches.

The gate freezes contracts and extension points. It does **not** claim that those product areas are already implemented or that Chat/Cowork have completed their final migration to the new runtime.

---

## Gate criteria

The gate is considered reached when the PR containing this document has green required CI on its final head.

The code now satisfies the architectural criteria required for parallel work:

1. `AgentRuntime` is provider-agnostic.
2. Tool definition/call/result/error contracts are canonical.
3. New tools do not require edits to Claude/OpenAI/Ollama/Codex adapters.
4. New provider adapters do not require edits to tool implementations.
5. `AgentSessionContext` explicitly carries the Company/Project/Connection/model/execution authority established after PR #75.
6. `authKind` is provenance, not a separate runtime architecture.
7. Effective capabilities are explicitly negotiated and unavailable capabilities fail closed.
8. Lifecycle events are common to all providers and sufficient for future Project Memory/tracing.
9. Cancellation, timeout, progress, errors, retry eligibility and mutation state are central contracts.
10. Pause/decision, reasoning-summary, attachment-metadata and error shapes are part of the canonical transcript protocol.
11. The shared contracts have architecture-focused automated coverage.
12. The next workstreams can own separate directories and avoid continuous edits to the runtime core.

---

# Contratos congelados

All exports below are available through:

`src/agent-runtime/index.ts`

Parallel feature branches must treat them as stable unless a coordinated architecture change is explicitly approved.

## Session and authority

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

A running session is an immutable authority snapshot.

It explicitly fixes:

- Company;
- optional Project;
- exact Connection;
- provider family;
- `authKind`;
- exact model;
- exact execution target;
- authorized roots;
- permissions;
- effective capabilities;
- effective resources.

The runtime must never query an ambient active Company, silently widen filesystem roots, choose another Project, substitute a Connection/model, or fall back to another execution target during a turn.

Company-owned Projects, Connections, roots and resources must match `session.companyId`.

Project-owned roots/resources must also match `session.project.id`.

`connection.companyId === null` is reserved for intentionally shared local capabilities, not as a fallback Company.

## Canonical transcript and turns

- `AgentMessage`
- `AgentTurn`
- `AgentAttachment`
- `AgentDecisionRequest`
- `AgentDecisionResolution`
- `AgentRuntimeFailure`

`AgentMessage` is provider-neutral and can carry:

- textual content;
- summarized reasoning;
- attachment metadata/references;
- canonical tool calls;
- canonical tool results/errors;
- decision requests;
- decision resolutions.

`reasoningSummary` is intentionally summary-only. Raw provider chain-of-thought is not part of the Axis contract.

`AgentAttachment` freezes attachment metadata/reference shape only. Binary transport, multimodal model upload and storage are intentionally future work.

A turn may end as:

- `completed`;
- `paused`;
- `failed`;
- `cancelled`.

A pause carries an `AgentDecisionRequest` instead of forcing provider/UI-specific decision protocols.

## Tool protocol

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

An Axis tool receives canonical Axis context only.

It must not know whether the model came from Claude Account, ChatGPT Account, API Key, Ollama or a future provider.

Every tool declares:

- JSON Schema input;
- required capabilities;
- required permissions;
- semantic effect (`read`, `mutation`, `command`, `validation`, `external`);
- mutation risk;
- retry policy;
- optional timeout.

Potentially mutating work that fails without proving rollback/commit is represented as:

`mutationStatus: 'unknown'`

The runtime therefore cannot classify an uncertain mutation as automatically safe to retry.

## Provider protocol

- `AgentProviderAdapter`
- `AgentProviderRequest`
- `AgentProviderResponse`
- `AgentProviderControl`
- `AgentProviderAdapterCapabilities`
- `InferenceProviderAgentAdapter`

Provider-specific wire protocols terminate at `AgentProviderAdapter`.

The runtime sees only canonical messages, tool definitions, tool calls, decision requests, progress and provider results.

Every adapter is bound to one exact:

- `connectionId`;
- `providerFamily`;
- `modelId`.

The runtime verifies those identities against `AgentSessionContext` before invocation.

No adapter may silently choose another Connection or model.

### Provider-managed tool safety

The generic `InferenceProviderAgentAdapter` is intentionally fail-closed.

It can only be constructed when composition asserts:

`providerManagedToolExecution: 'disabled'`

This is appropriate for inference paths where filesystem/shell/MCP or other provider-managed tools cannot execute invisibly outside Axis.

If provider-managed tool execution is uncontrolled, the generic bridge rejects the connection.

Subscription CLIs such as Claude Code/Codex that can execute their own tools must therefore do one of the following before entering the canonical Axis runtime:

1. provide a verified no-tools invocation mode; or
2. implement a dedicated `AgentProviderAdapter` that translates every relevant provider tool interaction into canonical Axis calls/results.

This prevents reads, commands or mutations from bypassing Axis permissions, lifecycle and Project Memory instrumentation.

`authKind` does not change this architecture. Account and API Key connections still enter through `AgentProviderAdapter`; they may simply require different adapter implementations to enforce the same boundary safely.

## Capability protocol

- `CapabilityOffer`
- `CapabilityRestriction`
- `CapabilityNegotiationInput`
- `negotiateEffectiveCapabilities()`
- `capabilityUnavailableReason()`

Capability IDs are namespaced strings rather than a provider enum.

Recommended namespaces include:

- `axis.filesystem.read`
- `axis.filesystem.write`
- `axis.process.exec`
- `axis.git.read`
- `axis.git.mutate`
- `axis.mcp.invoke`
- `axis.browser.navigate`
- `target.workspace.read`
- `target.workspace.write`

Offers can come from Axis-native features, the selected connection/model, configured resources and the exact execution target.

Company/Project/session/provider-admin constraints are applied as restrictions.

Unavailable capabilities are explicit failures. They must not trigger a provider/model/Company fallback.

## Permission boundary

- `ToolPermissionGate`
- `ToolPermissionRequest`
- `ToolPermissionDecision`
- `StaticToolPermissionGate`

A permission gate can:

- allow;
- deny;
- require interactive approval.

Interactive approval produces a canonical `AgentDecisionRequest` and pauses before the tool executes.

A subsequent run records `AgentDecisionResolution`; composition may rebuild the immutable session permission set for the resumed turn when approval changes effective authority.

Future approval UI/policy implementations replace or wrap the permission gate. They do not require changes to provider adapters or tools.

## Execution-target boundary

- `AgentExecutionTarget`
- `LocalAgentExecutionTarget`
- `ExecutionTargetRegistry`

An execution target receives a canonical `AxisTool` + `ToolExecutionContext`.

The desktop target executes locally.

A future Local Worker target can transport the same canonical tool call to another machine/runtime without changing tool/provider contracts.

`ExecutionTargetRegistry` resolves only `session.executionTarget.id`.

A missing target is an explicit failure. There is no desktop/worker fallback.

## Lifecycle protocol

- `AgentLifecycleEvent`
- `AgentLifecycleSink`

The common lifecycle contains:

- `session.started`;
- `turn.started`;
- `user.input`;
- `provider.started`;
- `provider.progress`;
- `provider.completed`;
- `permission.requested`;
- `permission.resolved`;
- `decision.requested`;
- `decision.resolved`;
- `tool.call`;
- `tool.progress`;
- `tool.result`;
- `read`;
- `mutation`;
- `command`;
- `validation`;
- `error`;
- `cancelled`;
- `turn.completed`;
- `session.completed`.

Future Project Memory and tracing consume these events instead of instrumenting Claude, Codex, OpenAI API, Anthropic API and Ollama separately.

Lifecycle sinks are observational. A sink failure must not cause replay/retry of an already-started provider/tool mutation.

---

# Arquivos centrais

Parallel workstreams must not modify these files without coordination.

## Frozen runtime core

- `src/agent-runtime/contracts.ts`
- `src/agent-runtime/capabilities.ts`
- `src/agent-runtime/tools.ts`
- `src/agent-runtime/provider-adapter.ts`
- `src/agent-runtime/runtime.ts`
- `src/agent-runtime/index.ts`

## Existing multi-company/provider foundation

- `src/company-context.ts`
- `src/company-connection-ownership.ts`
- `src/project-store.ts`
- `src/provider-connections.ts`
- `src/project-provider-runtime.ts`
- `src/providers/types.ts`
- `src/cancellation.ts`

## Integration-sensitive composition files

Avoid broad parallel rewrites of:

- `src/execution-runtime.ts`
- `src/project-engineer-backend.ts`
- `src/project-routed-chat.ts`
- `src/app-runtime.ts`

Feature branches should implement/export modules behind the frozen contracts first.

A narrow integration pass can later wire them into Chat/Cowork without every branch editing the same composition files.

`package.json` and `CHANGELOG.md` remain required release metadata and may have small sequential merge conflicts. Those are release-bookkeeping conflicts, not architecture dependencies.

---

# Extension points

## Como criar uma nova tool

1. Create the implementation outside `src/agent-runtime/`, preferably under `src/agent-tools/<area>/`.
2. Implement `AxisTool`.
3. Declare its `ToolDefinition`.
4. Validate canonical arguments in the tool implementation.
5. Use only `ToolExecutionContext.session` for authority/scope.
6. Respect `ToolExecutionContext.signal`.
7. Report progress through `reportProgress()`.
8. Report meaningful read/mutation/command/validation details through `reportActivity()`.
9. Return explicit mutation status for potentially mutating work.
10. Register through `ToolRegistry` at composition time.

Do not edit provider adapters or `AgentRuntime` to add a tool.

## Como criar um novo provider adapter

1. Create it outside `src/agent-runtime/`, preferably under `src/agent-provider-adapters/<provider>/`.
2. Implement `AgentProviderAdapter`.
3. Bind it to the selected Connection + model exactly.
4. Translate canonical transcript/tools into the provider protocol.
5. Translate provider tool calls back into `ToolCall`.
6. Translate provider decision requests, reasoning summaries and attachment metadata into canonical fields when supported.
7. Translate streaming/progress into `AgentProgress`.
8. Honor the provided `AbortSignal` and timeout.
9. Ensure provider-managed tools cannot execute invisibly outside Axis.
10. Never choose an alternate Company/Connection/model/execution target.

Do not import native filesystem/process/Git tool implementations into the provider adapter.

## Como criar um lifecycle consumer

1. Implement `AgentLifecycleSink` under a feature-owned directory such as `src/project-memory/` or `src/tracing/`.
2. Consume `AgentLifecycleEvent` only.
3. Persist using the canonical Company + Project + repository/root identity required by `docs/PROJECT_MEMORY.md`.
4. Never infer Company from provider account labels or workspace paths.
5. Keep persistence observational/idempotent.
6. Do not instrument individual provider adapters for events already represented by the common lifecycle.

## Como criar uma capability

1. Create a namespaced capability ID in the feature module.
2. Add it to session capability offers during composition.
3. Apply restrictions at Company/Project/session/admin layers when needed.
4. Add the ID to relevant `ToolDefinition.requiredCapabilities`.
5. Test both available and unavailable negotiation.
6. Do not add provider-specific branches to `AgentRuntime`.

---

# Frentes paralelas recomendadas

## Chat A — Filesystem

- Branch: `feat/runtime-filesystem-tools`
- Ownership: `src/agent-tools/filesystem/**`, filesystem-focused tests.
- Consumes: `AxisTool`, `ToolExecutionContext`, roots, capabilities, permissions, mutation lifecycle.
- Must not modify: `src/agent-runtime/**`, provider adapters, Company/Project stores.
- Dependencies: gate only.
- Completion:
  - scoped list/read/search/stat/write/edit primitives selected for P1.2;
  - root/path traversal/symlink enforcement;
  - cancellation/timeouts;
  - read/mutation activity metadata;
  - mutation status;
  - Company/Project isolation tests.

## Chat B — Shell/process

- Branch: `feat/runtime-process-tools`
- Ownership: `src/agent-tools/process/**`, process tests.
- Consumes: canonical tool, command lifecycle, execution target, cancellation.
- Must not modify: runtime core or provider adapters.
- Dependencies: gate only.
- Completion:
  - P1.3 process/run-command semantics;
  - stdout/stderr/progress/exit metadata;
  - cancellation/timeout/kill;
  - cwd restricted to session roots;
  - permission and mutation-safety tests.

## Chat C — Git/worktrees/review

- Branch: `feat/runtime-git-worktrees`
- Ownership: `src/agent-tools/git/**`; narrow reuse/extensions of existing Git-review code only when necessary.
- Consumes: tool/lifecycle/session contracts.
- Must not modify: runtime core, provider adapters, Company/Project identity stores.
- Dependencies: gate only. Process-helper reuse is optional post-merge integration.
- Completion:
  - scoped status/diff/worktree operations;
  - explicit mutation permissions;
  - existing review representation reused where practical;
  - lifecycle command/mutation/validation metadata;
  - no arbitrary renderer-supplied repo path.

## Chat D — Project Memory/handoff

- Branch: `feat/runtime-project-memory`
- Ownership: `src/project-memory/**`, memory tests.
- Consumes: `AgentLifecycleEvent`, `AgentLifecycleSink`, immutable session scope.
- Must not modify: providers, native tools, runtime core.
- Dependencies: gate only; richer A/B/C metadata may be consumed later.
- Completion:
  - durable Company + Project + repository/root partitioning;
  - event-driven capture of reads/mutations/commands/validations/errors/decisions/completion;
  - structured provider-neutral handoff;
  - no provider/auth/session ownership of memory;
  - cross-Company/Project isolation tests.

## Chat E — MCP host

- Branch: `feat/runtime-mcp-host`
- Ownership: `src/agent-tools/mcp/**`, narrow bridge code/tests.
- Consumes: tool registry, resources, capabilities, permission/lifecycle contracts.
- Must not modify: runtime core or provider-specific adapters.
- Dependencies: gate only.
- Completion:
  - session-scoped MCP catalog → canonical tool-definition bridge;
  - resource/Company isolation;
  - explicit capability/permission failure;
  - MCP invocation through common tool lifecycle;
  - no provider-specific Project Memory instrumentation.

## Chat F — Browser

- Branch: `feat/runtime-browser-tools`
- Ownership: `src/agent-tools/browser/**`, browser tests.
- Consumes: tool/permission/target/cancellation/lifecycle contracts.
- Must not modify: runtime core or provider adapters.
- Dependencies: gate only.
- Completion:
  - session-scoped browser lifetime;
  - navigation/read/action capabilities separated;
  - cancellation/timeouts;
  - external/mutation permissions;
  - provider-independent tool tests.

## Chat G — Provider adapters

- Branch: `feat/runtime-native-provider-adapters`
- Ownership: `src/agent-provider-adapters/**`, provider-adapter tests; narrow provider wire-protocol changes only when required.
- Consumes: `AgentProviderAdapter` and canonical transcript/tool/decision/progress contracts.
- Must not modify: native tools, `AgentRuntime`, Company/Project stores.
- Dependencies: gate only.
- Completion:
  - dedicated safe Account adapters/no-tools modes for Claude/Codex where needed;
  - native tool-call translation where beneficial;
  - structured fallback where safe/reliable;
  - exact Connection/model identity;
  - cancellation/progress/error mapping;
  - no hidden provider-managed filesystem/shell/MCP execution;
  - parity tests across Account/API/local paths as applicable.

## Chat H — UI panes/approvals

- Branch: `feat/runtime-ui-panes`
- Ownership: `app/src/**`, UI tests.
- Consumes: serialized canonical transcript/lifecycle/result/decision/permission shapes.
- Must not modify: runtime core as part of visual work.
- Dependencies: UI states can be developed from the gate; final live backend wiring follows composition integration.
- Completion:
  - tool call/result/progress/error/cancellation UI;
  - pause/decision/approval UI;
  - reasoning-summary/attachment presentation where assigned;
  - required Axis/Claude visual validation from `AGENTS.md`.

---

# Matriz de conflitos

All feature implementations A–H may be developed simultaneously after this gate is merged.

| Workstream | A FS | B Proc | C Git | D Memory | E MCP | F Browser | G Provider | H UI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A Filesystem | — | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| B Process | Yes | — | Yes | Yes | Yes | Yes | Yes | Yes |
| C Git | Yes | Yes | — | Yes | Yes | Yes | Yes | Yes |
| D Memory | Yes | Yes | Yes | — | Yes | Yes | Yes | Yes |
| E MCP | Yes | Yes | Yes | Yes | — | Yes | Yes | Yes |
| F Browser | Yes | Yes | Yes | Yes | Yes | — | Yes | Yes |
| G Providers | Yes | Yes | Yes | Yes | Yes | Yes | — | Yes |
| H UI | Yes | Yes | Yes | Yes | Yes | Yes | Yes | — |

The remaining intentional sequential point is **product composition/integration**.

Once feature PRs are ready, a narrow integration branch should register tools/adapters/lifecycle consumers and migrate Chat/Cowork entrypoints using the frozen interfaces.

That integration pass must consume the contracts above rather than redesign them.

---

# Validação

Required validation for this gate and follow-up mergeable PRs:

```bash
npm run release:validate
npm run check
```

`npm run check` covers:

- release metadata validation;
- TypeScript build;
- Vite app build;
- full Node/tsx test suite.

Gate-specific architecture coverage lives in:

- `test/agent-runtime.test.ts`
- `test/agent-runtime-decisions.test.ts`

Together they cover:

- two distinct provider adapters with one runtime/tool protocol;
- Account/API-key auth kinds under the same architectural boundary;
- rejection of the generic inference bridge when provider-managed tools are uncontrolled;
- provider-neutral tools;
- Company isolation;
- immutable exact Connection/model/execution-target selection;
- explicit capability refusal;
- provider-independent lifecycle events;
- cancellation;
- timeout and mutation retry safety;
- provider-originated decision pauses;
- permission-originated approval pauses before mutation;
- decision resolution lifecycle;
- reasoning-summary and attachment transcript metadata.

PR CI is the source of truth for the final branch head.

The gate is merge-ready only when required CI is green on that head.
