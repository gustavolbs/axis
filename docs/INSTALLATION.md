# Local Coder installation and first run

This guide covers the standalone macOS application, the browser-accessible fallback, provider setup, Project isolation, and migration from the v0.14 Local-only configuration.

## 1. Install on macOS

### Signed distribution build

Use a DMG produced by the manual **macOS Signed Release** workflow. That workflow is intentionally separate from normal CI and only succeeds after Developer ID signing, Apple notarization, stapler validation, and Gatekeeper assessment.

1. Download the verified DMG artifact from the release workflow.
2. Open the DMG.
3. Drag `Local Coder.app` to `/Applications`.
4. Launch Local Coder normally.

A valid distribution artifact should not require bypassing Gatekeeper with `xattr`, disabling Gatekeeper, or using an ad-hoc signature. Treat instructions that require those steps as a release defect.

### Development / unsigned build

For local development from the repository:

```bash
npm install
npm run desktop
```

To produce an unsigned local package for testing:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack:mac
```

Unsigned artifacts are development outputs only. The ordinary CI job deliberately produces unsigned `.app`/DMG/ZIP artifacts and is not a distribution channel.

### Browser-accessible fallback

The same Agent Runtime can run without Electron:

```bash
npm run console
```

Default URL:

```text
http://127.0.0.1:7557
```

The desktop application and browser fallback use the same local control plane and persistent stores.

## 2. First run: create a Project

Open **Projects** and create a Project for the repository you want Local Coder to operate on.

Required identity fields:

- **Name** — human-readable Project name;
- **Workspace** — repository/worktree path;
- **Organization ID** — stable company/account isolation boundary;
- **Organization name** — optional display label.

The Organization ID is a security boundary, not a cosmetic tag. A workspace already assigned to one Organization ID cannot also be assigned to a different Organization ID.

Local-safe defaults are intentionally conservative:

```text
routing: local-first
model: Auto
cloudAllowed: false
allowed providers: ollama
concurrency: 1
```

A new Project therefore remains Local-only until cloud access is explicitly enabled.

## 3. Configure providers

### Ollama / local compute

Ollama remains the default local provider. Local compute may run on the Mac or on the authenticated Windows Worker, depending on `LOCAL_CODER_EXECUTION_MODE` and shared control-plane configuration.

Recommended Windows GPU worker baseline:

```text
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
```

### Anthropic or OpenAI

In **Projects**:

1. Add or replace the provider credential.
2. On macOS, durable API keys are stored in Keychain and Project JSON stores only a credential reference.
3. Test the provider connection.
4. Discover available models from the provider API.
5. Add the provider to the Project allowlist.
6. Enable `cloudAllowed` only when cloud transmission is acceptable for that Project.
7. Keep **Auto** model selection or choose an explicit provider/model.

For headless use, credentials may reference environment variables rather than Keychain.

Raw provider API keys must never be placed in:

- `projects.json`;
- `control-plane.json`;
- provider pricing metadata;
- telemetry;
- routing history;
- prompts;
- repository files.

## 4. Routing policy

Supported Project routing policies:

```text
auto
local-first
balanced
speed-first
deep
frontier-only
```

Key semantics:

- `local-first` prefers eligible healthy local compute;
- `speed-first` may route directly to cloud with no Qwen pre-pass;
- `deep` favors stronger reasoning when policy and budget permit it;
- `frontier-only` excludes local models;
- explicit model selection is exact-or-fail and is never silently substituted;
- Project provider allowlists and `cloudAllowed` are hard constraints before scoring;
- budget admission occurs before cloud provider I/O.

## 5. Pricing and budgets

Before using budgeted cloud routing, configure provider/model pricing with its source and verification timestamp.

Projects support:

- per-job USD budget;
- daily USD budget;
- monthly USD budget;
- warning thresholds;
- hard-stop fraction.

The Usage Ledger records normalized usage and known cost without recording prompts or model output. Concurrent cloud attempts reserve a conservative upper bound before execution to prevent budget races.

## 6. Project and company isolation

Local Coder isolates by Project plus stable Organization ID.

Enforced boundaries include:

- one workspace cannot belong to two different organizations;
- a Project can reference only credentials whose provider and Organization ID match;
- provider allowlists and `cloudAllowed` are Project-specific;
- Repo Intelligence scope is Project-specific;
- routing history is isolated by Project/organization and stores operational observations only;
- usage and budget accounting are Project-specific;
- explicit credentials, budgets, model policy, and routing policy are not inherited across companies.

When working for multiple companies, create separate Projects and separate organization-bound credentials even if the same provider is used.

## 7. Migration from v0.14 / Local-only

The shared control-plane source remains:

```text
~/.local-coder-mcp/control-plane.json
```

Compatibility rules:

- existing Local-only installs remain valid;
- legacy `executionMode`, worker URL, and model settings remain readable;
- legacy v0.14 `remoteWorkerToken` is read for compatibility only;
- new writers emit config version 2 and never persist an inline worker bearer token;
- secure worker installation stores the token in macOS Keychain and writes only `remoteWorkerCredentialRef`;
- creating Projects does not require migrating the legacy local execution topology first;
- cloud providers remain disabled for new Projects until explicitly allowed.

Do not manually copy an old inline worker token into new Project or provider metadata. Re-run the secure worker installer when you want to migrate that credential to Keychain.

## 8. Claude / MCP remains supported

The standalone app does not replace MCP. Both interfaces invoke the same Agent Runtime.

On Mac, the existing Claude setup remains available:

```bash
npm run install:claude:worker -- --host <WINDOWS_MESHNET_IP>
npm run install:routing
npm run install:claude-token-saver
```

Preferred engineering entrypoint remains `local_engineer`.

## 9. Operational verification

Before trusting a new setup with repository mutation:

1. open **Projects** and confirm workspace, Organization ID, provider allowlist, cloud policy, routing policy, model, credential binding, and budgets;
2. run a small objectively verifiable task;
3. inspect **Runs** for routing trace, provider/model attempts, fallback evidence, validation, usage, and budget snapshot;
4. confirm that an explicit cloud model fails closed if its credential/provider is unavailable;
5. confirm that a Local-only Project does not perform cloud calls.

For live provider transport validation, use the opt-in smoke workflow documented in `docs/CLOUD_SMOKE.md`.
