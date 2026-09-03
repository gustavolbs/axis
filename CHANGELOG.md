# Changelog

All notable changes to Axis are recorded here. The format follows Keep a Changelog and the app version follows Semantic Versioning.

## [0.20.0] - 2026-09-03

### Added
- Added a provider-neutral Agent Runtime activity timeline that projects the frozen lifecycle protocol into running/provider progress, tool progress, read, mutation, command, validation, error, cancellation, pause and completion states without provider-specific UI semantics.
- Added canonical approval and decision surfaces for permission requests and `AgentDecisionRequest`, including accessible native progress controls, attachment metadata rendering and keyboard-operable responses.
- Added reusable runtime evidence panes prepared for filesystem, process, Git, MCP and browser integration, plus isolated canonical lifecycle fixtures for integration and visual verification without inventing new backend contracts.
- Added Agent Runtime UI contract tests and real-Electron visual smoke coverage for light/dark themes, narrow layout, keyboard focus, pane navigation, progress, decision/approval resolution and failure states.
- Added Company-bound native `AgentProviderAdapter` composition for OpenAI API Key, Anthropic API Key, Ollama, and Claude Account connections without changing the canonical `AgentRuntime` or Axis tool contracts.
- Added a provider-neutral structured Account protocol that translates canonical messages, attachment metadata, summarized reasoning, tool definitions/calls/results, decision requests, stop reasons, progress, errors, cancellation, and exact model identity at the provider boundary.
- Added adapter tests covering API Key and Account authentication in the same runtime, OpenAI and Anthropic provider families, capability negotiation, canonical tool-call roundtrips, hidden-tool rejection, cancellation, provider errors, exact no-fallback model selection, Ollama local scope, and Company ownership preservation.
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
- Added the desktop runtime endpoint `GET /api/companies/context` so the canonical hierarchy is inspectable independently of the legacy storage fields while the remaining multi-company migration proceeds.
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
- The desktop entrypoint now uses a small updater bootstrap before loading the existing Electron main process.
