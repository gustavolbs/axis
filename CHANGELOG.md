# Changelog

All notable changes to Axis are recorded here. The format follows Keep a Changelog and the app version follows Semantic Versioning.

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

### Notes
- `0.16.0` is the bootstrap release for automatic updates. Existing installs from before this release must install this version manually once because they do not yet contain the updater or the stable self-signed signing identity.
- Self-signed signing does not notarize the app. Gatekeeper may still require the normal first-install override; subsequent in-app updates use the stable signing identity.
