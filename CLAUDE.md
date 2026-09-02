# Claude instructions for Axis

Read and follow `AGENTS.md` before modifying this repository. Its rules are mandatory for Claude work in this repo.

In particular, no mergeable change is complete until:

- `package.json` has a new unreleased SemVer version;
- `CHANGELOG.md` has a new top entry for exactly that version;
- `npm run release:validate` passes;
- `npm run check` passes.

Do not rotate or replace the `Axis Code Signing` identity and do not manually publish releases or tags unless the user explicitly requests release recovery.
