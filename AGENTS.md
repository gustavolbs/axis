# Axis — instructions for coding agents

These instructions are repository-wide and apply to every coding agent or automation that edits this repository, including Codex, GPT-based agents, Claude, Copilot, Gemini, Cursor, and custom agents.

## Mandatory visual and interface preservation

Every change that affects UI, layout, styling, interaction states, visual copy, icons, or frontend structure MUST preserve the established Axis design system and the Claude Desktop interaction/visual conventions that Axis intentionally follows. Visual work is not complete merely because TypeScript compiles or tests pass.

Before editing visual code, the agent MUST:

1. inspect the affected screen and its neighboring states in the running app;
2. read the relevant existing component and shared styles before proposing new markup or CSS;
3. identify and reuse the closest existing Axis/Claude pattern for panes, sidebars, composer controls, dialogs, lists, cards, typography, spacing, colors, radii, shadows, icons, hover/focus states, and information hierarchy;
4. preserve the current interaction grammar unless the user explicitly requests a redesign; and
5. keep the change narrowly scoped so unrelated surfaces do not drift.

The stylesheet architecture is a repository contract:

- `app/src/lc-base.css` owns design tokens, theme values, geometry, and base rules.
- `app/src/lc-app.css` owns source component styles and is the normal destination for new component rules.
- `app/src/lc-fixes.css` is the final corrections layer. Add to it only when repairing an existing cascade defect, document the defect, and fold the correction into `lc-app.css` when practical.
- `app/src/main.tsx` MUST keep the import order `lc-base.css` → `lc-app.css` → `lc-fixes.css`.
- Do not add another global stylesheet, competing `:root` tokens, one-off color/spacing systems, or broad selectors that can leak into other surfaces.
- Prefer existing tokens, classes, and shared controls such as `UiSelect` and `ShellDialog`. Do not introduce inline visual constants, `!important`, or duplicate components when the existing system can express the design.

Before considering visual work complete, the agent MUST render and inspect the affected UI. Verify at minimum:

- the normal window size, a narrower resized window, and a maximized/wide window where relevant;
- light and dark themes;
- expanded and collapsed sidebar states when the shell is affected;
- empty, loading, error, populated, long-content, and disabled states touched by the change;
- keyboard focus, hover, selected, pressed, and destructive states;
- scrolling, text wrapping, truncation, overlays, sticky elements, and modal/popover bounds; and
- that there is no unintended horizontal overflow, clipping, overlap, layout jump, inaccessible control, or broken neighboring screen.

Use before/after screenshots or equivalent rendered evidence for the affected states and report that visual verification in the handoff. When the intended Claude pattern is ambiguous, inspect the current project implementation and the supplied/reference Claude interface before inventing a new pattern. Any intentional departure from the established Axis/Claude visual language must be explicitly requested or called out to the user before implementation.

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
