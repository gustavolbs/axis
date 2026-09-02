# Changelog

All notable changes to Axis are recorded here. The format follows Keep a Changelog and the app version follows Semantic Versioning.

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
