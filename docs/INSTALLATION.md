# Local Coder installation and first run

This guide covers the standalone macOS application, provider setup, Project isolation and the optional Windows inference worker.

Local Coder does not require Claude Desktop, MCP configuration, a browser console or a localhost control-plane service.

## 1. Install on macOS

### Development from the repository

```bash
npm install
npm run desktop
```

The command builds the Node runtime and React renderer, then launches Electron. `DesktopAppRuntime` runs inside the Electron main process and the renderer talks to it through isolated preload IPC.

### Unsigned local package

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack:mac
```

Unsigned `.app`/DMG/ZIP artifacts are development outputs only.

### Signed distribution

Use a DMG produced by the manual **macOS Signed Release** workflow. A valid distribution artifact is Developer-ID signed, notarized and independently validated by the release workflow.

1. Download the verified DMG.
2. Open it.
3. Drag `Local Coder.app` to `/Applications`.
4. Launch Local Coder normally.

A valid release should not require disabling Gatekeeper, removing quarantine manually or accepting an ad-hoc signature.

## 2. First run: create a Project

Open **Projects** and create a Project for the repository Local Coder should operate on.

Required identity fields:

- **Name** — human-readable Project name;
- **Workspace** — repository/worktree folder selected with the native folder picker;
- **Organization ID** — stable company/account isolation boundary;
- **Organization name** — optional display label.

The Organization ID is a security boundary, not a cosmetic tag. A workspace assigned to one Organization ID cannot also be assigned to a different one.

Conservative first-run defaults:

```text
routing: local-first
model: Auto
cloudAllowed: false
allowed providers: ollama
concurrency: 1
```

A new Project therefore remains local-only until cloud access is explicitly enabled.

## 3. Standalone app state

Local Coder uses one state root:

```text
~/.local-coder/
```

Primary settings:

```text
~/.local-coder/settings.json
```

Optional overrides:

```text
LOCAL_CODER_HOME=/custom/path
LOCAL_CODER_SETTINGS_PATH=/custom/path/settings.json
```

There is no shared `control-plane.json` in the current product.

## 4. Configure local inference

### Ollama on the Mac

Ollama is the default local provider.

Example:

```bash
ollama pull qwen3.8:27b
```

Typical configuration:

```text
LOCAL_CODER_EXECUTION_MODE=local
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
```

If the 27B model is too heavy for the Mac, use the optional Windows worker.

### Windows inference worker

The Windows worker is local inference compute only. The Mac app still owns Project state, repository access, routing, planning, mutation, validation, review and Repo Intelligence.

Recommended baseline:

```text
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
```

Execution modes:

| Mode | Behavior |
| --- | --- |
| `local` | Local inference uses Ollama on the Mac. |
| `remote` | Local inference requires the authenticated Windows worker. |
| `auto` | Prefer the Windows worker and fall back to Mac Ollama when policy allows. |

See [WINDOWS_REMOTE_SETUP.md](WINDOWS_REMOTE_SETUP.md).

Worker tokens may be supplied through `LOCAL_CODER_REMOTE_WORKER_TOKEN` or referenced from macOS Keychain with `LOCAL_CODER_REMOTE_WORKER_CREDENTIAL_REF`. `settings.json` does not persist the raw worker bearer token.

## 5. Configure Anthropic or OpenAI

Open **Settings → API keys**:

1. add the provider credential;
2. use macOS Keychain for durable API-key storage;
3. verify provider availability;
4. open **Settings → Model routing** or the Project settings;
5. add the provider to the Project allowlist;
6. enable `cloudAllowed` only when cloud transmission is acceptable for that Project;
7. keep **Auto** selection or choose an explicit provider/model.

Raw provider API keys must never be placed in:

- `projects.json`;
- app settings;
- pricing metadata;
- telemetry;
- routing history;
- prompts;
- repository files.

## 6. Routing policy

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

## 7. Pricing and budgets

Before budgeted cloud routing, configure provider/model pricing with its source and verification timestamp.

Projects support:

- per-job USD budget;
- daily USD budget;
- monthly USD budget;
- warning thresholds;
- hard-stop fraction.

The Usage Ledger records normalized usage and known cost without recording prompts or model output. Concurrent cloud attempts reserve a conservative upper bound before execution to prevent budget races.

## 8. Project and company isolation

Local Coder isolates by Project plus stable Organization ID.

Enforced boundaries include:

- one workspace cannot belong to two different organizations;
- a Project can reference only credentials whose provider and Organization ID match;
- provider allowlists and `cloudAllowed` are Project-specific;
- Repo Intelligence scope is Project-specific;
- routing history is isolated by Project/organization;
- usage and budget accounting are Project-specific;
- credentials, budgets, model policy and routing policy are not inherited across companies.

When working for multiple companies, create separate Projects and separate organization-bound credentials even when they use the same provider.

## 9. Optional external research

Research is disabled from the network unless a backend is configured. To use a trusted SearXNG instance:

```text
LOCAL_CODER_RESEARCH_ENABLED=true
LOCAL_CODER_SEARXNG_URL=http://<trusted-instance>
```

Retrieved content is treated as untrusted evidence, never instructions. Microsoft ecosystem queries use ordinary SearXNG discovery narrowed to `site:learn.microsoft.com`; no Microsoft Learn MCP connection is used.

## 10. Operational verification

Before trusting a new setup with repository mutation:

1. open **Projects** and confirm workspace, Organization ID, provider allowlist, cloud policy, routing policy, model, credentials and budgets;
2. run a small objectively verifiable task;
3. inspect **Runs** for routing trace, provider/model attempts, fallback evidence, validation, usage and budget snapshot;
4. confirm that an explicit cloud model fails closed if its credential/provider is unavailable;
5. confirm that a local-only Project performs no cloud calls;
6. run `npm run check` on the repository before packaging a development build.

For live paid-provider transport validation, use the opt-in smoke workflow documented in [CLOUD_SMOKE.md](CLOUD_SMOKE.md).
