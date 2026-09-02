# Axis automatic macOS updates

Axis uses the official Electron update path without a paid Apple Developer ID.

## Architecture

```text
merge to main
  -> GitHub Actions validates version + CHANGELOG
  -> tests/build
  -> electron-builder creates x64 + arm64 DMG/ZIP
  -> artifacts are signed with the stable self-signed "Axis Code Signing" certificate
  -> CI verifies the certificate-pinned designated requirement
  -> GitHub Release v<version> is published with notes extracted from CHANGELOG.md
  -> update.electronjs.org exposes the release to the official update-electron-app client
  -> installed Axis downloads the ZIP in the background
  -> Electron offers Restart / Later
```

The repository is public, so `update.electronjs.org` and GitHub Releases require no runtime token.

## Why self-signed works

Electron's macOS `autoUpdater` uses Squirrel.Mac. Squirrel requires a signed application and validates the downloaded app against the designated requirement of the running app.

An ad-hoc signature (`codesign -s -`) is not sufficient for repeatable updates because its designated requirement is tied to a per-build cdhash. A normal certificate produces a certificate-pinned designated requirement that remains stable across builds. The certificate does not need to be issued by Apple for this Squirrel validation; Axis uses one stable self-signed code-signing certificate for every release.

This does **not** notarize the app or make Gatekeeper trust a first browser download. The first installation can still require right-click -> Open or the normal quarantine override. Automatic updates after the self-signed bootstrap release do not require a paid Apple account.

## One-time signing setup

Run this once on a Mac:

```bash
bash scripts/create-macos-signing-cert.sh
```

The script creates `~/axis-signing/axis-code-signing.p12` with common name:

```text
Axis Code Signing
```

Back up the `.p12` and its password somewhere durable and private. Losing or rotating this certificate breaks the update trust chain for already installed copies.

Then configure the two GitHub repository secrets printed by the script:

```text
MAC_CSC_LINK
MAC_CSC_KEY_PASSWORD
```

No Apple ID, Team ID, app-specific password, Developer ID certificate, or notarization secret is used.

## Version and changelog contract

The root `package.json` version is the machine-readable source of truth. `CHANGELOG.md` is the human-readable release source and GitHub Release notes source.

For every mergeable change:

1. choose a new stable SemVer version in `package.json`;
2. add that same version as the newest `CHANGELOG.md` section;
3. run `npm run release:validate`;
4. run `npm run check`.

The release workflow refuses to publish a version whose `v<version>` tag or release already exists.

## Release workflow

`.github/workflows/release-macos.yml` runs automatically on every push to `main`.

It performs these gates before publishing:

- version/changelog consistency;
- version has not already been released;
- full project check;
- required self-signed signing secrets exist;
- x64 and arm64 DMG/ZIP artifacts exist;
- every packaged `Axis.app` passes `codesign --verify --deep --strict`;
- every designated requirement is certificate-pinned and is not an ad-hoc `cdhash` requirement;
- release notes can be extracted from the changelog;
- SHA-256 checksums are generated.

Only after all gates pass does the workflow create the public GitHub Release.

## Bootstrap release

`0.16.0` is the first release containing the updater and stable signing identity. Any Axis installation older than `0.16.0` must install `0.16.0` manually once. After that, future compatible releases can update in-app.

## Release artifact naming

The official Electron public update service identifies macOS assets by filename. Axis publishes:

```text
Axis-mac-<version>-arm64.zip
Axis-mac-<version>-x64.zip
Axis-mac-<version>-arm64.dmg
Axis-mac-<version>-x64.dmg
```

ZIP is the Squirrel update payload. DMG is retained for first/manual installs.
