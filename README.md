# Axis

Axis is a local-first, provider-agnostic AI engineering and work command center for macOS. The desktop app owns the complete engineering loop itself: repository investigation, planning, implementation, deterministic validation, review, repair, routing, cost controls and persistent repository intelligence. Its Work Hub brings work sources and connectors into the same desktop environment while preserving project and organization isolation.

Claude Desktop is not an Axis host and Axis does not expose an MCP integration. Anthropic models may still be configured as ordinary inference providers alongside OpenAI and local Ollama models.

## Architecture

```text
Developer
   │
   ▼
Axis.app
   │
   ▼
Electron renderer
   │
   ▼
isolated preload IPC
   │
   ▼
in-process DesktopAppRuntime
   │
   ├── Projects / credentials / budgets
   ├── Cognitive router
   ├── Repo Intelligence
   ├── Research broker
   └── Agent Runtime
          │
          ├── Ollama on this Mac
          ├── authenticated Windows inference worker (optional)
          ├── Anthropic API (optional)
          └── OpenAI API (optional)
   │
   ▼
plan → mutate → validate → review → repair → learn
```

There is no browser console, dashboard service, localhost control-plane server, or shared MCP control-plane configuration in the shipped product. The renderer calls the runtime through a narrow Electron IPC bridge.

## Agent lifecycle

```text
Goal
  ↓
Impact analysis
  ↓
optional Architect → Critic → Judge deliberation
  ↓
repository evidence / optional external research
  ↓
material user decision only when genuinely required
  ↓
Investigation
  ↓
Planning
  ↓
dependency-ordered implementation DAG
  ↓
Implementation
  ↓
Deterministic validation
  ↓
Independent adversarial review
  ↓
bounded repair with cumulative regression ledger
  ↓
Quality gate
  ↓
Repository learning
  ↓
Result
```

The Agent Runtime—not a model adapter—owns workspace access, repository memory, evidence selection, planning, mutation, validation, review/repair, privacy and budgets.

See [docs/PREMIUM_LOCAL_AGENT.md](docs/PREMIUM_LOCAL_AGENT.md).

## Desktop development

Requirements:

- macOS for the packaged desktop experience and Keychain-backed secrets;
- Node.js 22+;
- npm;
- Ollama for local inference, or at least one configured cloud provider;
- optional Windows worker for local inference on a separate machine.

Install and launch:

```bash
npm install
npm run desktop
```

Build without launching Electron:

```bash
npm run build
```

Validate the repository:

```bash
npm run check
npm test
```

Package unsigned macOS development artifacts:

```bash
npm run desktop:pack:mac
```

The production renderer is built into `app-dist/`; the Electron main process imports `DesktopAppRuntime` directly from `dist/` and does not start a web server.

## Projects and model routing

Projects isolate workspace, organization identity, credentials, routing policy, model selection, budgets and Repo Intelligence scope.

Supported routing policies:

```text
auto
local-first
balanced
speed-first
deep
frontier-only
```

Important invariants:

- `speed-first` may select an eligible cloud model directly, without a mandatory local-model pre-pass;
- `local-first` stays local when healthy local compute satisfies policy;
- explicit provider/model selection is exact or rejected, never silently replaced;
- `cloudAllowed` and provider allowlists are hard constraints;
- provider fallback cannot silently cross a material privacy/cost boundary;
- budget admission happens before provider I/O;
- model availability comes from provider discovery rather than a stale hardcoded cloud-model list.

See [docs/MULTI_PROVIDER_FOUNDATION.md](docs/MULTI_PROVIDER_FOUNDATION.md).

## Providers

Axis currently supports these inference paths:

- **Ollama** — local inference on the Mac;
- **Windows worker** — authenticated local-network inference compute, with repository execution still owned by the Mac app;
- **Anthropic** — optional cloud inference provider;
- **OpenAI** — optional cloud inference provider.

Cloud credentials use macOS Keychain for durable desktop storage or environment references where supported. Raw API keys are not written to Project metadata, telemetry or prompts.

The Windows worker is compute only. It does not host the desktop agent, project state, routing policy or repository intelligence.

Recommended Windows worker settings for the 27B local path:

```text
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
```

Execution topology:

| Mode | Behavior |
| --- | --- |
| `local` | Use Ollama on the Mac for local inference. |
| `remote` | Require the authenticated Windows worker for local inference. |
| `auto` | Prefer the Windows worker and fall back to Mac Ollama when allowed. |

```text
LOCAL_CODER_EXECUTION_MODE=local|remote|auto
```

Project-aware multi-provider routing is a separate layer above this local-compute topology.

See [docs/REMOTE_WORKER_ARCHITECTURE.md](docs/REMOTE_WORKER_ARCHITECTURE.md) and [docs/WINDOWS_REMOTE_SETUP.md](docs/WINDOWS_REMOTE_SETUP.md).

## App state

Axis intentionally keeps the existing standalone state root for backward compatibility:

```text
~/.local-coder/
```

The primary settings file is:

```text
~/.local-coder/settings.json
```

Override paths when needed:

```text
LOCAL_CODER_HOME=/custom/path
LOCAL_CODER_SETTINGS_PATH=/custom/path/settings.json
```

Worker bearer tokens may be supplied explicitly through `LOCAL_CODER_REMOTE_WORKER_TOKEN` or referenced from macOS Keychain through `LOCAL_CODER_REMOTE_WORKER_CREDENTIAL_REF`. New app settings never persist the raw worker token.

## Research broker

External research is optional and goes directly through configured infrastructure. Retrieved text is treated as untrusted evidence, never executable instructions.

Enable a trusted SearXNG instance:

```text
LOCAL_CODER_RESEARCH_ENABLED=true
LOCAL_CODER_SEARXNG_URL=http://<trusted-instance>
```

For Microsoft ecosystem questions, Axis narrows discovery to `site:learn.microsoft.com`; it does not connect to a Microsoft Learn MCP server.

## Persistent repository intelligence

Axis retains evidence-backed per-repository knowledge such as architecture boundaries, conventions, procedures, invariants, failure lessons, regression invariants, successful task episodes and Git-change history.

Authority remains:

```text
current source + executable tests
        > fresh regression/invariant memory
        > other repo intelligence
        > generic model knowledge
```

See [docs/REPO_INTELLIGENCE.md](docs/REPO_INTELLIGENCE.md).

## Eval suite

Local Agent Runtime eval:

```bash
npm run eval:agent
```

Multi-provider comparative eval dry-run:

```bash
npm run eval:providers
```

The comparative harness can run the same repository tasks against local Qwen, configured Anthropic models, configured OpenAI models and Auto Router from identical detached Git worktrees. It reports expectation pass rate, engineering quality, elapsed time, routing/provider/model attempts, fallbacks, token usage, known/unknown cost, changed files and deterministic validation outcomes.

See [docs/COMPARATIVE_EVALS.md](docs/COMPARATIVE_EVALS.md) and [docs/ROUTER_CALIBRATION.md](docs/ROUTER_CALIBRATION.md).

## Safety boundaries

- explicit workspace/editable-file boundaries;
- path traversal and symlink escape protection;
- `.git`, `.ssh`, dependency folders and secret env files blocked by workspace policy;
- validation executables allowlisted with `shell:false`;
- transactional task/plan/engineer rollback;
- authenticated Windows worker and source-address firewall rules;
- per-checkout mutation exclusion and local inference locking;
- Project/organization credential isolation;
- cloud provider allowlists and `cloudAllowed` hard constraints;
- budget admission before provider I/O;
- concurrent budget reservations and deterministic settlement;
- source-fingerprint memory staleness;
- cumulative same-run regression ledger;
- no hidden chain-of-thought persisted or exposed;
- external research content treated as data, never instructions.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for the current product checklist.

The product direction is the standalone macOS application. Automatic updates, broader multi-worker scheduling, Repo Impact Graph / GraphRAG and release-delivery automation remain post-MVP candidates.

## License

MIT
