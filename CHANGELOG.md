# Changelog

All notable changes to Axis are recorded here. The format follows Keep a Changelog and the app version follows Semantic Versioning.

## [0.23.5] - 2026-09-03

### Added
- Added Project-scoped scheduled tasks with create/edit/delete, manual/hourly/daily/weekdays/weekly recurrence, pause/resume, Run now, and automatic overdue pickup while Axis is running.
- Added real-Electron Project overview visual smoke coverage for populated, scheduled-task dialog, light-theme, and narrow-window states.

### Changed
- Rebuilt the Project overview around the current Claude Cowork hierarchy: the composer and Recent conversations remain primary, while Instructions, Scheduled, Context, and Memory form the right-side project rail.
- Moved Axis-specific model and Connection policy administration out of the always-visible Project rail and into an explicit modal opened from the model control or project menu.
- Favorite projects now use a functional star state and sort ahead of non-favorites in the Projects gallery.

### Fixed
- Wired the Project overview controls for instructions, Context folder selection, Chat/Cowork submission, scheduled tasks, favorites, model/Connection configuration, rename, archive, delete, and recent-chat navigation instead of leaving decorative or incomplete controls.
- Removed the Project Git review and overflowing Connection-policy blocks from the overview so the page no longer corrupts its layout or exposes unrelated administration in the Claude-style project rail.

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
- Re-audited `docs/CODEX_CLAUDE_DESKTOP_PARITY.md` against merged PRs #75–#88 so the unified AgentRuntime, filesystem, process, Git, MCP, browser, Project Memory and runtime-security work is no longer mislabeled as absent.
- Replaced the stale pre-AgentRuntime diagnosis and implementation order with the real P1 Gate state: stabilization first, then product worktree orchestration, durable restart checkpoints, a real Local Worker execution target, the accepted Codex Account blocker/live evidence, and only then the remaining P2–P4 roadmap.
- Clarified checklist semantics with explicit BASE, PARCIAL, BLOCKER and intentional architectural-decision states while keeping live-provider, UI and product-orchestration gaps open rather than overclaiming completion.
- Work Hub Sources now reuses the established Work Hub list, source icon, semantic status, Company provenance, retry, and contained error patterns instead of maintaining an unstyled parallel row treatment.

### Fixed
- Restored the Work Hub Sources visual hierarchy after the multi-company refactor left the renderer on class names with no matching shared styles, fixing collapsed metadata, uncontained sync-error strips, and inconsistent source status/action alignment.

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
- Added provider-neutral Project Memory capture from the canonical `AgentLifecycleSink`, with structured session handoffs for goals, repository reads and mutations, commands, validations, decisions, failures, cancellations and current work state.
- Added local atomic persistence and bounded task-ranked recovery partitioned by Company + Project + repository/root identity, so a later authorized agent or provider can continue the same Project without replaying a full transcript.
- Added a Project Memory retrieval API that composes lifecycle handoff state with the existing evidence-backed Repo Intelligence capsule instead of creating a second durable repository-knowledge system.
- Added retention and compaction for completed history while preserving active and paused sessions, plus restart, cross-provider sharing, multi-root isolation and structured-handoff coverage.
- Added a provider-agnostic Axis MCP host that discovers Company/Project-bound MCP servers and exposes their tools as canonical `AxisTool` definitions guarded by `axis.mcp.invoke` plus read/mutation permissions.
- Added native MCP JSON-RPC clients for local stdio, Streamable HTTP, and legacy SSE transports, including initialize lifecycle, paginated tool/resource discovery, invocation, progress notifications, cancellation, timeout propagation, session cleanup, and safe stdio environment construction.
- Added a bridge from the existing Claude/Codex MCP connector discovery model into Axis-owned MCP server configuration without routing execution back through either provider loop.
- Added MCP runtime tests covering successful invocation, resources, unavailable capability refusal, Company isolation, source Connection ownership, provider-independent auth provenance, timeout/cancellation, mutation status/lifecycle, secret-safe configuration, and canonical MCP error mapping.

### Changed
- The renderer can enter an isolated `runtime-ui-preview` fixture surface for visual verification; normal Chat/Cowork composition and runtime transport installation are unchanged when the preview is not requested.

### Security
- Filesystem execution now resolves only explicit `AgentSessionContext.roots`, canonicalizes real paths, rejects root/path scope mismatches, prevents path traversal and symlink escapes, and never follows symlink directories during recursive search.
- File creation uses atomic no-clobber commit semantics, while replacement/edit operations use atomic rename plus optional or internally captured SHA-256 preconditions to avoid silently overwriting externally changed content.
- Process commands no longer inherit the application environment wholesale: only a small toolchain/system allowlist is inherited, secret-shaped variables are dropped, explicit secret-shaped overrides are rejected, shell interpreters/scripts are blocked by the default policy, and executable selection is allowlisted.
- Mutating process calls require a write-authorized session root. Successful workspace mutation is marked committed only after a clean exit; non-zero exits, cancellation and timeout retain uncertain mutation state so the runtime will not retry them as safe mutations.
- Background process handles are bound to the immutable Axis session identity, including Company, Project, connection, model and execution target. A leaked process ID cannot be polled, fed, signalled or terminated by another session, and the registry exposes `terminateSession()` for future cancellation/restart composition.
- Claude Account AgentRuntime calls now execute in an Axis-owned empty temporary working directory with Claude Code `--bare`, an empty built-in tool catalog, explicit MCP denial, no session persistence, and sanitized environment inheritance, so filesystem/shell/MCP execution cannot occur behind the canonical Axis tool host.
- Direct inference adapters reject provider-returned tool names that were not exposed by Axis for the exact model cycle and independently re-check provider family, connection, model, and bound Company identity.
- ChatGPT/Codex Account remains fail-closed for the canonical runtime: current `codex exec` has no proven all-tools-disabled mode, and `read-only` plus `shell_tool=false` does not prove model-dependent core tools such as `apply_patch` are absent. Axis will not route Codex Account work through the unsafe generic bridge until tool calls can be intercepted before provider execution.
- Project Memory ownership never includes provider, model, authentication method, API key or conversation identity; those values are retained only as non-secret provenance inside a scoped handoff.
- Lifecycle persistence is allowlisted and redacted: tool arguments and result payloads, provider progress payloads and reasoning fields are not stored, while common secret/token/private-key patterns are removed from retained text.
- The same physical repository remains isolated across Companies and Projects, and ambiguous multi-root tool activity is not copied into another root's memory.
- MCP authority is resolved from the immutable session Company/Project resource set and canonical source Connection ownership; an MCP source may differ from the inference Connection but cannot cross Company or Project boundaries.
- Sensitive MCP headers and environment variables must be stored as secret references. Ambient sensitive process environment variables are not inherited by stdio MCP servers, and arbitrary persisted cwd paths are replaced by session-authorized root IDs.
- MCP tools without an explicit read-only annotation are treated as potentially mutating, and failed or uncertain mutations remain non-retryable without confirmation through the common runtime mutation-safety contract.
- Browser state is isolated by immutable Company + Project + Axis session + execution-target context, with a Company + Project + target storage partition key prepared for future persistent profiles; provider/account identity cannot broaden or merge browser scope and state tools do not expose cookie/localStorage values.
- External browser content is marked as untrusted data with a `treat-as-data` instruction policy and defensive prompt-injection signals; the detector is advisory and does not elevate web content into instructions.
- External navigation, developer diagnostics, screenshots and DOM interaction use explicit canonical permissions. Redirect destinations are re-checked against policy, HTTP(S) URLs reject embedded credentials, reads are bounded, and unsupported interaction/CDP/screenshot operations never fall back to another browser backend, shell, screen capture or Computer Use.

## [0.19.0] - 2026-09-03

### Added
- Added the canonical provider-agnostic agent runtime boundary for model/tool/result loops, immutable multi-company session context, tool registration, execution targets, permission gates, effective capability negotiation, progress, cancellation, timeout, lifecycle events, retry eligibility and mutation status.
- Added a common provider adapter protocol plus a structured-output compatibility adapter so existing Account and API-key `InferenceProvider` connections can participate in the same runtime without provider-specific tool implementations.
- Added architecture tests covering provider/auth/tool independence, Company isolation, capability refusal, provider-independent lifecycle observation, cancellation, timeout/mutation safety and exact no-fallback provider/model/execution-target selection.
- Added the Parallel Development Handoff that freezes the runtime contracts and assigns independent ownership boundaries for filesystem, process, Git, Project Memory, MCP, browser, provider-adapter and UI workstreams.

### Security
- Agent sessions now have a fail-closed canonical scope contract: Company-owned Projects, connections, roots and resources must match the immutable session Company, and missing execution targets or unavailable capabilities fail explicitly instead of selecting a broader or alternate context.
- Potentially mutating tool failures remain `mutationStatus: unknown` unless the tool proves a safer state, preventing the common runtime from treating an uncertain local mutation as automatically retryable.

## [0.18.0] - 2026-09-03

### Added
- Added a canonical company-context graph that represents `Company → connections/resources → Projects → sessions` without treating workspace paths, account display labels, or the local execution runtime as company identities.
- Added persistent one-time migration bindings for existing Account/API-key connections so legacy organization metadata can seed company ownership without allowing a later label rename to silently move a connection between companies.
- Added local Company lifecycle management in Settings: create, edit, archive, restore, search, explicit ordering, stable generated IDs, color, icon and description.
- Added an explicit active-Company selector to the desktop chrome, composer, approval flow and completed results. The selected Company is persisted locally and switching scope deliberately reloads the shell after clearing stale navigation IDs.
- Added real-Electron visual smoke coverage for Company settings plus active-Company controls in the composer, approval and result surfaces.
- Added read-only repository context to Project Chat. Each Chat turn can rank and read bounded source excerpts plus a repository map from the Project-owned folder without granting Chat mutation or command execution capabilities.
- Added provider-neutral Project Memory retrieval to Project Chat by reusing the existing Repo Intelligence store under the same Company + Project + repository identity used by Cowork. Validated durable facts learned through one authorized connection can therefore inform another model/connection in the same Project without crossing a Company or Project boundary.
- Added a structured Last-turn diff review for Cowork results with changed-file navigation, collapsible per-file hunks, old/new line numbers, addition/removal highlighting and access to the raw unified diff.
- Added Company-scoped Project Git review for Unstaged, Staged and Branch changes. Git state is read only from the active Project-owned folder, with Branch comparison resolving upstream/main/master locally and the same structured file/hunk review used by Cowork results.

### Changed
- Ollama/local execution is represented as a shared execution capability in the canonical context instead of the former synthetic `local` organization.
- Projects now select canonical Companies rather than inventing organization IDs from free text; archived Companies retain existing references but cannot receive new Projects.
- Personal Chat no longer exposes organization-scoped API keys or Claude/ChatGPT subscription Accounts. Corporate identities require an explicitly compatible Project boundary.
- Model names are shorter and current recommendations stay visible while older OpenAI and Claude models are grouped under More models.
- Jobs and Projects exposed by the standalone desktop are filtered by the server-owned active Company. Cross-company job and Project actions fail closed, and corporate Company scope currently requires selecting one of that Company's Projects before starting a conversation.
- Company Connections now use a quieter, narrower information hierarchy: redundant helper copy and security callouts are removed from the primary scan path, runtimes and connections render as lightweight rows instead of stacked cards, and semantic accent/status colors distinguish actions, providers, healthy states and attention states.
- Company Overview, Projects, MCPs, Skills and Settings now follow the same quieter hierarchy: implementation terminology and dashboard-like metric cards are removed from the primary scan path, project and MCP content uses lightweight rows, empty states are action-oriented, and Settings keeps only the fields a user can actually change.
- Project surfaces now keep the owning Company and Chat/Cowork mode explicit in navigation and recent conversations. When a Project folder exists, the UI states the operational boundary directly: Chat reads bounded repository context while Cowork may inspect, edit and validate it.

### Security
- Company-context persistence stores only company metadata and stable resource bindings; it does not persist workspace paths, provider secrets, MCP payloads, or mutable account labels.
- Personal context no longer implicitly inherits corporate Accounts, API keys, account-scoped MCP resources or projectless history; legacy jobs without explicit Company metadata are resolved through their Project before they can be exposed.
- The renderer never supplies a trusted Company ID when creating work. Active Company selection is validated and persisted by the desktop runtime, and switching scope is an explicit user action.
- Project Chat repository indexes are partitioned by Company before workspace hashing, so reusable code-intelligence metadata cannot be shared across Company boundaries even if two Projects reference the same physical path.
- Shared Project Memory keys include the canonical Company and Project before Repo Intelligence adds repository/workspace identity. The same physical Git repository therefore cannot cause automatic memory sharing across either Company or Project boundaries.
- Project Git review cannot accept a renderer-supplied filesystem path: the Company-scoped runtime resolves and validates the active Project first, then runs read-only Git commands against that Project's configured workspace.

## [0.17.1] - 2026-09-02

### Added
- Added a source-backed, P1–P4 parity checklist for a local-first, multi-company AI control plane: first-class parity between Account and API Key connections, multiple models, Ollama, the Windows Local Worker specialization, connection/model-specific MCPs, skills, plugins and agents, provider-managed constraints, strict company isolation, and company-scoped memory, automation, usage and policies—without a hosted Axis database or backend.
- Added repository-wide visual-change instructions requiring agents to preserve the established Axis and Claude Desktop interface language, reuse the three-layer CSS architecture, and render and inspect affected states before completing UI work.

## [0.17.0] - 2026-09-02

### Added
- Cloud model selectors now refresh available models from provider catalogs when opened, so newly released API models can appear without an Axis update.
- Claude subscription-account aliases show the currently resolved family version, such as `Opus 5 · latest alias`, and completed responses retain the canonical model actually reported by Claude Code.
- Work Hub now has a full-size app surface with dedicated Messages, Work Board, Overview, Calendar, and Sources sections.
- Work Hub messages can be marked as read or dismissed locally, and ticket cards expose direct links from the Work Board.

### Changed
- Projectless Chat now distinguishes API-key connections from ChatGPT and Claude subscription accounts, including personal and organization account identities.
- Model names are shorter and current recommendations stay visible while older OpenAI and Claude models are grouped under More models.
- Messages sources now stay focused on comments from assigned Jira tickets and actionable Slack messages instead of collecting unrelated GitHub or other connector activity.

### Fixed
- Removed duplicate generic provider entries when the same configured API credentials were already represented as named connections.
- Account-backed model choices no longer hide the selected model family or make different authentication and billing paths look interchangeable.
- Jira ticket and comment links now preserve MCP-returned permalinks and use the configured Jira MCP origin when that server omits browser URLs, avoiding incorrect guessed Atlassian hostnames.

## [0.16.2] - 2026-09-02

### Fixed
- Packaged macOS builds now pin their process working directory to a private Axis-owned folder under `~/.local-coder/runtime-cwd` before Claude Code, Codex, or other provider subprocesses can start. This prevents a Finder/Dock launch directory from becoming an accidental filesystem scope for child CLIs.
- Work Hub no longer starts a source-less bulk refresh when the UI mounts. Reading the Work Hub snapshot is passive; provider CLIs are launched only by an explicit source-specific Sync action.
- The macOS privacy boundary now avoids attributing unexpected protected-folder access from automatic provider startup to Axis.

### Security
- Users should not need to grant Axis broad access to Music, Photos, Downloads, or mounted volumes merely to open the app. Source-specific integrations may still request permissions that are genuinely required by the provider or MCP being invoked.

## [0.16.1] - 2026-09-02

### Fixed
- Packaged macOS builds now discover Claude Code, Codex, and other user-installed CLIs from common Homebrew, local-bin, Volta, npm, pnpm, Bun, asdf, mise, nvm, and fnm locations instead of relying on the minimal Finder/Dock `PATH`.
- The automatic updater now targets the renamed `gustavolbs/axis` repository.
- The package repository metadata now points to `gustavolbs/axis`.

## [0.16.0] - 2026-09-02

### Added
- Automatic macOS updates using the official `update-electron-app` client and GitHub Releases.
- Stable self-signed macOS release signing so Squirrel.Mac can validate updates without a paid Apple Developer ID.
- The current Axis version is now visible in the app sidebar.
- Release metadata validation that requires `package.json` and the newest changelog entry to agree.
- Agent instructions requiring every mergeable change to bump the app version and update this changelog.

### Changed
- macOS releases are created automatically from `main` after validation, tests, packaging, signature verification, and changelog extraction.
- Release notes are generated from the matching version section in this file.
