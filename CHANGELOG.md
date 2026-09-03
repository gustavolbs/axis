# Changelog

All notable changes to Axis are recorded here. The format follows Keep a Changelog and the app version follows Semantic Versioning.

## [0.18.0] - 2026-09-03

### Added
- Added a canonical company-context graph that represents `Company → connections/resources → Projects → sessions` without treating workspace paths, account display labels, or the local execution runtime as company identities.
- Added persistent one-time migration bindings for existing Account/API-key connections so legacy organization metadata can seed company ownership without allowing a later label rename to silently move a connection between companies.
- Added the desktop runtime endpoint `GET /api/companies/context` so the canonical hierarchy is inspectable independently of the legacy storage fields while the remaining multi-company migration proceeds.
- Added local Company lifecycle management in Settings: create, edit, archive, restore, search, explicit ordering, stable generated IDs, color, icon and description.
- Added an explicit active-Company selector to the desktop chrome, composer, approval flow and completed results. The selected Company is persisted locally and switching scope deliberately reloads the shell after clearing stale navigation IDs.
- Added real-Electron visual smoke coverage for Company settings plus active-Company controls in the composer, approval and result surfaces.

### Changed
- Ollama/local execution is represented as a shared execution capability in the canonical context instead of the former synthetic `local` organization.
- Projects now select canonical Companies rather than inventing organization IDs from free text; archived Companies retain existing references but cannot receive new Projects.
- Personal Chat no longer exposes organization-scoped API keys or Claude/ChatGPT subscription Accounts. Corporate identities require an explicitly compatible Project boundary.
- Jobs and Projects exposed by the standalone desktop are filtered by the server-owned active Company. Cross-company job and Project actions fail closed, and corporate Company scope currently requires selecting one of that Company's Projects before starting a conversation.
- Company Connections now use a quieter, narrower information hierarchy: redundant helper copy and security callouts are removed from the primary scan path, runtimes and connections render as lightweight rows instead of stacked cards, and semantic accent/status colors distinguish actions, providers, healthy states and attention states.
- Company Overview, Projects, MCPs, Skills and Settings now follow the same quieter hierarchy: implementation terminology and dashboard-like metric cards are removed from the primary scan path, project and MCP content uses lightweight rows, empty states are action-oriented, and Settings keeps only the fields a user can actually change.

### Security
- Company-context persistence stores only company metadata and stable resource bindings; it does not persist workspace paths, provider secrets, MCP payloads, or mutable account labels.
- Personal context no longer implicitly inherits corporate Accounts, API keys, account-scoped MCP resources or projectless history; legacy jobs without explicit Company metadata are resolved through their Project before they can be exposed.
- The renderer never supplies a trusted Company ID when creating work. Active Company selection is validated and persisted by the desktop runtime, and switching scope is an explicit user action.

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
