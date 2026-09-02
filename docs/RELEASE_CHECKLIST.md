# macOS release checklist

Axis publishes macOS releases automatically from `main`. Distribution uses a stable self-signed **Axis Code Signing** certificate so Squirrel.Mac can validate updates without a paid Apple Developer Program membership.

The normal CI pipeline still produces unsigned development artifacts. The separate release workflow performs the signed distribution build and publishes only after all release gates pass.

## One-time release setup

Create the signing identity once on a Mac:

```bash
bash scripts/create-macos-signing-cert.sh
```

Back up the generated `.p12` and its password outside the repository. The certificate is part of the automatic-update trust chain; losing or rotating it means existing installations need another manual transition install.

Configure these GitHub Actions secrets:

```text
MAC_CSC_LINK
MAC_CSC_KEY_PASSWORD
```

`MAC_CSC_LINK` contains the base64-encoded `.p12`. Never commit the certificate, private key, password, or temporary keychains.

No Apple ID, Team ID, app-specific password, Developer ID certificate, or notarization credential is required for this update channel.

## Before merging to main

- [ ] Linux, Windows, and macOS CI are green.
- [ ] `package.json` has a new unreleased stable SemVer version.
- [ ] The newest `CHANGELOG.md` entry has exactly the same version and the current date.
- [ ] `npm run release:validate` passes.
- [ ] `npm run check` passes.
- [ ] `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` are configured in repository secrets.
- [ ] A new Project defaults to `cloudAllowed: false` and `ollama` only.
- [ ] Standalone settings are stored under `~/.local-coder/settings.json` and do not contain raw worker bearer tokens.
- [ ] Worker credentials use an explicit environment token or `remoteWorkerCredentialRef` backed by macOS Keychain.
- [ ] No provider API key or Windows worker bearer token appears in repository files, logs, telemetry, eval output, or pricing metadata.
- [ ] Provider pricing used for budgeted cloud routing has a current source and verification timestamp.
- [ ] Real Anthropic/OpenAI smoke validation has been run when credentials are available and the release changes provider transport behavior.
- [ ] Comparative evals have been reviewed when the release changes routing heuristics or quality profiles.

## Automatic release

A push to `main` starts **macOS Automatic Release**. There is also a `workflow_dispatch` trigger for recovery/retry after infrastructure or secret setup problems.

The workflow uses `electron-builder.release.yml`, not the unsigned development config.

Release gates are:

```text
version + changelog validation
  -> reject an already-published version
  -> full build and tests
  -> import/trust Axis Code Signing on the ephemeral runner
  -> build x64 + arm64 DMG/ZIP
  -> codesign strict validation
  -> require certificate-pinned designated requirement
  -> reject ad-hoc cdhash signing
  -> SHA-256 checksums
  -> release notes extracted from CHANGELOG.md
  -> GitHub Release v<version>
```

Nothing is published until the previous gates pass.

## Required automated verification

Every packaged `Axis.app` must pass:

```bash
codesign --verify --deep --strict <Axis.app>
codesign -d -r- <Axis.app>
```

The designated requirement must be certificate-pinned (`certificate root = H...` or equivalent). A `cdhash` requirement means the build fell back to ad-hoc signing and must fail because the next version would not satisfy the same Squirrel.Mac identity.

The expected public artifacts are:

```text
Axis-mac-<version>-arm64.dmg
Axis-mac-<version>-x64.dmg
Axis-mac-<version>-arm64.zip
Axis-mac-<version>-x64.zip
SHA256SUMS.txt
```

The ZIP files are the automatic-update payloads. DMGs remain available for first/manual installation.

## Bootstrap and Gatekeeper

`0.16.0` is the first Axis release that contains the official updater and the stable self-signed identity. Installs older than `0.16.0` need one final manual installation of the bootstrap release.

The self-signed certificate is not Apple notarization. A first browser download can still require right-click -> **Open** or the normal Gatekeeper quarantine override. This first-install limitation is independent from the Squirrel.Mac update identity.

After the bootstrap release is installed, compatible future releases can be downloaded and installed by the app without repeating the DMG workflow.

## Artifact review

For the bootstrap release, and after meaningful packaging/updater changes:

- [ ] install the DMG on a current macOS user account;
- [ ] verify `Axis.app` starts its in-process `DesktopAppRuntime` without a localhost control service;
- [ ] verify the sidebar reports the expected Axis version;
- [ ] create a new local-only Project and run a small validated task;
- [ ] verify the native folder picker, theme synchronization, keyboard shortcuts and restored window bounds;
- [ ] verify a configured cloud Project can discover models and run direct-to-cloud without Ollama pre-inference;
- [ ] verify cancellation and Runs inspection from the desktop UI;
- [ ] verify an authenticated Windows worker can provide local inference when configured;
- [ ] verify external HTTPS links open in the system browser rather than navigating the renderer;
- [ ] after publishing the next patch version, verify the installed bootstrap detects it, downloads it, and can restart into the new version.

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

Never include secret values in release workflow inputs, build arguments visible in process listings, artifact names, release notes, Git commits, Project JSON, app settings, telemetry, or eval reports.

GitHub Actions secrets are injected only into the signing build. Preflight errors may print missing **variable names**, never their values.

If the self-signed private key is exposed, stop distribution. Replacing it breaks the update chain, so certificate recovery/rotation must be treated as an explicit migration rather than routine secret rotation.

See `docs/AUTO_UPDATES.md` for the updater architecture and signing rationale.
