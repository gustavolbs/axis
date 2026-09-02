# Axis — instructions for coding agents

These instructions are repository-wide and apply to every coding agent or automation that edits this repository, including Codex, GPT-based agents, Claude, Copilot, Gemini, Cursor, and custom agents.

## Mandatory release metadata

Every change intended to be merged into `main` MUST update both release metadata sources before the task is considered complete:

1. Bump `version` in the root `package.json` to a new, unreleased SemVer version.
2. Add a new top entry to `CHANGELOG.md` with exactly the same version and the current date.

A change is not complete if either item is missing. This applies to code, UI, configuration, CI/release changes, documentation, tests, dependency changes, and agent-generated maintenance work.

### Version policy

Use stable `MAJOR.MINOR.PATCH` versions only.

- PATCH: fixes, refactors, dependency/CI/documentation maintenance, small behavior changes.
- MINOR: new user-facing capabilities or meaningful product changes.
- MAJOR: intentional breaking changes.

One logical branch/PR should normally have one version bump. If another change lands in `main` first and consumes that version, rebase/update the branch and choose the next available version before merging.

Never reuse, overwrite, or edit a version that has already been published as a GitHub Release.

## Changelog policy

`CHANGELOG.md` is the canonical human-readable release history and the source of GitHub Release notes.

The newest section must be the version in `package.json` and must use this exact heading shape:

```text
## [0.16.1] - 2026-09-02
```

Use concise Keep-a-Changelog style sections such as `Added`, `Changed`, `Fixed`, `Removed`, or `Security`. Describe user-visible/product behavior first; include implementation details only when they matter operationally.

Do not modify historical released sections except to correct a factual error explicitly requested by the user.

## Required validation

Before finishing any task that changes the repository, run:

```bash
npm run release:validate
npm run check
```

`release:validate` verifies that the current version is valid SemVer, is the newest changelog entry, and has non-empty release notes. Pull-request CI additionally verifies that the version is greater than the base branch version.

## Automatic release behavior

After a qualifying change reaches `main`, `.github/workflows/release-macos.yml` automatically:

1. validates version/changelog metadata;
2. rejects a version that already has a tag/release;
3. runs the project checks;
4. builds Intel and Apple Silicon macOS artifacts;
5. signs them with the stable self-signed `Axis Code Signing` identity;
6. verifies the designated requirement is certificate-pinned rather than ad-hoc;
7. extracts release notes from `CHANGELOG.md`;
8. creates the `v<version>` GitHub Release and uploads DMG/ZIP/checksum artifacts.

Do not manually create a release, tag, or alter release artifacts unless the user explicitly asks for recovery work.

## macOS signing invariant

The self-signed release certificate is part of the update trust chain. Do not rename, regenerate, rotate, replace, or change the expected `Axis Code Signing` identity as part of ordinary work. A certificate rotation breaks automatic updates for installed copies and requires a manual transition release.

See `docs/AUTO_UPDATES.md` for the release/signing architecture and one-time secret setup.
