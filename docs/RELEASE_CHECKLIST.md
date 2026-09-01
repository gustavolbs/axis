# macOS release checklist

The normal CI pipeline intentionally produces **unsigned** development artifacts. Distribution outside the Mac App Store must use the separate manual **macOS Signed Release** workflow.

## Release prerequisites

Required Apple setup:

- active Apple Developer Program membership;
- valid **Developer ID Application** certificate exported as a password-protected `.p12`;
- Apple ID with an app-specific password for notarization;
- Apple Team ID.

Required GitHub Actions secrets:

```text
MAC_CSC_LINK
MAC_CSC_KEY_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

`MAC_CSC_LINK` may contain the base64-encoded `.p12` value accepted by electron-builder. Do not commit the certificate, password, Apple ID credentials, or generated temporary keychains.

The release workflow is fail-closed: if any required secret is absent, it exits before packaging.

## Before running the workflow

- [ ] `main` CI is green on Linux, Windows, and macOS packaging.
- [ ] The intended commit is reviewed and immutable for the release.
- [ ] `package.json` version reflects the version you intend to distribute.
- [ ] A new Project defaults to `cloudAllowed: false` and `ollama` only.
- [ ] Standalone settings are stored under `~/.local-coder/settings.json` and do not contain raw worker bearer tokens.
- [ ] Worker credentials use an explicit environment token or `remoteWorkerCredentialRef` backed by macOS Keychain.
- [ ] No provider API key or Windows worker bearer token appears in repository files, logs, telemetry, eval output, or pricing metadata.
- [ ] Provider pricing used for budgeted cloud routing has a current source and verification timestamp.
- [ ] Real Anthropic/OpenAI smoke validation has been run when credentials are available and the release changes provider transport behavior.
- [ ] Comparative evals have been reviewed when the release changes routing heuristics or quality profiles.

## Run the signed release

1. Open **Actions → macOS Signed Release**.
2. Choose **Run workflow**.
3. Supply the exact branch, tag, or commit SHA to package.
4. Run the workflow.

The workflow uses `electron-builder.release.yml`, not the unsigned CI config.

Expected release gates:

```text
Developer ID signing
  → Apple notarization
  → stapler ticket validation
  → Gatekeeper assessment
  → DMG mounted and packaged app re-verified
  → SHA-256 checksums
  → artifact upload
```

A packaging step that merely creates a DMG/ZIP is not sufficient for distribution.

## Required automated verification

The release workflow must pass all of these checks:

```bash
codesign --verify --deep --strict <Local Coder.app>
xcrun stapler validate <Local Coder.app>
spctl --assess --type execute <Local Coder.app>
```

It also mounts the generated DMG and repeats signature, stapler, and Gatekeeper checks against the copy users will install.

The workflow additionally verifies that `codesign` reports a `Developer ID Application` authority. This prevents electron-builder's permissive "no certificate found, skip signing" behavior from being mistaken for a successful release.

## Artifact review

Download `local-coder-macos-signed-notarized` and verify it contains:

- [ ] one DMG;
- [ ] one ZIP;
- [ ] `SHA256SUMS.txt`.

Before wider distribution:

- [ ] install the DMG on a separate/current macOS user environment;
- [ ] launch without Gatekeeper bypasses such as disabling Gatekeeper or removing quarantine attributes;
- [ ] verify `Local Coder.app` starts its in-process `DesktopAppRuntime` without a localhost control service;
- [ ] create a new local-only Project and run a small validated task;
- [ ] verify the native folder picker, theme synchronization, keyboard shortcuts and restored window bounds;
- [ ] verify a configured cloud Project can discover models and run direct-to-cloud without Ollama pre-inference;
- [ ] verify cancellation and Runs inspection from the desktop UI;
- [ ] verify an authenticated Windows worker can provide local inference when configured;
- [ ] verify external HTTPS links open in the system browser rather than navigating the renderer.

## Standalone state and isolation checks

Release verification must preserve these rules:

- [ ] `~/.local-coder/settings.json` is the standalone settings source;
- [ ] settings persist worker credential references, never raw worker bearer tokens;
- [ ] Projects do not silently enable cloud access;
- [ ] credentials cannot be rebound across Organization IDs;
- [ ] the same workspace cannot be assigned to conflicting organizations;
- [ ] usage, routing history, Repo Intelligence, policy and budget state remain Project-scoped;
- [ ] explicit provider/model selection remains exact-or-fail;
- [ ] budget admission occurs before cloud provider I/O;
- [ ] the Windows worker remains compute infrastructure rather than a UI or product host.

## Credential safety checks

Never include secret values in:

- release workflow inputs;
- build arguments visible in process listings;
- artifact names;
- release notes;
- Git commits;
- Project JSON;
- app settings;
- telemetry or eval reports.

GitHub Actions secrets are injected only into the signing/notarization steps. The workflow's preflight prints missing **variable names** only, never their values.

If a signing or provider credential is suspected to be exposed, stop distribution and rotate/revoke it before producing another artifact.

## References verified 2026-08-31

Apple:

- https://developer.apple.com/support/developer-id/
- https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- https://developer.apple.com/documentation/security/customizing-the-notarization-workflow

Electron Builder:

- https://www.electron.build/docs/features/code-signing/
- https://www.electron.build/docs/features/code-signing/code-signing-mac/
- https://www.electron.build/docs/notarization/

The repository is pinned to electron-builder `26.15.7`; release configuration should be revalidated before upgrading to a major version with signing-schema changes.
