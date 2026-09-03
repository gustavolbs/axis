# Parallel Development Handoff

Date: 2026-09-03

This is the authoritative handoff for the **Parallel Development Ready Gate** after PR #75.

The goal of this gate is to freeze the shared agent-runtime architecture before filesystem, process, Git, Project Memory, MCP, browser, UI and additional provider work is distributed across independent branches.

It freezes contracts and extension points. It intentionally does **not** implement those parallel workstreams in depth.

---

# Gate status

The code now contains the centralized/sequential pieces that future branches would otherwise be forced to redesign together:

1. provider-agnostic `AgentRuntime`;
2. canonical tool definition/call/result/error protocol;
3. immutable multi-company session authority;
4. a canonical builder from the PR #75 `CompanyContextSnapshot` into `AgentSessionContext`;
5. explicit capability negotiation;
6. provider adapter boundary independent of auth kind;
7. execution-target and permission boundaries;
8. canonical lifecycle for tracing/Project Memory;
9. cancellation, timeout, progress, error, retry and mutation-safety contracts;
10. pause/decision protocol;
11. transcript shapes for text, summarized reasoning, attachment metadata/references and errors;
12. fail-closed handling for provider-managed tools;
13. architecture-focused tests for the invariants above.

The gate is **merge-ready only when required CI is green on the final PR head**.

---

# Contratos congelados

The public runtime surface is exported by:

`src/agent-runtime/index.ts`

Future feature branches should consume these contracts rather than redefine them.

## Session and authority

Frozen exports:

- `AgentSessionContext`
- `AgentConnectionContext`
- `AgentProjectContext`
- `AgentExecutionTargetContext`
- `AgentRoot`
- `AgentResourceBinding`
- `AgentPermissionSet`
- `EffectiveCapabilitySet`
- `CanonicalAgentSessionContextInput`
- `buildAgentSessionContext()`
- `assertAgentSessionContext()`
- `freezeAgentSessionContext()`

A session explicitly fixes:

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

## Canonical Company graph integration

`buildAgentSessionContext()` consumes the `CompanyContextSnapshot` introduced by the multi-company foundation in PR #75.

Ownership of Projects, Connections and already-known Sessions is taken from that canonical snapshot.

The builder deliberately does **not** use these as authority:

- legacy `organizationId` on `ProviderConnectionView`;
- mutable account labels;
- workspace paths;
- provider family names.

A deliberately conflicting legacy organization value cannot move a Connection out of the Company to which the canonical snapshot binds it.

Shared local connections listed by `CompanyContextSnapshot.sharedConnectionIds` remain Company-neutral (`connection.companyId === null`) while the session itself remains Company-scoped.

If the selected Project, Connection or existing Session belongs to another Company, construction fails before model/tool execution.

The runtime must never discover another Company, Project, Connection, model, root or target while a turn is running.

## Transcript and turn protocol

Frozen exports:

- `AgentMessage`
- `AgentTurn`
- `AgentAttachment`
- `AgentDecisionRequest`
- `AgentDecisionResolution`
- `AgentRuntimeFailure`

`AgentMessage` can carry:

- text;
- summarized reasoning;
- attachment metadata/references;
- canonical tool calls;
- canonical errors;
- decision requests/resolutions.

`reasoningSummary` is summary-only. Raw provider chain-of-thought is not part of the Axis protocol.

`AgentAttachment` freezes metadata/reference shape only. Binary transport/storage and multimodal provider upload remain future work.

A turn may end as:

- `completed`;
- `paused`;
- `failed`;
- `cancelled`.

A pause carries an `AgentDecisionRequest`.

## Tool protocol

Frozen exports:

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

A tool receives Axis canonical context only. It never parses provider protocols.

Each tool declares:

- JSON Schema input;
- required capabilities;
- required permissions;
- semantic effect (`read`, `mutation`, `command`, `validation`, `external`);
- mutation risk;
- retry policy;
- optional timeout.

Potentially mutating failures that cannot prove rollback/commit remain:

`mutationStatus: 'unknown'`

They are not automatically safe to retry.

## Provider protocol

Frozen exports:

- `AgentProviderAdapter`
- `AgentProviderRequest`
- `AgentProviderResponse`
- `AgentProviderControl`
- `AgentProviderAdapterCapabilities`
- `InferenceProviderAgentAdapter`

Provider wire protocols terminate at `AgentProviderAdapter`.

An adapter is bound to one exact:

- `connectionId`;
- `providerFamily`;
- `modelId`.

The runtime verifies these against the immutable session.

No adapter may silently choose another Connection/model.

### Auth independence

`authKind` is provenance, not runtime dispatch.

Claude Account, ChatGPT/Codex Account, API Key and local providers all connect through the same `AgentProviderAdapter` architecture.

They may use different adapter implementations when necessary to enforce the same safety boundary.

### Generic structured fallback

`InferenceProviderAgentAdapter` is the compatibility bridge for an existing `InferenceProvider` whose provider-managed tool execution has been disabled.

When structured output is available, the bridge keeps the response in the canonical envelope even when no Axis tools are registered. This allows a provider to return a canonical `AgentDecisionRequest` or `reasoningSummary` without requiring a tool call.

When a model has no reliable native tool protocol but does have structured output, tool calls are represented through this common structured envelope.

### Provider-managed tool safety

The generic bridge requires:

`providerManagedToolExecution: 'disabled'`

If provider-managed tool execution is uncontrolled, construction fails.

This is deliberate. Claude Code/Codex subscription CLIs can have their own filesystem/shell/MCP capabilities; allowing them to run those invisibly would bypass Axis permissions, lifecycle, mutation safety and future Project Memory.

An Account CLI must therefore either:

1. expose a verified no-tools inference mode; or
2. use a dedicated `AgentProviderAdapter` that converts relevant tool interactions into canonical Axis calls/results.

No hidden provider tool is accepted as part of a supposedly unified run.

## Capability protocol

Frozen exports:

- `CapabilityOffer`
- `CapabilityRestriction`
- `CapabilityNegotiationInput`
- `negotiateEffectiveCapabilities()`
- `capabilityUnavailableReason()`

Capabilities are namespaced strings rather than a provider enum.

Examples:

- `axis.filesystem.read`
- `axis.filesystem.write`
- `axis.process.exec`
- `axis.git.read`
- `axis.git.mutate`
- `axis.mcp.invoke`
- `axis.browser.navigate`
- `target.workspace.read`
- `target.workspace.write`

Offers may come from native Axis features, the selected provider/model, effective resources and the exact execution target.

Company/Project/session/provider-admin restrictions narrow those offers.

Missing/blocked capabilities fail explicitly. They never trigger provider/model/Company fallback.

## Permission boundary

Frozen exports:

- `ToolPermissionGate`
- `ToolPermissionRequest`
- `ToolPermissionDecision`
- `StaticToolPermissionGate`

A gate can allow, deny or require approval.

Approval-required permission pauses before tool execution and emits a canonical decision request.

A resumed turn records `AgentDecisionResolution`; composition may rebuild the immutable session permissions when an approval changes effective authority.

## Execution-target boundary

Frozen exports:

- `AgentExecutionTarget`
- `LocalAgentExecutionTarget`
- `ExecutionTargetRegistry`

The selected target receives the canonical tool/context.

A future Local Worker can transport that same protocol without changing providers or tools.

Only `session.executionTarget.id` is resolved. Missing target means explicit failure, not desktop/worker fallback.

## Lifecycle protocol

Frozen exports:

- `AgentLifecycleEvent`
- `AgentLifecycleSink`

Common lifecycle:

- `session.started` / `session.completed`;
- `turn.started` / `turn.completed`;
- `user.input`;
- `provider.started` / `provider.progress` / `provider.completed`;
- `permission.requested` / `permission.resolved`;
- `decision.requested` / `decision.resolved`;
- `tool.call` / `tool.progress` / `tool.result`;
- `read`;
- `mutation`;
- `command`;
- `validation`;
- `error`;
- `cancelled`.

Project Memory/tracing must observe this lifecycle instead of instrumenting Claude, Codex, OpenAI API, Anthropic API and Ollama separately.

Lifecycle sinks are observers. A sink failure must not replay an already-started provider/tool mutation.

---

# Arquivos centrais

Parallel branches should not modify these without explicit coordination.

## Frozen runtime core

- `src/agent-runtime/contracts.ts`
- `src/agent-runtime/capabilities.ts`
- `src/agent-runtime/tools.ts`
- `src/agent-runtime/provider-adapter.ts`
- `src/agent-runtime/runtime.ts`
- `src/agent-runtime/session-context.ts`
- `src/agent-runtime/index.ts`

## Multi-company/provider foundation

- `src/company-context.ts`
- `src/company-connection-ownership.ts`
- `src/project-store.ts`
- `src/provider-connections.ts`
- `src/project-provider-runtime.ts`
- `src/providers/types.ts`
- `src/cancellation.ts`

## Integration-sensitive composition files

Avoid broad simultaneous rewrites of:

- `src/execution-runtime.ts`
- `src/project-engineer-backend.ts`
- `src/project-routed-chat.ts`
- `src/app-runtime.ts`

Feature branches should implement/export modules behind frozen interfaces first.

A later narrow integration pass registers them in Chat/Cowork/runtime endpoints.

`package.json` and `CHANGELOG.md` may have sequential version conflicts between PRs; those are release bookkeeping, not runtime architecture conflicts.

---

# Extension points

## Nova tool

1. Create it under `src/agent-tools/<area>/` or another feature-owned directory.
2. Implement `AxisTool`.
3. Declare JSON Schema, capabilities, permissions, effect, mutation risk, retry policy and timeout.
4. Validate arguments inside the tool.
5. Use only `ToolExecutionContext.session` for authority.
6. Respect `signal`.
7. Emit progress with `reportProgress()`.
8. Emit read/mutation/command/validation detail with `reportActivity()` when useful.
9. Return explicit mutation status for mutating work.
10. Register in `ToolRegistry` during composition.

Do not change providers or `AgentRuntime` to add a tool.

## Novo provider adapter

1. Create it under `src/agent-provider-adapters/<provider>/`.
2. Implement `AgentProviderAdapter`.
3. Bind exact Connection + model.
4. Translate canonical transcript/tools to provider protocol.
5. Translate provider tool calls back to `ToolCall`.
6. Translate decisions, summarized reasoning and attachment metadata when supported.
7. Map streaming/progress/errors.
8. Honor `AbortSignal` and timeout.
9. Disable or canonicalize provider-managed tool execution.
10. Never choose alternate Company/Connection/model/target.

Do not import filesystem/process/Git tool implementations into the provider adapter.

## Lifecycle consumer

1. Implement `AgentLifecycleSink`, e.g. under `src/project-memory/`.
2. Consume common lifecycle events only.
3. Partition persistence by Company + Project + repository/root identity per `docs/PROJECT_MEMORY.md`.
4. Never infer Company from provider labels or workspace paths.
5. Keep writes observational/idempotent.
6. Do not separately instrument individual providers for common events.

## Capability

1. Define a namespaced ID in the feature module.
2. Add an offer at session composition.
3. Add restrictions as needed.
4. Add it to relevant tool definitions.
5. Test available and unavailable cases.
6. Do not add provider switches to the runtime.

---

# Frentes paralelas recomendadas

## Chat A — Filesystem

- Branch: `feat/runtime-filesystem-tools`
- Ownership: `src/agent-tools/filesystem/**` + focused tests.
- Consumes: tool/session/root/capability/permission/lifecycle contracts.
- Do not modify: runtime core, providers, Company/Project stores.
- Dependencies: gate only.
- Done when: scoped read/list/search/stat/write/edit primitives chosen for P1.2; traversal/symlink/root enforcement; cancellation/timeouts; activity/mutation metadata; isolation tests.

## Chat B — Shell/process

- Branch: `feat/runtime-process-tools`
- Ownership: `src/agent-tools/process/**` + process tests.
- Consumes: tool, execution target, cancellation, command lifecycle.
- Do not modify: runtime core or providers.
- Dependencies: gate only.
- Done when: P1.3 run/process semantics; stdout/stderr/progress/exit metadata; cancellation/timeout/kill; root-scoped cwd; permissions/mutation tests.

## Chat C — Git/worktrees/review

- Branch: `feat/runtime-git-worktrees`
- Ownership: `src/agent-tools/git/**`; narrow reuse of existing Git-review code.
- Consumes: tool/session/lifecycle contracts.
- Do not modify: runtime core, providers, Company/Project identity stores.
- Dependencies: gate only; process-helper reuse is optional later integration.
- Done when: scoped status/diff/worktree operations; mutation permissions; review representation reuse; lifecycle metadata; no arbitrary renderer path.

## Chat D — Project Memory/handoff

- Branch: `feat/runtime-project-memory`
- Ownership: `src/project-memory/**` + tests.
- Consumes: lifecycle + immutable session authority.
- Do not modify: providers, native tools, runtime core.
- Dependencies: gate only; richer A/B/C metadata can be consumed after merge.
- Done when: Company+Project+repo/root partitioning; event-driven reads/mutations/commands/validation/errors/decisions/completion; provider-neutral handoff; isolation tests.

## Chat E — MCP host

- Branch: `feat/runtime-mcp-host`
- Ownership: `src/agent-tools/mcp/**` + narrow bridges/tests.
- Consumes: registry/resources/capabilities/permissions/lifecycle.
- Do not modify: runtime core or provider adapters.
- Dependencies: gate only.
- Done when: MCP catalog → canonical tool definitions; resource/Company isolation; explicit failures; MCP calls through common lifecycle.

## Chat F — Browser

- Branch: `feat/runtime-browser-tools`
- Ownership: `src/agent-tools/browser/**` + tests.
- Consumes: tool/permission/target/cancellation/lifecycle contracts.
- Do not modify: runtime core/providers.
- Dependencies: gate only.
- Done when: scoped browser lifetime; separate navigation/read/action capabilities; cancellation/timeouts; external/mutation permission semantics.

## Chat G — Provider adapters

- Branch: `feat/runtime-native-provider-adapters`
- Ownership: `src/agent-provider-adapters/**` + provider-adapter tests; narrow wire-protocol changes only when required.
- Consumes: canonical provider/transcript/tool/decision/progress contracts.
- Do not modify: native tools, AgentRuntime, Company/Project stores.
- Dependencies: gate only.
- Done when: safe Claude/Codex Account no-tools/native adapters as applicable; native tool translation where useful; exact identity; progress/error/cancellation mapping; no hidden provider-managed filesystem/shell/MCP execution.

## Chat H — UI panes/approvals

- Branch: `feat/runtime-ui-panes`
- Ownership: `app/src/**` + UI tests.
- Consumes: serialized transcript/lifecycle/result/decision/permission contracts.
- Do not modify: runtime core for visual work.
- Dependencies: UI states can develop immediately after gate; final live wiring follows integration.
- Done when: tool/progress/error/cancellation presentation; pause/decision/approval UI; assigned reasoning/attachment display; required real-Electron visual verification.

---

# Matriz de conflitos

A–H can implement their owned modules simultaneously after this gate is merged.

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

The remaining intentional sequential stage is **product composition/integration**, not contract design.

After parallel PRs are ready, a narrow integration branch should register tools/adapters/lifecycle consumers and migrate Chat/Cowork entrypoints using these frozen contracts.

---

# Validação

Required merge validation:

```bash
npm run release:validate
npm run check
```

`npm run check` includes release validation, TypeScript build, Vite build and the full Node/tsx test suite.

Gate-specific tests:

- `test/agent-runtime.test.ts`
- `test/agent-runtime-decisions.test.ts`
- `test/agent-session-context.test.ts`
- `test/inference-provider-agent-adapter.test.ts`

They cover:

- two provider adapters under one runtime/tool protocol;
- Account/API-key auth kinds under one architecture;
- unsafe hidden-provider-tool bridge rejection;
- structured decision fallback without registered tools;
- provider-neutral tools;
- PR #75 canonical Company snapshot → immutable agent session mapping;
- legacy organization metadata not overriding canonical Connection ownership;
- cross-Company Project/Connection/Session rejection;
- shared local Connection semantics;
- explicit capability refusal;
- provider-independent lifecycle;
- cancellation and timeout;
- mutation retry safety;
- provider-originated decision pause;
- permission-originated pause before mutation;
- decision resolution lifecycle;
- reasoning-summary and attachment metadata;
- no silent provider/model/execution-target substitution.

PR CI on the final head is the source of truth.

Only after required CI is green should this branch be merged and A–H be opened from the resulting `main`.
