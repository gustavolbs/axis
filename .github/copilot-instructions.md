# Axis repository instructions

Follow the repository-wide rules in `AGENTS.md` for every change.

Before completing any mergeable change, bump the root `package.json` version, add the matching newest `CHANGELOG.md` entry, and run `npm run release:validate` plus `npm run check`.

Do not rotate the `Axis Code Signing` identity or manually publish releases/tags during ordinary development.
