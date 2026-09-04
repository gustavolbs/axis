# Changelog

All notable changes to Axis are recorded here. The format follows Keep a Changelog and the app version follows Semantic Versioning.

## [0.24.1] - 2026-09-03

### Changed
- Reworked the Chat model selector into `Connections` and `Models`: connections show the configured name (or provider fallback) with explicit authentication badges, while models show normalized names/versions and concise task-fit descriptions.

### Fixed
- Fixed Connection authentication badges being flattened to the generic gray status-pill style; API Key now renders blue, Account amber, and Local green while preserving the existing three-stylesheet/CSP-safe renderer contract.
- Simplified recognized ChatGPT/Codex Account usage-limit failures before they reach the UI, stripping CLI banners, workdir/model/session metadata, duplicated provider output, system instructions, and upgrade/credits noise while preserving the provider-supplied retry time.
- Fixed OpenAI API-key Chat structured responses so the strict `axis_agent_turn` schema satisfies Structured Outputs for every required property, including nullable optional fields and JSON-encoded tool arguments.
- Restored normal Chat for ChatGPT Personal Account in Company Personal, including Personal Projects, through the inference-only direct account transport instead of the canonical AgentRuntime tool loop.
- Propagated cancellation to Claude Account and ChatGPT/Codex Account transports so Stop reaches the provider process.
- Reconciled Anthropic API-key structured output with the provider-neutral strict response envelope and retained regression coverage for account routing, provider/model presentation, schema strictness, and cancellation.

### Security
- The direct ChatGPT Personal Account compatibility path is limited to normal Chat in Company Personal. Cowork and non-Personal ChatGPT/Codex AgentRuntime flows remain fail-closed until provider-native executable tools can be intercepted safely before execution.

## [0.24.0] - 2026-09-03

### Added
- Added permanent Company-context deletion with confirmation and fail-closed resource checks, plus Company-scoped Add Project actions and project ownership reconciliation.
- Added searchable MCP management in each Company, including connector identity marks, explicit health/auth status, refresh/reconnect actions, and custom remote MCP registration for Claude and ChatGPT/Codex accounts.
- Added Company / Project / conversation breadcrumbs for Project chats while keeping Project and Company scope owned by shell navigation rather than duplicated composer selectors.

## [0.23.4] - 2026-09-03

### Fixed
- Restored the Work Hub Calendar as a seven-day weekly time-grid agenda with all-day events, timed positioning, overlap lanes, week navigation, and a current-time marker while preserving Company scope and provenance.
- Fixed calendar event detail tooltips so the hovered or keyboard-focused SVG event paints above neighboring event blocks instead of rendering its tooltip underneath them.
- Fixed Work Hub calendar timezone drift by preserving offset-qualified source instants, rejecting ambiguous timed timestamps without an explicit UTC offset, rendering conversion only in the device timezone, and invalidating stale pre-fix calendar caches before re-sync.
- Calendar sync date windows now use the machine's local calendar date instead of UTC date slicing, preventing the requested range itself from shifting around local evening hours.

## [0.23.3] - 2026-09-03

### Added
- Added an Archived search field using the same compact search control as Projects, filtering archived chats and projects by title/name, workspace, Company, and original chat goal while preserving pagination and restore/delete actions.
- Added an Anthropic-only wire adaptation that closes every object schema as required by Claude structured outputs while JSON-encoding open tool arguments and restoring them to canonical objects before Axis tool dispatch, preserving provider-neutral runtime semantics and arbitrary tool arguments.
- Added regression coverage that verifies the Anthropic agent schema contains no open object schemas and that tool arguments round-trip back into the canonical Axis contract.

### Changed
- Archived search results reuse the existing Axis empty-state treatment when no items match instead of introducing a one-off search result surface.

### Fixed
- Fixed Anthropic API-key AgentRuntime turns failing with HTTP 400 on Claude Haiku 4.5 and other structured-output models because the canonical open `toolCalls[].arguments` object was sent directly as `additionalProperties: true`.

## [0.23.2] - 2026-09-03

### Changed
- Sidebar Contexts now use each Company’s configured icon and color and switching a Context updates the canonical desktop Company scope before Projects and conversations are loaded.
- New Chat is always projectless Personal Chat; Project conversations are started from their Project surface and no longer expose a redundant Project selector in the composer.
- Company Project pages now render Projects using canonical Company ownership and expose Add Project directly from Overview and Projects.

### Fixed
- Fixed project creation being silently forced into a stale Personal scope, which could produce the “workspace is already assigned” cross-Company conflict when the UI appeared to target a Company.
- Removed duplicate Company selectors from the titlebar, composer, approval flow, and assistant results.
- Wired chat and Project pin actions to persistent local pin state and sort pinned items first in sidebar/project listings.

## [0.23.1] - 2026-09-03

### Added
- Added the P1 multi-company end-to-end gate report with an acceptance-by-acceptance distinction between real product evidence, module/fixture evidence, and unresolved blockers.
- Added a focused `npm run p1:gate` regression command spanning product runtime composition, Git, runtime security, Project Memory, provider adapters, the accepted Codex Account blocker, and Runtime UI contracts.

### Changed
- Product AgentRuntime composition now fails closed by withholding managed-worktree tools until a task-specific managed worktree checkout can be composed as an exact immutable session root. Direct provider-neutral Git worktree tools remain available to the lower-level Git runtime and keep their existing ownership/isolation coverage.
- Updated the Codex/Claude Desktop parity document with the real P1 gate result instead of treating merged foundations or mock/fixture coverage as completion.

### Fixed
- Fixed a product integration mismatch where Cowork could advertise managed-worktree tools even though its immutable product session contained no authorized worktree storage/task-checkout root capable of satisfying those tool contracts.
- Fixed the API Key lifecycle Electron smoke so it validates the current cloud-provider network boundary: unsafe loopback/insecure endpoints must fail closed before any request, while edit/rotation/sibling isolation remain verified through UI and Keychain state.

### Security
- P1 remains explicitly FAIL rather than silently falling back: product-level worktree orchestration, durable restart checkpoints, real Local Worker execution-target composition, the accepted ChatGPT/Codex Account G2 blocker, and live multi-Connection evidence remain blockers.

## [0.23.0] - 2026-09-03

### Added
- Added a persistent Company/Project-aware runtime policy engine with normalized `plan`, `ask-before`, `workspace-write`, `auto`, and explicit `full-access` authority modes across filesystem, process, Git, MCP, browser/network, destructive operations, and external side effects.
- Added deny-wins one-shot Runtime UI approval binding to the exact session, Company, tool, and raw-argument fingerprint so approvals cannot cross sessions/Companies, be replayed, or override a Company/Project deny.
- Added a canonical secret-free Effective Context representation derived from the same immutable `AgentSessionContext` and runtime policy engine used for execution, including Company, Project, Connection/auth kind, model, target, roots, MCP resources, permissions, rules, and network protections.
- Added security audit primitives for permission requests/results, policy decisions, decision requests/resolutions, tool mutations, external actions, runtime errors, and the effective Company/Project/Connection/model/target authority that produced each event.
- Added a transversal runtime redaction layer shared by lifecycle/UI-facing events, errors, audit data and Project Memory, covering common API keys/tokens, authorization/cookies, passwords, private keys, credential-bearing URLs, known credential fields and secret references.
- Added focused CHAT J regression coverage for all 15 multi-company security invariants, including monotonic policy overrides, network redirect bypass, cross-Company MCP refusal, process secret filtering, external-content non-authority, Effective Context equivalence, shared-local Connection isolation and destructive authority.

### Changed
- Browser navigation, provider HTTP, native MCP HTTP/SSE and Local Worker HTTP now share one outbound network authorization boundary instead of maintaining separate host/redirect checks.
- Native MCP Streamable HTTP and legacy SSE re-authorize every redirect/derived endpoint; legacy SSE message endpoints must stay on the configured server origin.
- Product Chat/Cowork composition now uses `RuntimePolicyPermissionGate` instead of the earlier product-only approval gate, and lifecycle events are redacted before Runtime UI, Project Memory and security-audit fan-out.
- Project Memory now delegates secret-pattern redaction to the transversal runtime redactor rather than maintaining an independent implementation.

### Security
- Company, Project and trusted-session policy composition is monotonic: narrower scopes may reduce authority but cannot widen a parent scope, and `deny` wins over `ask` and `allow` even after an attempted user approval.
- Repository files, browser/web content, MCP results, provider content and tool output are explicitly treated as data rather than authority; they cannot change Company/Project/Connection/model/target/root, enable tools/MCPs, alter network policy, grant permission or approve mutations.
- Outbound HTTP(S) rejects credential-bearing URLs and metadata services, requires explicit opt-in for loopback/private/link-local/reserved targets, re-authorizes every redirect hop and strips sensitive headers on cross-origin redirects.
- Cloud provider HTTP remains public-HTTPS-only, Ollama receives only its explicit loopback HTTP exception, and Local Worker network reach is narrowed to the explicitly configured worker hostname.
- Shared local Connections remain shared transport/inference capabilities only; runtime policy is still resolved from the active Company and never becomes shared Company authority.

## [0.22.0] - 2026-09-03

### Added
- Routed real Chat and Cowork product sessions through the same canonical `AgentRuntime` composition, with immutable Company/Project/exact Connection/model/execution-target authority and dynamically scoped filesystem, process, Git, MCP and browser tools.
- Connected real provider/tool/read/mutation/command/validation/error/cancellation/pause/completion lifecycle events to the Agent Runtime UI, while Project Memory now receives and retrieves lifecycle context from the real product path.
- Added canonical approval/resume composition that pauses before tool execution and binds a resumed approval to the pending tool name and argument fingerprint so a local mutation cannot be silently duplicated.

### Changed
- `StandaloneJobManager` is now the durable conversation/API compatibility shell for desktop Chat/Cowork instead of the product execution engine; `AgentRuntime` is the canonical engine. The legacy execution runtime remains only for worker health/settings and unrelated compatibility surfaces.
- Chat can use the same runtime tools when its session authorizes them, while Cowork gets broader repository mutation/process/Git authority from roots, resources, capabilities and permissions rather than a second engine or a predeclared editable-file plan.

### Security
- Product session Company ownership is resolved from the canonical Company graph before provider transport resolution; workspace paths, display labels, provider family, account identity, API-key identity and legacy organization metadata do not select Company.
- Product execution never silently substitutes another Company, Connection, model or execution target. ChatGPT/Codex Account remains fail-closed under the accepted G2 blocker until provider tool calls can be intercepted safely before execution.
- Tool catalogs are reduced to the capabilities, permissions and resources actually bound to the immutable session, including read-only Chat roots and Company/Project-scoped MCP resources.

## [0.21.1] - 2026-09-03

### Added
- Added a source-backed Codex app-server v2 isolation review, validated against upstream Codex 0.153.0, that records the native `item/tool/call` dynamic-tool handshake, cancellation path, and the exact protocol capability still required before ChatGPT/Codex Account can enter `AgentRuntime` safely.
- Added regression coverage that pins the current Codex protocol evidence instead of relying only on a generic fail-closed error string.

### Security
- ChatGPT/Codex Account remains fail-closed for the canonical runtime. App-server v2 can intercept client dynamic tools, but it does not expose a proven exact model-visible tool allowlist or dynamic-tools-only mode; provider-managed command, file/`apply_patch`, MCP, permission and other core tool flows are assembled independently from `dynamicTools`.
- Axis does not treat `codex exec`, read-only sandboxing, `approvalPolicy=never`, `shell_tool=false`, experimental `environments=[]`, a neutral cwd, provider approvals, or post-hoc mutation parsing as substitutes for pre-execution canonical `ToolCall` interception. No API-key, Account, provider, model, or Company fallback was added.

## [0.21.0] - 2026-09-03

### Added
- Added provider-neutral Git runtime tools for exact-root status, working/staged/branch/commit diffs, branch/upstream metadata, bounded commit metadata, explicit branch creation, literal stage/unstage, and managed worktree create/list/remove through canonical `AxisTool` contracts.
- Added `axis.git.read`, `axis.git.write`, and `axis.git.worktree` capability boundaries with `git.read`, `git.write`, and `git.worktree` permissions, canonical progress/activity, mutation status, cancellation, and provider-neutral runtime coverage.
- Added isolated managed worktrees under a separate authorized session root with Axis-derived IDs and immutable-session ownership locks, plus bounded cleanup for partial creation and explicit cleanup of dirty managed worktrees.

### Security
- Git repository selection now requires an explicit session `rootId` that resolves exactly to the Git checkout top-level and matches immutable Company/Project scope; nested implicit repository discovery, cross-Company roots, path traversal/pathspec magic, and arbitrary worktree destinations are denied.
- The source checkout is never switched, reset, cleaned, or reused as a managed worktree destination. Worktree listing filters unauthorized paths, removal verifies same-repository/session ownership, and uncertain mutating failures remain non-safe to retry.
- Git commands run through the shared shell-free process runtime with cancellation, bounded output, a sanitized non-interactive environment, and optional-lock suppression for read-only commands.

## [0.20.0] - 2026-09-03

### Added
- Added provider-neutral Axis browser tools for explicit navigation, page reads, isolated session state, bounded DOM/form inspection, developer diagnostics, opaque screenshot references and explicit DOM interaction, each behind its own capability/permission boundary where appropriate.
- Added an explicit browser backend/session contract plus a built-in read-only fetch backend with HTTP(S) navigation, redirect handling, text/HTML/link extraction, bounded search, static DOM/forms inspection and observable session state, so future Electron/CDP or Local Worker implementations can connect through `ToolRegistry` without runtime or provider-adapter changes.
- Added a reusable browser navigation policy with host allow/block rules, default protection against loopback/private/link-local/metadata targets and redirect re-authorization, allowing Company/Project composition to narrow browser reach without provider-specific code.
- Added browser-runtime coverage for reads/navigation, host/redirect policy, prompt-injection provenance, DOM/forms, state, developer/screenshot boundaries, navigation failures, timeout, cancellation, permissions, provider independence, Company/session isolation and explicit no-fallback behavior.
- Added a provider-neutral Agent Runtime activity timeline that projects the frozen lifecycle protocol into running/provider progress, tool progress, read, mutation, command, validation, error, cancellation, pause and completion states without provider-specific UI semantics.
- Added canonical approval and decision surfaces for permission requests and `AgentDecisionRequest`, including accessible native progress controls, attachment metadata rendering and keyboard-operable responses.
- Added reusable runtime evidence panes prepared for filesystem, process, Git, MCP and browser integration, plus isolated canonical lifecycle fixtures for integration and visual verification without inventing new backend contracts.
- Added Agent Runtime UI contract tests and real-Electron visual smoke coverage for light/dark themes, narrow layout, keyboard focus, pane navigation, progress, decision/approval resolution and failure states.
- Added Company-bound native `AgentProviderAdapter` composition for OpenAI API Key, Anthropic API Key, Ollama, and Claude Account connections without changing the canonical `AgentRuntime` or Axis tool contracts.
- Added a provider-neutral structured Account protocol that translates canonical messages, attachment metadata, summarized reasoning, tool definitions/calls/results, decision requests, stop reasons, progress, errors, cancellation, and exact model identity at the provider boundary.
- Added adapter tests covering API Key and Account authentication in the same runtime, OpenAI and Anthropic provider families, capability negotiation, canonical tool-call roundtrips, hidden-tool rejection, cancellation, provider errors, exact no-fallback model selection, Ollama local scope, Company ownership preservation, and the explicit fail-closed ChatGPT/Codex Account blocker.
- Added provider-agnostic filesystem tools for bounded file reads, directory listings, metadata/stat inspection, glob/file search, text search, atomic file creation/replacement, and exact text edits through the unified `AxisTool` runtime contract.
- Added namespaced `axis.filesystem.read` and `axis.filesystem.write` capabilities with existing `workspace.read`/`workspace.write` permission gates, progress/activity reporting, per-tool timeouts, explicit mutation status, SHA-256 conflict detection, binary-file handling, and `.gitignore`-aware search.
- Added focused runtime tests covering allowed roots, traversal and absolute-path refusal, symlink escapes, Company/Project isolation, read-only roots and denied permissions, cancellation, mutations, explicit filesystem errors, search behavior, and provider-neutral execution through different fake adapters.
- Added the provider-agnostic `process_exec` Axis tool and reusable process runner for `axis.process.exec`, with explicit session-root/cwd scoping, argv-only execution, separate bounded stdout/stderr, incremental tool progress, exit codes and canonical command lifecycle activity.
- Added cross-platform process-tree cancellation: POSIX executions use an isolated process group with TERM/KILL escalation and Windows executions terminate descendants through `taskkill /T /F`.
- Added session-owned background process lifecycle tools: `process_start`, `process_poll`, `process_wait`, `process_stdin`, `process_signal`, `process_terminate` and `process_list`. Background commands expose stable process IDs, incremental cursor-based output, explicit retention gaps, bounded stdin, controlled signals and final mutation status without requiring a PTY.
- Added `process_which` diagnostics for the exact executable PATH visible to Axis plus a `createProcessTools()` suite so Git, validation and later runtime composition can reuse one policy/environment/registry boundary instead of inventing process execution separately.
- Added process runtime coverage for successful and non-zero commands, timeout, tree cancellation, cwd escapes, environment filtering, exact execution-target selection, command lifecycle, permission denial, mutation status, read-only fail-closed policy, provider/auth independence, background process isolation, cursored/truncated logs, wait cancellation, stdin, signals and session cleanup.
- Added provider-neutral Project Memory capture from the canonical runtime lifecycle with deterministic per-Company/per-Project storage, structured session summaries, bounded activity/evidence, root-scoped repository summaries, rolling high-signal handoffs, recent failure/cancellation context and canonical retrieval for later sessions.
- Added provider/auth/session-independence coverage for shared Project Memory, plus hard isolation tests for cross-Company/cross-Project/same-root scopes, same-origin clone identities, dirty-worktree freshness and runtime restart recovery.
- Added structured Account runtime regression coverage for Claude and ChatGPT/Codex subscription authentication, profile-scoped config directories, redaction, secret-free metadata, safe MCP management, exact model selection, cancellation, timeouts, missing-runtime failures and official CLI structured-output plumbing.
- Added a common provider capability taxonomy and model-aware negotiation layer across API Key, Account and Ollama adapters, including conservative defaults, explicit model narrowing, fail-closed unknown support and canonical session capability freezing.
- Added the first local-provider-backed canonical AgentRuntime integration tests so the same provider-neutral runtime and filesystem tool contract are exercised through both OpenAI API Key and Ollama-style providers without provider-owned tool execution.
- Added deterministic timeout/cancellation and mutation safety semantics across AgentRuntime tool execution, including explicit non-safe retry treatment for uncertain mutations.
- Added process environment sanitization, exact session root checks and subprocess ownership boundaries for shell-free process execution.

### Security
- Browser sessions are bound to the immutable runtime session/Company and cannot be reused across Companies even if session IDs collide. Browser content is marked untrusted and cannot mutate runtime authority.
- Browser navigation blocks credential-bearing URLs and rejects loopback, private, link-local and metadata targets unless explicitly allowlisted; every redirect is re-authorized before the next request and cross-origin auth-like headers are stripped.
- Fetch-only browser backends fail interaction, screenshot and developer tooling explicitly; Axis never silently falls back to Computer Use or another execution surface.
- Filesystem tools refuse absolute paths, traversal, symlink escapes and cross-Company roots; writable operations require exact write-authorized roots and deny read-only session roots.
- Process tools run argv-only without a shell, require an exact authorized cwd/root, strip ambient secrets, refuse arbitrary environment overrides, and require canonical permissions before mutation.
- Managed background processes are scoped to the immutable runtime session, bounded in output/retention, and cannot be addressed or terminated from another session.
- Provider adapters reject hidden provider-native tool calls before canonical Axis dispatch, preserve exact model/Connection identity, propagate cancellation, and never silently switch provider/model/Company.
- ChatGPT/Codex Account stays fail-closed in canonical AgentRuntime until every provider-managed core tool can be intercepted before execution; read-only sandboxing, `approval=never`, app-server approval events and post-hoc output parsing are not treated as substitutes.

## [0.19.0] - 2026-09-02

### Added
- Added provider-neutral MCP tools and resources for native HTTP Streamable MCP, native legacy SSE MCP, Claude Account and ChatGPT/Codex Account sources through one canonical `AxisTool`/`AgentResource` runtime surface.
- Added Company-scoped MCP catalog discovery with exact Connection ownership, sensitive config reference-only handling, per-tool timeout, cancellation, canonical protocol error mapping, mutation-safe retry semantics and common lifecycle telemetry.
- Added Work Hub-backed MCP server adapters for normalized Jira, Slack, Teams and Calendar data plus explicit source-owned authentication boundaries.

### Security
- MCP resources remain Company/Connection scoped and fail closed when ownership is missing or ambiguous. Sensitive auth/config values stay behind source-owned references and never enter model-visible tool definitions.
- Remote MCP URLs are normalized, require HTTPS, reject embedded credentials and never inherit arbitrary provider credentials.

## [0.18.0] - 2026-09-02

### Added
- Added standalone multi-Company Contexts with explicit immutable IDs, editable names/descriptions/icons/colors, Personal as a reserved built-in Context, persistent ordering/search/archive/restore, safe empty-Company deletion, and canonical active-Company selection across restart.
- Added Company-scoped Connection ownership with stable bindings independent from mutable provider account organization metadata, plus Company-aware Project/job filtering and cross-Company action guards.
- Added Company Context UI navigation, Company Hub, scoped Project and Connection surfaces, and Work Hub Company filtering while removing redundant global Company selectors from Settings and Chat.

### Security
- Company identity is derived from canonical bindings and active Context, never from workspace paths, provider labels, account display metadata or request-body claims. Personal remains reserved and cannot be repurposed as a normal Company.

## [0.17.0] - 2026-09-02

### Added
- Added persistent project-less Personal Chat history and explicit Personal provider catalog isolation from organization-owned credentials.
- Added per-Connection subscription account profiles and exact API-key Connection identities in Personal Chat, including multiple credentials for one provider family without ambiguous legacy fallback.
- Added provider-neutral Personal Chat model discovery and invocation across current/future providers plus Ollama without hardcoding a closed provider family list.

### Security
- Personal Chat catalog and history are scoped by canonical Company/session ownership and reject organization-owned API credentials and subscription accounts even when provider families match.

## [0.16.0] - 2026-09-02

### Added
- Added provider-neutral cloud model discovery, direct inference, token usage, pricing, spend policies and Personal/Project catalog surfaces for OpenAI, Anthropic and future registered cloud providers.
- Added explicit stable provider-account profiles for Claude and ChatGPT/Codex subscription accounts, with isolated config directories and provider-owned login/status/MCP management.
- Added personal Chat model selection across API Key, Claude Account, ChatGPT Account and Local/Ollama identities.

### Security
- Cloud API credentials remain in their configured secret backend and provider-account session credentials remain in provider-owned profile directories; neither is persisted into project/runtime metadata.

## [0.15.0] - 2026-09-01

### Added
- Added the standalone desktop shell with persistent sidebar navigation, Chat/Cowork composer, provider/model picker, usage/settings surfaces, and packaged macOS support.
- Added local/remote execution settings, isolated provider account profiles, and provider connection management.

### Security
- Desktop renderer remains sandboxed behind a narrow preload bridge and restrictive CSP; external HTTPS links are opened in the system browser.
