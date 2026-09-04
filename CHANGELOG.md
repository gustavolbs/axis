# Changelog

All notable changes to Axis are recorded here. The format follows Keep a Changelog and the app version follows Semantic Versioning.

## [0.24.2] - 2026-09-04

### Fixed
- Project model catalogs now inherit first-class inference Connections from the owning Context instead of treating legacy Project allowlists as the source of truth.
- Personal Connections are available in Personal Projects and are reusable from Company Projects, while sibling Company Connections remain isolated.
- Project Chat and Cowork receive the same Context-derived Connection visibility; mode differences remain capability concerns rather than Connection ownership boundaries.
- Unified the connection picker presentation: the Project overview now shows the same colored auth badges (API Key blue, Account amber, Local green) as New Chat, and both surfaces show the connection description line.
- Model catalogs (`/chat/catalog` and `/projects/:id/catalog`) are cached for 30 seconds with in-flight deduplication, so reopening the connection picker no longer re-runs live model discovery; any in-app mutation clears the cache immediately.
- Fixed Claude Account chat failing with "Not logged in · Please run /login": the AgentRuntime transport invoked Claude Code with `--bare`, which never reads keychain OAuth credentials. It now uses `--safe-mode --strict-mcp-config`, which keeps the same customization/MCP isolation while allowing the profile's Account auth.
- Turn-level Claude CLI failures reported inside a zero-exit result envelope (`is_error: true`) now surface as real errors with reconnect guidance instead of rendering the raw JSON envelope as a chat reply.
- The Claude CLI result envelope is now located line-by-line, so MCP diagnostic output on stdout no longer breaks response parsing.

### Security
- Delegating a Personal inference identity into a Company Project preserves the Project's canonical Company scope and never re-homes the Connection or permits sibling-Company access.

## [0.24.1] - 2026-09-03

### Added
- Added real-Electron Project overview smoke coverage for the existing pin, shared composer, inline model selector, compact rail, project action menu, light/dark themes, and narrow-window overflow behavior.

### Fixed
- Repaired the Project overview without changing Axis Project pin semantics: the existing pin remains persistent, the composer/context folder controls open the real folder picker, instruction cancellation restores the saved value, and project rename/archive/delete actions are now reachable from the header menu.
- Replaced the Project-only Model & connections dialog with the same inline model-selector presentation used by New Chat. Project model choices now come from the Project catalog and open as the existing composer popover instead of exposing the Connection-policy matrix from the overview.
- Removed decorative Context search and Scheduled-task controls from the overview instead of shipping a client-only scheduler that bypasses the planned local Automation architecture.
- Stabilized the Company/Work Hub visual smoke by waiting for the global Company filter transition before opening Sources.
- Fixed Connection authentication badges being flattened to the generic gray status-pill style; API Key now renders blue, Account amber, and Local green while preserving the existing three-stylesheet/CSP-safe renderer contract.
- Simplified recognized ChatGPT/Codex Account usage-limit failures before they reach the UI, stripping CLI banners, workdir/model/session metadata, duplicated provider output, system instructions, and upgrade/credits noise while preserving the provider-supplied retry time.
- Fixed OpenAI API-key Chat structured responses so the strict `axis_agent_turn` schema satisfies Structured Outputs for every required property, including nullable optional fields and JSON-encoded tool arguments.
- Restored normal Chat for ChatGPT Personal Account in Company Personal, including Personal Projects, through the inference-only direct account transport instead of the canonical AgentRuntime tool loop.
- Propagated cancellation to Claude Account and ChatGPT/Codex Account transports so Stop reaches the provider process.
- Reconciled Anthropic API-key structured output with the provider-neutral strict response envelope and retained regression coverage for account routing, provider/model presentation, schema strictness, and cancellation.

### Changed
- Reworked the Chat model selector into `Connections` and `Models`: connections show the configured name (or provider fallback) with explicit authentication badges, while models show normalized names/versions and concise task-fit descriptions.

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
- Added provider-neutral Project Memory capture from the canonical `AgentLifecycleSink`, with structured session handoffs for goals, repository reads and mutations, commands, validations, decisions, failures, cancellations and current work state.
- Added local atomic persistence and bounded task-ranked recovery partitioned by Company + Project + repository root fingerprint, with path/value sanitization, shared transversal secret redaction, retention limits, deterministic recent/trigram ranking and compact prompt-ready handoffs.
- Added explicit memory root-binding persistence keyed by Company + Project + repository fingerprint so later Project-scoped runs can recover prior root-specific handoffs before the current workspace has been read again.
- Added Project Memory regression coverage for Company/Project/root isolation, exact-root binding, redaction, retention, malformed-state fail-closed behavior, serialization bounds, retrieval ranking and semantic round-trip across process restart.
- Added provider-neutral browser/web search, file/URL attachment metadata, and document/image understanding contracts to `AgentRuntime`, with capability negotiation and explicit fail-closed behavior when unsupported.
- Added canonical web-search provenance metadata (`source=web`, URL, title, retrieved-at timestamp) so downstream assistant context can preserve that external content is data rather than authority.
- Added provider adapter coverage for built-in web search and attachment capability negotiation across OpenAI API Key, Anthropic API Key and account-style adapters, without provider-specific branches in `AgentRuntime`.
- Added MCP-backed browser search as a first-class runtime implementation alongside provider-native search, including timeout/cancellation-safe MCP calls, canonical normalized result validation, provider-neutral source preference/fallback order, and optional result-title/summary mapping from generic MCP content.
- Added a runtime UI `RuntimeEvidencePane` for structured Web / Images / Files provenance with safe external-link handling, compact hostname/media metadata, and no raw binary/base64 rendering.
- Added regression coverage for native-vs-MCP web-search preference, MCP-backed search execution, explicit unsupported search, attachment image/file capability negotiation, capability-only attachment fallback behavior and Runtime UI source projection.
- Added provider-agnostic stdio and HTTP MCP clients plus namespaced `axis.mcp.<server>.<tool>` wrappers so enabled MCP server tools can be exposed to `AgentRuntime` through the canonical `AxisTool` registry rather than provider-native MCP tool execution.
- Added `createMcpTools()` composition with per-session Company allowlists, exact server/tool/schema filtering, bounded outputs, cancellation, timeout and deterministic collision refusal across configured MCP servers.
- Added MCP tool discovery/call coverage for stdio and Streamable HTTP servers, notification handling, timeout/cancellation, canonical error propagation, malicious-name/schema rejection, cross-Company isolation, disabled-tool exclusion and provider-neutral execution through multiple adapters.
- Added Company/project-aware MCP resource registry storage for bearer tokens, OAuth references, custom headers, selected resources, access profiles, capability overrides, and project-level narrowed subsets without serializing secret values into runtime session metadata.
- Added operational MCP settings UI with create/edit/delete/enable flows for stdio, Streamable HTTP and SSE transports, plus Company-scoped server ownership, tool/resource selection, project access narrowing, runtime settings reload and safe inline status/error handling.
- Added Claude Desktop local MCP import using its canonical configuration path and `mcpServers` schema, preserving imported server names/commands/args/env as Axis MCP server definitions under explicit Company ownership without importing plaintext env secrets into project/runtime metadata.
- Added ChatGPT/Codex remote MCP import using Codex `config.toml` discovery and a bounded `[mcp_servers.*]` parser for remote URLs, bearer-token env references, custom HTTP headers and enablement, again requiring explicit Axis Company ownership.
- Added manual MCP configuration for local command servers and remote URL servers with configurable timeout, environment variables, bearer-token env references and custom headers so users can connect additional MCPs that are not discovered automatically.
- Added focused MCP settings regression coverage for desktop bridge discovery, Claude import, Codex import, manual create/edit/delete, Company ownership and secret-reference handling.
- Added MCP request-header secret references resolved from process environment or the existing credential vault at client composition time, allowing remote bearer/custom-header auth without writing resolved secrets to runtime metadata.
- Added Project MCP access-profile settings so enabled Company MCP tools/resources can be narrowed per Project through the canonical `project-mcp-access` policy map while Company ownership remains authoritative.
- Added one canonical `ProjectMcpPolicyStore` plus one canonical `mcp-access` lifecycle: project MCP access is stored once, surfaced through `/api/projects/:id/mcp-access`, and exposed in the Project UI without a second renderer-only copy.
- Added Company-owned MCP configuration in Company Hub with grouped Connected/Available server rows, server-kind/provider identity icons, explicit health/auth status, Add MCP discovery/import, refresh, reconnect and remove controls.
- Added real-Electron MCP visual smoke coverage for initial Project MCP state, persisted narrowing after save, and restored state after page reload.
- Added local-first automated regression gates for project-scoped MCP policy composition, settings lifecycle, desktop contract and MCP UI persistence.

### Changed
- Project-level MCP access is now edited from the Project overview beside other Project controls while MCP server administration stays Company-scoped.
- Company-scoped MCP access composes monotonically with Project MCP access: Project selection may only narrow the Company allowlist, resource set and access profile; it cannot widen Company authority.
- MCP request policy now rejects unsafe remote URLs (credentials in URL, non-HTTP(S), and non-local plaintext HTTP), validates custom headers, keeps bearer tokens out of persisted runtime metadata, and re-authorizes redirect-derived endpoints before use.

### Security
- MCP tools are exposed only after canonical Company ownership resolution and explicit server/tool allowlisting; Project scope may remove authority but cannot widen Company MCP capability.
- Provider-side MCP execution is not trusted as a policy boundary. Axis composes MCP tools itself and passes only the resulting canonical tool definitions through provider adapters.
- Imported MCP configuration never promotes source-file env values to Axis-owned plaintext secrets: sensitive auth stays as an environment or credential-vault reference resolved at request time.
- Remote MCP redirects cannot escape the original network authorization boundary; unauthorized redirect targets fail before credentials or custom headers are forwarded.
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
- Added a provider-neutral `AgentRuntime` with immutable session authority over Company, optional Project, exact Connection/model, execution target, roots, enabled MCP resources, capabilities, permissions, rules, and attached resource metadata.
- Added a typed canonical conversation/tool protocol with normalized messages, tool definitions/calls/results, lifecycle events, structured decisions, permission requests, validation events, cancellation, and session-scoped approval tokens.
- Added a minimal `AgentProviderAdapter` contract that exposes only provider/model/capability identity plus `runTurn()`, with a deterministic in-memory adapter proving the runtime is not coupled to Claude, OpenAI, Ollama, or Account transport details.
- Added deny-by-default `ToolRegistry` composition that omits unauthorized tools from the model-visible catalog, validates model tool calls against the exact session registry, enforces per-tool permissions before dispatch, and requires exact one-shot approval tokens before a gated tool can execute.
- Added a base runtime permission gate and a filesystem-root tool with canonical path containment checks, plus regression coverage for traversal and out-of-root access denial.
- Added deterministic automated coverage for normal conversation, tool execution, decision pauses/resume, permission pauses/resume, timeout, user cancellation, provider error, tool error, session isolation, and immutability.
- Added `docs/AGENT_RUNTIME.md` documenting ownership boundaries, provider-neutral contracts, lifecycle events, pause/resume semantics, tool safety, timeout/cancellation, failure rules, and extension points.
- Added the canonical Project Company-ownership contract: `companyId` is now the source of truth, creation requires an explicit non-archived Company, legacy organization metadata is mapped only through deterministic id equality, and projects reconcile fail-closed when ownership is ambiguous or missing.
- Added Company-tagged run summaries, run detail, conversation navigation, archived surfaces, and dashboard activity so Project-originated history exposes its owning Company across primary renderer views.
- Added local-automation parity foundations: a canonical versioned schedule/task store with typed recurrence, timezone/model/Connection/policy snapshot, task-pinned Company/Project execution, attempt/run history, missed-run handling, retry/backoff, deterministic `nextRunAt`, atomic writes, and migration seams.
- Added a serialized local automation runner with startup recovery, explicit Run now, pause/resume, overlap prevention, availability checks, transient-only retry, bounded exponential backoff with jitter, per-Company circuit breaker, wake-from-sleep detection, run-history retention, Company/Project/Connection/model/policy drift blocking, and structured notification events.
- Added read-only local Automation runtime/status endpoints plus task create/update/delete/pause/resume/run-now routes that keep schedule state Company/Project-owned rather than renderer-owned.
- Added project-scoped Automation settings UI for create/edit/delete, manual/hourly/daily/weekdays/weekly recurrence, timezone/model/Connection/policy capture, pause/resume, Run now, status, next/last run, retry/error visibility, and real runtime history while preserving the existing Project workspace surface.
- Added targeted Automation unit/runtime/UI coverage for recurrence, migration, ownership isolation, policy enforcement, missed-run startup semantics, retry/backoff, overlap prevention, invalid-recurring auto-pause, startup recovery, stale attempts, retention, notifications, CRUD/Run-now routing, restart persistence, Project UI controls, and concurrent mutation ordering.

### Changed
- Cloud/Account Project connections now require exact Company ownership, while local Connections remain the only intentional shared exception and never imply shared Company authority.
- Project execution now resolves runtime Connection/model policy through canonical Company-owned project policy instead of treating legacy Organization labels as ownership authority.
- Project scheduling no longer depends on the Axis window being open; the local main-process scheduler owns execution while the desktop app process is running, catches bounded missed runs after restart/wake, and surfaces stale/overlap/drift outcomes explicitly.

### Security
- Cross-Company Project/Connection reuse fails closed during project creation, runtime policy resolution, and project policy edits; local Connections are still permitted across Companies only as shared compute and remain scoped by the active Project/Company policy.
- Local Automation revalidates exact Company, Project, Connection, model, execution target, immutable schedule policy snapshot and current Project runtime authority before each attempt; cross-Company drift, missing resources, unsafe policy widening and unapproved Connection changes block execution instead of silently falling back.
- Company identity is derived from canonical bindings and active Context, never from workspace paths, provider labels, account display metadata or request-body claims. Personal remains reserved and cannot be repurposed as a normal Company.


## [0.17.0] - 2026-09-02

### Added
- Added persistent project-less Personal Chat history and explicit Personal provider catalog isolation from organization-owned credentials.
- Added per-Connection subscription account profiles and exact API-key Connection identities in Personal Chat, including multiple credentials for one provider family without ambiguous legacy fallback.
- Added provider-neutral Personal Chat model discovery and invocation across current/future providers plus Ollama without hardcoding a closed provider family list.
- Added Company as the canonical tenancy/context primitive, with persistent Company definitions, explicit Personal context, migration from legacy Organization metadata, archived lifecycle state, and deterministic ownership resolution for Projects, Connections, MCP servers, Skills, memory, runs, credentials, and Work Hub sources.
- Added a top sidebar Contexts switcher for Personal + active Companies, persisted current Company selection, dedicated Company Hub surfaces, and Company-scoped Projects, Connections, MCPs, Skills, and Settings with shared UI primitives.
- Added Work Hub as a global read-only operational aggregation across Companies, with Company filters and compact Today, Calendar, My Work, Inbox, and Sources views that preserve Company provenance on every row/item.
- Added a canonical Company-owned Work Hub source registry and local normalized cache for calendar, ticket/work, and message/inbox items, including durable per-source sync health/state, source removal, message read/dismiss state, retention policy, and Company reassignment checks.
- Added Claude-account Work Hub collection through the existing Claude CLI bridge for Company-owned calendar, ticket, and message sources, with strict JSON parsing, provenance tagging, and prompt/output-size bounds.
- Added source administration inside Company Connections, including Add source, Sync, Remove, Company ownership display, and Work Hub aggregation that cannot mutate or reassign source ownership.
- Added Company CRUD and lifecycle API routes plus `/api/companies/context`, Work Hub desktop bridge operations, and deterministic Company reconciliation during app startup/project/Connection/MCP lifecycle changes.
- Added product runtime Company resolution that fails closed for ambiguous/mismatched Project/Connection ownership and carries canonical Company identity into runtime sessions.
- Added Company-first Agent Runtime UI support and regression coverage showing Company/model/execution-target provenance in effective context, activity, permission decisions, evidence panes, chat messages, and multi-Company fixture states.
- Added real-Electron visual smoke coverage for Company navigation, Company Hub, Company-owned Work Hub source administration, Company→global Work Hub deep-linking, global source aggregation, Personal/Company filtering, and app-wide Settings isolation.

### Changed
- Project Memory now uses canonical `companyId` internally (with a deprecated Organization alias only for compatibility) and memory storage/retrieval remains Company + Project + repository-root scoped.
- Existing personal Project records are migrated into the Personal Company when ownership is deterministic; ambiguous legacy ownership fails closed instead of guessing a Company.
- Project/Connection UI labels still expose legacy Organization wording where needed for compatibility, but runtime and persistence authority comes from Company.
- Global Settings is restricted to app-wide General, Appearance, and Usage; Company-specific administration lives inside each Company Hub.

### Security
- Company boundaries are explicit authority boundaries: resources from one Company cannot be reused by another except for intentionally shared local compute, and labels/names never grant access.
- Work Hub aggregation is read-only and provenance-preserving; source add/remove/reassignment remains Company-scoped and cannot be performed from the global Hub.
- Personal Chat catalog and history are scoped by canonical Company/session ownership and reject organization-owned API credentials and subscription accounts even when provider families match.

## [0.16.0] - 2026-09-01

### Added
- Added one shared local HTTP runtime for the existing browser app and new Electron desktop shell, keeping existing API routes while exposing the same backend inside the standalone app.
- Added an Electron `BrowserWindow` + preload bridge with context isolation, sandboxing, hidden native menu, external-link delegation, restored bounds, persisted appearance, native folder selection, OS keyboard shortcuts, and no remote Node access in renderer.
- Added a Claude Desktop-inspired standalone shell with macOS-style titlebar/sidebar treatment, compact New chat / Projects / Runs / Archived navigation, profile footer, global search, notifications, create-project flow, Settings modal, project edit flow, and conversation unread/running states.
- Added GitHub Actions macOS packaging for Apple Silicon and Intel with unsigned `.app`, `.dmg`, and `.zip` artifacts plus gated release-time signing/notarization when Apple secrets are available.
- Added deterministic macOS artifact verification for Info.plist metadata, signing state, architecture, ASAR payload, DMG contents, and ZIP bundle structure.
- Added renderer/native-shell regression tests and real-Electron visual smoke coverage for the shell, project management, settings, profile, and application startup.
- Added provider-neutral cloud model discovery, direct inference, token usage, pricing, spend policies and Personal/Project catalog surfaces for OpenAI, Anthropic and future registered cloud providers.
- Added explicit stable provider-account profiles for Claude and ChatGPT/Codex subscription accounts, with isolated config directories and provider-owned login/status/MCP management.
- Added personal Chat model selection across API Key, Claude Account, ChatGPT Account and Local/Ollama identities.

### Changed
- The existing web server is now an optional diagnostics/dev wrapper around the shared runtime instead of the only product shell, and desktop launch is now the default `npm run app` entrypoint.
- Browser mode keeps fetch-based runtime transport; standalone Electron routes `/api/*` and `/api/events` through the preload bridge to the in-process runtime instead of binding a localhost control plane.
- macOS CI now builds/tests on ARM64 and also packages a separate Intel artifact for distribution.

### Security
- Cloud API credentials remain in their configured secret backend and provider-account session credentials remain in provider-owned profile directories; neither is persisted into project/runtime metadata.

## [0.15.0] - 2026-09-01

### Added
- Added the standalone desktop shell with persistent sidebar navigation, Chat/Cowork composer, provider/model picker, usage/settings surfaces, and packaged macOS support.
- Added local/remote execution settings, isolated provider account profiles, and provider connection management.
- Added a production OpenAI Responses adapter with configurable endpoint/API key/model/headers, normalized request mapping for text/file/image inputs, JSON-schema tools, tool-call/result messages, reasoning summaries, timeouts, cancellation, and canonical usage/finish/error metadata.
- Added a production Anthropic Messages adapter with configurable endpoint/API key/model/version/beta/max-token settings, normalized content/tool blocks, image/document inputs, `tool_use`/`tool_result` round-tripping, thinking blocks, usage/stop-reason mapping, and provider-native web-search capability negotiation.
- Added secure HTTP provider transports with loopback/private/credentialed-URL blocking, redirect revalidation, bounded response reads, timeout/user-cancel distinction, and upstream error normalization.
- Added focused adapter coverage for OpenAI and Anthropic request/response mapping, tools, attachments, reasoning, web search, provider errors, timeout, cancellation, network policy, and capability reporting.

### Security
- Desktop renderer remains sandboxed behind a narrow preload bridge and restrictive CSP; external HTTPS links are opened in the system browser.

## [0.14.0] - 2026-09-01

### Added
- Added P1 foundations for provider-neutral tool-calling Agent Runtime: a canonical runtime event protocol, normalized provider requests/responses, explicit Company/Project/Connection/model/session authority, and deny-by-default tool exposure.
- Added first-party tool capability contracts, permission gates, deterministic no-fallback routing, exact provider/model selection, and isolated run/session state needed for later runtime tools.
- Added Project Memory foundations with Company/Project/root scoped storage, lifecycle event capture, redaction, retention and bounded retrieval.
- Added base desktop UI for live Agent Runtime activity, provider-neutral evidence, decisions/approvals, and error/cancellation states.

## [0.13.0] - 2026-09-01

### Added
- Added canonical Company foundations and migration seams for replacing Organization as the tenancy primitive across Projects, Connections, Runs, Memory, MCPs, Skills and Work Hub.
- Added Company-scoped connection policy and provider routing with local compute as the only intentional shared exception.
- Added initial Company Hub and Work Hub navigation primitives behind the standalone desktop shell.

## [0.12.0] - 2026-08-31

### Added
- Added persistent desktop shell navigation, project gallery, project detail, runs, archived items, global search, settings, and profile surfaces on top of the existing local runtime.
- Added project-scoped Chat/Cowork entry, recent conversations, instructions, context folder, model routing, Connection policy editing, and Git review primitives.

## [0.11.0] - 2026-08-31

### Added
- Added the first standalone Electron shell for Axis with a local in-process runtime, preload bridge, sandboxing, context isolation, native folder picker, persistent appearance and window bounds, and macOS packaging foundations.

## [0.10.0] - 2026-08-31

### Added
- Added the initial React/Vite desktop renderer and local app runtime bridge used by the standalone Axis shell.

## [0.9.0] - 2026-08-30

### Added
- Added multi-provider model routing foundations for OpenAI, Anthropic, Ollama, Claude Account, and ChatGPT Account connections.

## [0.8.0] - 2026-08-29

### Added
- Added persistent Project configuration for workspace, instructions, routing, privacy, Connection policy, budgets, and concurrency.

## [0.7.0] - 2026-08-28

### Added
- Added first Project and job persistence stores plus local runtime APIs.

## [0.6.0] - 2026-08-27

### Added
- Added the initial local-first worker/runtime skeleton.

## [0.5.0] - 2026-08-26

### Added
- Added provider adapter and routing foundations.

## [0.4.0] - 2026-08-25

### Added
- Added initial app settings, credentials, and runtime state persistence.

## [0.3.0] - 2026-08-24

### Added
- Added early project/workspace concepts and basic API surfaces.

## [0.2.0] - 2026-08-23

### Added
- Added the first web UI scaffolding for local project/job workflows.

## [0.1.0] - 2026-08-22

### Added
- Initial Axis repository and local development setup.
