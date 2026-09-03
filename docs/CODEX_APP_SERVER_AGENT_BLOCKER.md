# ChatGPT/Codex Account AgentRuntime blocker

Reviewed: **2026-09-03**.

Upstream Codex baseline inspected: **0.153.0** (`rust-v0.153.0`).

## Decision

ChatGPT/Codex Account remains **fail-closed** for `AgentRuntime`.

Codex app-server v2 now exposes the correct interception mechanism for caller-defined dynamic tools, but its current protocol does not provide a contractual way to make the model-visible executable tool catalog equal **exactly** the tools supplied by Axis. Axis therefore cannot yet prove that filesystem, shell, MCP, or another provider-managed tool will never execute behind the canonical runtime boundary.

No `codex exec` workaround is used. No read-only sandbox, approval policy, profile/config flag, neutral working directory, or post-hoc event parser is treated as equivalent to pre-execution interception.

## Version actually used by Axis

Axis does not vendor or pin a Codex package in `package.json`. `CodexAccountRuntime` launches the external `codex` executable and discovers its version with `codex --version`. Each ChatGPT Account profile receives its own `CODEX_HOME`; ambient OpenAI credentials are removed from the subprocess environment.

Consequently, there is no single repository-pinned Codex version to claim as the local installation. This review uses upstream stable **0.153.0**, published on 2026-09-03, as the compatibility baseline. A future adapter must still verify the installed protocol/version before enabling behavior that depends on a newly added isolation guarantee.

## App-server v2 lifecycle investigated

The current native protocol provides the pieces required for a first-class integration:

1. start `codex app-server` in the selected account profile environment;
2. send `initialize`, then `initialized`;
3. create a thread with `thread/start`, including the selected `model` and caller-defined `dynamicTools`;
4. start work with `turn/start`;
5. consume streamed item/turn notifications;
6. when the model selects a caller-defined dynamic tool, receive the server-to-client request `item/tool/call` **before that dynamic tool is executed**;
7. return the tool result to Codex so the same turn can continue;
8. cancel an active turn with `turn/interrupt`.

That `item/tool/call` handshake is compatible in principle with:

`Codex dynamic tool -> AgentProviderAdapter -> canonical ToolCall -> AgentRuntime -> AxisTool -> ToolResult -> item/tool/call response`

It is not sufficient by itself, because it applies only to the dynamic tools supplied by the client.

## Why 0.153.0 is still unsafe for the Axis runtime

### 1. No exact model-visible tool allowlist

The app-server protocol accepts `dynamicTools`, but it does not expose a documented `dynamicToolsOnly`, `disableBuiltInTools`, or equivalent exact allowlist that guarantees those dynamic tools are the model's only executable tools.

The required Axis invariant is stronger than “our tools can be intercepted”:

`model-visible executable tools == request.tools`

Without that equality, a provider-specific tool can bypass capability, permission, Company, Project, mutation-safety, lifecycle, and audit handling in `AgentRuntime`.

### 2. Core tools are assembled independently from dynamic tools

In the Codex 0.153.0 source, `codex-rs/core/src/tools/spec_plan.rs` builds the core tool registry independently of client dynamic tools. The normal core path includes separate sources for shell, MCP resources, utility tools, and collaboration tools. Utility registration can also add `apply_patch` when an execution environment and model support are present.

Dynamic tools are appended to that registry; they do not replace it.

This means support for `item/tool/call` proves interception of **Axis-supplied dynamic tools**, not the absence of other model-visible tools.

### 3. Native approvals are authorization, not Axis execution delegation

The app-server has separate server-to-client approval flows such as:

- `item/commandExecution/requestApproval`;
- `item/fileChange/requestApproval`;
- `item/permissions/requestApproval`;
- MCP elicitation/approval flows.

For command/file flows, the client answers an approval request and Codex remains the executor. That is materially different from returning a canonical `ToolCall` for `AgentRuntime` to authorize and execute through an `AxisTool`.

Axis cannot approve those requests and then pretend the resulting provider mutation was an Axis `ToolResult`.

### 4. Reduced authority is not the same as tool isolation

The following are explicitly rejected as the security boundary for this adapter:

- `codex exec --sandbox read-only`;
- `approvalPolicy=never`;
- `features.shell_tool=false`;
- experimental `environments=[]`;
- running Codex from an empty/neutral `cwd`;
- disabling or omitting known MCP servers in one profile;
- detecting `commandExecution` / `fileChange` only after provider execution starts or finishes.

Some of those controls are useful defense in depth. None is a protocol-level proof that every model-visible executable tool is delegated to Axis before execution across the selected Account, model, managed configuration, and future Codex releases.

## What would unblock the adapter

Any upstream mechanism is sufficient if it is explicit, stable enough to verify, and enforces the invariant before the model turn begins. Examples:

- a thread/turn option whose contract guarantees an **exact tool allowlist** and permits only the supplied dynamic tools;
- a `disableBuiltInTools=true` / dynamic-tools-only mode that also excludes shell, file/apply-patch, MCP, plugin, collaboration, hosted, and other executable provider tools;
- client-executor takeover for every model-visible core tool, so each request is delivered before execution and can be translated into a canonical Axis `ToolCall`;
- another official protocol surface with equivalent guarantees.

Once such a guarantee exists, the adapter can safely add exact Connection/profile/model/Company binding, neutral cwd, sanitized environment, transcript translation, streamed text/reasoning summaries/progress, dynamic tool-call ID preservation, result continuation in the same turn, cancellation, timeout, error mapping, and installed-version capability detection without changing `AgentRuntime`.

## Current testable contract

`src/agent-provider-adapters/chatgpt-account.ts` exports `CODEX_APP_SERVER_ISOLATION_BASELINE` so tests pin the reason for the fail-closed decision rather than merely matching a generic error string. The evidence records:

- upstream review baseline `0.153.0`;
- app-server v2;
- supported dynamic-tool interception through `item/tool/call`;
- absence of a proven exact model-visible allowlist;
- absence of a dynamic-tools-only mode;
- the distinct provider-managed approval/request surfaces that prevent claiming Axis-only execution.

`createChatGptAccountAgentAdapter()` therefore continues to throw `AgentProviderProtocolError`. Resolved-connection composition cannot silently fall back to an API key, another Account, another provider, or another model.

## Upstream references inspected

- OpenAI Codex App Server documentation: native lifecycle, `thread/start`, `turn/start`, `turn/interrupt`, dynamic tools and server requests.
- `openai/codex` tag `rust-v0.153.0`:
  - `codex-rs/core/src/tools/spec_plan.rs` — independent core tool registration;
  - `codex-rs/core/src/tools/handlers/dynamic.rs` — dynamic-tool handshake;
  - `codex-rs/app-server-protocol/src/protocol/v2/` — app-server v2 request/event surface.

The blocker should be re-reviewed against the installed/upstream Codex protocol when one of the required isolation mechanisms becomes available.
