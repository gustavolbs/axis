# Quick Start — Local Coder standalone

Local Coder is a macOS desktop application. It does not require Claude Desktop, an MCP host, a browser console, or a localhost control-plane service.

## 1. Install dependencies

```bash
npm install
```

Requirements:

- Node.js 20+;
- macOS for the desktop package and Keychain-backed credentials;
- Ollama for local inference, or a configured cloud provider;
- optional Windows machine if you want to offload local inference.

## 2. Start local inference

For Mac-only local inference, start Ollama and make sure the configured model exists.

Example:

```bash
ollama pull qwen3.8:27b
```

Recommended context for the 27B path:

```text
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
```

If the model is too heavy for the Mac, configure the optional Windows worker instead. See [WINDOWS_REMOTE_SETUP.md](WINDOWS_REMOTE_SETUP.md).

## 3. Launch the app

```bash
npm run desktop
```

This command builds the Node runtime and React renderer, then launches Electron. The renderer communicates with `DesktopAppRuntime` through the isolated preload bridge; no HTTP control server is started.

## 4. Create a Project

Inside Local Coder:

1. Open **Projects**.
2. Select the repository folder with **Browse…**.
3. Choose a routing policy.
4. Keep cloud disabled for the first validation if you want a strictly local baseline.
5. Create the Project.

For the initial local-only check, use:

```text
Cloud allowed: OFF
Allowed providers: ollama
```

Make the first test with cloud disabled. Only enable a paid provider after local-only execution is working and you intentionally want cloud routing.

## 5. Run a task

Open **New chat**, select the Project, and give the agent an objectively verifiable goal. For example:

```text
Investigate this repository and identify one small, safe and objectively verifiable
improvement in code quality or tests. Implement only that improvement, run the
appropriate validation, and review the result.
```

The app owns the complete lifecycle: investigation → planning → implementation → validation → review → bounded repair → quality gate → repository learning.

## 6. Configure cloud providers when needed

Open **Settings → API keys** and add the desired provider credential. On macOS, durable secrets should use Keychain-backed storage.

Then configure **Settings → Model routing** or the Project policy.

Do not commit API keys, worker tokens, or secrets to repository files.

For paid provider smoke validation, see [CLOUD_SMOKE.md](CLOUD_SMOKE.md). The dedicated smoke command is intentionally opt-in:

```bash
npm run smoke:cloud
```

## 7. Optional Windows inference worker

The worker is inference compute only. Project state, routing, repository access, planning, mutation and validation remain owned by the Mac app.

Relevant setup guides:

- [WINDOWS_REMOTE_SETUP.md](WINDOWS_REMOTE_SETUP.md)
- [WINDOWS_HOST_ENSURE.md](WINDOWS_HOST_ENSURE.md)
- [NORDVPN_MESHNET.md](NORDVPN_MESHNET.md)

Recommended worker settings:

```text
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
```

## 8. Validate the repository

```bash
npm run check
```

Package unsigned macOS development artifacts with:

```bash
npm run desktop:pack:mac
```

See [DESKTOP_SHELL.md](DESKTOP_SHELL.md) and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for desktop packaging details.

## App state

Local Coder stores standalone state under:

```text
~/.local-coder/
```

Primary settings:

```text
~/.local-coder/settings.json
```

The Windows worker token may come from `LOCAL_CODER_REMOTE_WORKER_TOKEN` or a Keychain reference configured with `LOCAL_CODER_REMOTE_WORKER_CREDENTIAL_REF`; the settings file does not persist the raw bearer token.
