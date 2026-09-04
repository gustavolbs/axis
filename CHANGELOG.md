# Changelog

All notable changes to Axis are recorded here. The format follows Keep a Changelog and the app version follows Semantic Versioning.

## [0.24.1] - 2026-09-04

### Fixed
- Repaired the Project overview without changing Axis Project pin semantics: the existing pin remains persistent, the composer/context folder controls open the real folder picker, instruction cancellation restores the saved value, and project rename/archive/delete actions are now reachable from the header menu.
- Replaced the Project-only Model & connections dialog with the same inline model-selector presentation used by New Chat. Project model choices now come from the Project catalog and open as the existing composer popover instead of exposing the Connection-policy matrix from the overview.
- Removed decorative Context search and Scheduled-task controls from the overview instead of shipping a client-only scheduler that bypasses the planned local Automation architecture.
- Stabilized the Company/Work Hub visual smoke by waiting for the global Company filter transition before opening Sources.

### Added
- Added real-Electron Project overview smoke coverage for the existing pin, shared composer, inline model selector, compact rail, project action menu, light/dark themes, and narrow-window overflow behavior.
