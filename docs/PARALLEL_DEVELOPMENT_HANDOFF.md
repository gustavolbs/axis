# Parallel Development Handoff

Date: 2026-09-03

This is the authoritative handoff for the **Parallel Development Ready Gate** after PR #75.

The purpose of this gate is to freeze the shared runtime architecture before filesystem, process, Git, Project Memory, MCP, browser, UI and additional provider work is distributed across independent branches.

It intentionally stops at the common contracts and proofs. It does not implement the parallel workstreams in depth.

---

# Gate status

The centralized/sequential architecture now contains:

1. provider-agnostic `AgentRuntime`;
2. canonical tool definition/call/result/error protocol;
3. immutable multi-company session authority;
4. canonical PR #75 `CompanyContextSnapshot` → `AgentSessionContext` construction;
5. stable provider/model capability IDs plus effective capability negotiation;
6. provider adapter boundary independent of `authKind`;
7. execution-target and permission boundaries;
8. common lifecycle for tracing/Project Memory;
9. cancellation, timeout, progress, error, retry and mutation-safety contracts;
10. pause/decision protocol;
11. transcript shapes for text, summarized reasoning, attachment metadata/references and errors;
12. fail-closed handling for provider-managed tools;
13. architecture-focused tests for the invariants above.

The gate is merge-ready only when required CI is green on the final PR head.

---

# Contratos congelados

Public exports live at:

`src/agent-runtime/index.ts`

Future feature branches should consume, not redefine, the contracts below.

## Session and authority

Frozen:

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

A session fixes Company, optional Project, exact Connection, provider family, `authKind`, exact model, exact execution target, roots, permissions, effective capabilities and resources before execution begins.

### PR #75 Company graph is authoritative

`buildAgentSessionContext()` consumes the canonical `CompanyContextSnapshot` created by the multi-company foundation.

Project/Connection/existing-Session ownership comes from that snapshot, never from:

- legacy `organizationId`;
- account labels;
- workspace paths;
- provider family names.

A conflicting legacy organization value cannot move a Connection to another Company.

Shared local connections listed by `sharedConnectionIds` remain Company-neutral (`connection.companyId === null`) while the session itself stays Company-scoped.

Cross-Company Project, Connection or existing Session selection fails before provider/tool execution.

The runtime never discovers another Company, Project, Connection, model, root or target during a turn.

## Transcript and turn protocol

Frozen:

- `AgentMessage`
- `AgentTurn`
- `AgentAttachment`
- `AgentDecisionRequest`
- `AgentDecisionResolution`
- `AgentRuntimeFailure`

Canonical messages can carry text, summarized reasoning, attachment metadata/references, tool calls, errors and decision requests/resolutions.

`reasoningSummary` is summary-only. Raw provider chain-of-thought is not part of the Axis protocol.

`AgentAttachment` freezes metadata/reference shape only. Binary transport/storage and multimodal upload remain future work.

A turn ends as `completed`, `paused`, `failed` or `cancelled`.

A pause carries an `AgentDecisionRequest`.

## Tool protocol

Frozen:

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

Tools receive Axis canonical context only and never parse provider protocols.

Each tool declares JSON Schema input, required capabilities/permissions, semantic effect, mutation risk, retry policy and optional timeout.

Potentially mutating failures that cannot prove rollback/commit remain `mutationStatus: 'unknown'` and are not automatically safe to retry.

## Provider protocol

Frozen:

- `AgentProviderAdapter`
- `AgentProviderRequest`
- `AgentProviderResponse`
- `AgentProviderControl`
- `AgentProviderAdapterCapabilities`
- `InferenceProviderAgentAdapter`

Provider wire protocols terminate at `AgentProviderAdapter`.

An adapter is bound to one exact `connectionId`, `providerFamily` and `modelId`; the runtime verifies them against the immutable session and never substitutes another selection.

### Auth independence

`authKind` is provenance, not runtime dispatch.

Claude Account, ChatGPT/Codex Account, API Key and local providers enter through the same `AgentProviderAdapter` architecture. Different implementations are allowed only to translate/enforce provider-specific protocols behind that common boundary.

### Generic structured fallback

`InferenceProviderAgentAdapter` is the compatibility bridge for an existing `InferenceProvider` whose provider-managed tool execution is disabled.

When structured output exists, the adapter keeps the response inside the canonical envelope even with zero registered tools. Therefore a model can still produce `AgentDecisionRequest` and `reasoningSummary` without a native tool call.

For models without reliable native tool calling but with reliable structured output, Axis tool requests use the same canonical structured envelope.

### Provider-managed tool safety

The generic bridge requires:

`providerManagedToolExecution: 'disabled'`

If provider-managed tool execution is uncontrolled, construction fails.

Claude Code/Codex subscription CLIs can expose their own filesystem/shell/MCP capabilities. Those may not run invisibly inside a supposedly unified Axis turn because that would bypass permissions, lifecycle, mutation safety and future Project Memory.

Such connections must expose a verified no-tools mode or implement a dedicated `AgentProviderAdapter` that translates relevant provider tool interactions into canonical Axis traffic.

## Capability protocol

Frozen:

- `PROVIDER_CAPABILITY_IDS`
- `ProviderCapabilityId`
- `providerModelCapabilityOffer()`
- `CapabilityOffer`
- `CapabilityRestriction`
- `CapabilityNegotiationInput`
- `negotiateEffectiveCapabilities()`
- `capabilityUnavailableReason()`

Canonical provider/model capability IDs are:

- `provider.model-discovery`
- `provider.streaming`
- `provider.structured-output`
- `provider.reasoning`
- `provider.prompt-caching`
- `provider.tool-use`

`providerModelCapabilityOffer()` combines provider defaults with model-specific overrides into one offer. A model-level `false` therefore narrows a provider-level `true` instead of accidentally leaving the capability available through a second offer.

Provider/admin, Company, Project or session restrictions can then narrow the resulting capability set. Explicit deny wins.

Feature/tool capabilities remain open namespaced strings, e.g.:

- `axis.filesystem.read`
- `axis.filesystem.write`
- `axis.process.exec`
- `axis.git.read`
- `axis.git.mutate`
- `axis.mcp.invoke`
- `axis.browser.navigate`
- `target.workspace.read`
- `target.workspace.write`

Unavailable capabilities fail explicitly and never trigger another provider/model/Company fallback.

## Permission boundary

Frozen:

- `ToolPermissionGate`
- `ToolPermissionRequest`
- `ToolPermissionDecision`
- `StaticToolPermissionGate`

A gate may allow, deny or require approval.

Approval-required permission pauses before tool execution and emits a canonical decision request. A resumed turn records `AgentDecisionResolution`; composition may rebuild the immutable permission set when approval changes authority.

## Execution-target boundary

Frozen:

- `AgentExecutionTarget`
- `LocalAgentExecutionTarget`
- `ExecutionTargetRegistry`

The exact target receives the canonical tool/context. A future Local Worker transports the same protocol without changing tools/providers.

Only `session.executionTarget.id` is resolved. Missing target is an explicit failure, never a desktop/worker fallback.

## Lifecycle protocol

Frozen:

- `AgentLifecycleEvent`
- `AgentLifecycleSink`

Common events include session/turn start+completion, user input, provider start/progress/completion, permission request/resolution, decision request/resolution, tool call/progress/result, read, mutation, command, validation, error and cancellation.

Future Project Memory/tracing observes this lifecycle instead of instrumenting Claude, Codex, OpenAI API, Anthropic API and Ollama independently.

Lifecycle sinks are observational; sink failure must not replay an already-started provider/tool mutation.

---

# Arquivos centrais

Parallel branches should not modify these without coordination.

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

Feature branches implement/export modules behind frozen interfaces first. A later narrow integration pass registers them in Chat/Cowork/runtime endpoints.

`package.json` and `CHANGELOG.md` may have sequential version conflicts; those are release bookkeeping rather than architecture dependencies.

---

# Extension points

## Nova tool

1. Create under `src/agent-tools/<area>/` or another feature-owned directory.
2. Implement `AxisTool`.
3. Declare schema, capabilities, permissions, effect, mutation risk, retry and timeout.
4. Validate arguments inside the tool.
5. Use only `ToolExecutionContext.session` for authority.
6. Respect `signal`.
7. Emit progress/activity.
8. Return explicit mutation status for mutating work.
9. Register through `ToolRegistry` at composition time.

Do not change provider adapters or `AgentRuntime` to add a tool.

## Novo provider adapter

1. Create under `src/agent-provider-adapters/<provider>/`.
2. Implement `AgentProviderAdapter`.
3. Bind exact Connection + model.
4. Translate canonical transcript/tools to provider protocol.
5. Translate tool calls, decisions, summarized reasoning and attachment metadata back to canonical fields.
6. Map progress/errors/cancellation.
7. Honor signal/timeout.
8. Disable or canonicalize provider-managed tools.
9. Use `PROVIDER_CAPABILITY_IDS`/`providerModelCapabilityOffer()` for standard provider/model capability negotiation rather than inventing synonyms.
10. Never choose another Company/Connection/model/target.

Do not import filesystem/process/Git implementations into a provider adapter.

## Lifecycle consumer

1. Implement `AgentLifecycleSink`, e.g. under `src/project-memory/`.
2. Consume common events only.
3. Partition persistence by Company + Project + repository/root identity per `docs/PROJECT_MEMORY.md`.
4. Never infer Company from labels/workspace paths.
5. Keep writes observational/idempotent.
6. Do not separately instrument providers for common events.

## Capability

1. Reuse `PROVIDER_CAPABILITY_IDS` for standard provider/model capabilities.
2. Define feature-specific namespaced IDs in the feature module.
3. Add offers at session composition.
4. Apply restrictions as needed.
5. Add IDs to relevant tool definitions.
6. Test available/unavailable behavior.
7. Do not add provider switches to `AgentRuntime`.

---

# Frentes paralelas recomendadas

## Chat A — Filesystem

- Branch: `feat/runtime-filesystem-tools`
- Ownership: `src/agent-tools/filesystem/**` + focused tests.
- Consumes: tool/session/root/capability/permission/lifecycle contracts.
- Do not modify: runtime core, providers, Company/Project stores.
- Dependencies: gate only.
- Done: scoped P1.2 primitives, traversal/symlink/root enforcement, cancellation/timeouts, activity/mutation metadata, isolation tests.

## Chat B — Shell/process

- Branch: `feat/runtime-process-tools`
- Ownership: `src/agent-tools/process/**` + process tests.
- Consumes: tool/target/cancellation/command lifecycle.
- Do not modify: runtime core/providers.
- Dependencies: gate only.
- Done: P1.3 process semantics, stdout/stderr/progress/exit, cancellation/timeout/kill, root-scoped cwd, permission/mutation tests.

## Chat C — Git/worktrees/review

- Branch: `feat/runtime-git-worktrees`
- Ownership: `src/agent-tools/git/**`; narrow reuse of existing Git-review code.
- Consumes: tool/session/lifecycle.
- Do not modify: runtime core/providers/Company identity stores.
- Dependencies: gate only; process-helper reuse optional later.
- Done: scoped status/diff/worktree, mutation permissions, review representation reuse, lifecycle metadata, no renderer-supplied arbitrary repo path.

## Chat D — Project Memory/handoff

- Branch: `feat/runtime-project-memory`
- Ownership: `src/project-memory/**` + tests.
- Consumes: lifecycle + immutable session authority.
- Do not modify: providers/native tools/runtime core.
- Dependencies: gate only; richer tool metadata can be consumed later.
- Done: Company+Project+repo/root partitioning, event-driven durable memory/handoff, isolation tests.

## Chat E — MCP host

- Branch: `feat/runtime-mcp-host`
- Ownership: `src/agent-tools/mcp/**` + narrow bridges/tests.
- Consumes: registry/resources/capabilities/permissions/lifecycle.
- Do not modify: runtime core/provider adapters.
- Dependencies: gate only.
- Done: MCP catalog → canonical tools, resource/Company isolation, explicit failures, common lifecycle.

## Chat F — Browser

- Branch: `feat/runtime-browser-tools`
- Ownership: `src/agent-tools/browser/**` + tests.
- Consumes: tool/permission/target/cancellation/lifecycle.
- Do not modify: runtime core/providers.
- Dependencies: gate only.
- Done: scoped browser lifetime, separate navigation/read/action capabilities, cancellation/timeouts, external/mutation permissions.

## Chat G — Provider adapters

- Branch: `feat/runtime-native-provider-adapters`
- Ownership: `src/agent-provider-adapters/**` + provider-adapter tests; narrow provider wire changes only if required.
- Consumes: provider/transcript/tool/decision/progress/capability contracts.
- Do not modify: native tools, `AgentRuntime`, Company/Project stores.
- Dependencies: gate only.
- Done: safe Claude/Codex Account adapters/no-tools modes, native translation where useful, exact identity, capability mapping, progress/error/cancellation, no hidden filesystem/shell/MCP execution.

## Chat H — UI panes/approvals

- Branch: `feat/runtime-ui-panes`
- Ownership: `app/src/**` + UI tests.
- Consumes: serialized transcript/lifecycle/result/decision/permission contracts.
- Do not modify: runtime core for visual work.
- Dependencies: UI states can develop after gate; final live wiring follows integration.
- Done: tool/progress/error/cancellation presentation, pause/decision/approval UI, assigned reasoning/attachment display, required real-Electron visual verification.

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

The remaining intentional sequential stage is **product composition/integration**, not shared-contract design.

After parallel PRs are ready, a narrow integration branch should register tools/adapters/lifecycle consumers and migrate Chat/Cowork entrypoints using the frozen contracts.

---

# Validação

Required merge validation:

```bash
npm run release:validate
npm run check
```

`npm run check` includes release validation, TypeScript build, Vite build and the full Node/tsx suite.

Gate-focused tests:

- `test/agent-runtime.test.ts`
- `test/agent-runtime-decisions.test.ts`
- `test/agent-session-context.test.ts`
- `test/inference-provider-agent-adapter.test.ts`
- `test/agent-capabilities.test.ts`

Coverage includes:

- two provider adapters under one runtime/tool protocol;
- Account/API-key auth under one architecture;
- unsafe hidden-provider-tool rejection;
- structured decision fallback with zero tools;
- provider/model capability taxonomy and model override narrowing;
- provider/admin capability denial;
- PR #75 Company snapshot → immutable session mapping;
- legacy organization metadata unable to override canonical ownership;
- cross-Company Project/Connection/Session rejection;
- shared local Connection semantics;
- provider-neutral tools;
- explicit capability refusal;
- provider-independent lifecycle;
- cancellation/timeout;
- mutation retry safety;
- provider and permission decision pauses;
- decision resolution;
- reasoning-summary/attachment metadata;
- no silent provider/model/execution-target substitution.

PR CI on the final head is the source of truth.

Only after required CI is green should this PR be merged and A–H be opened from the resulting `main`.
