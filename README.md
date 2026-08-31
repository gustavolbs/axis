# local-coder-mcp

Local-first software-engineering agent with one shared Agent Runtime and multiple interfaces:

- **Claude / MCP** — Claude delegates repository work to Local Coder;
- **Local Coder standalone** — browser/desktop control-plane UI using the same runtime;
- **headless/runtime APIs** — kept interface-independent so CLI/automation remain possible.

Local Coder is provider-agnostic. Qwen/Ollama remains the default local compute path, while Projects may route cognitive stages directly to Anthropic or OpenAI without a mandatory local-model pre-pass.

## Current architecture

```text
                    Developer
                       │
          ┌────────────┼─────────────┐
          ▼            ▼             ▼
      Claude/MCP   Local Coder UI   Headless host
          └────────────┼─────────────┘
                       ▼
                Mac control plane
                       │
              shared Agent Runtime
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
 Project policy   Cognitive Router   Repo Intelligence
       │               │                │
       │        ┌──────┼────────┐       │
       │        ▼      ▼        ▼       │
       │     Ollama Anthropic OpenAI    │
       │        │                       │
       │   Mac or Windows Worker        │
       └───────────────┬────────────────┘
                       ▼
            Plan / mutate / validate
                       ▼
              Review / repair / learn
```

The Agent Runtime, not a provider adapter, owns workspace access, repository memory, evidence selection, planning, mutation, validation, review/repair, routing, privacy and budgets.

## Premium agent lifecycle

```text
Goal
  ↓
Impact analysis
  ↓
optional Architect → Critic → Judge deliberation
  ↓
repository evidence / local research
  ↓
material user decision only when genuinely required
  ↓
Investigation
  ↓
Planning
  ↓
dependency-ordered task DAG
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

See [docs/PREMIUM_LOCAL_AGENT.md](docs/PREMIUM_LOCAL_AGENT.md).

## Multi-provider Projects

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

- `speed-first` may select cloud directly with zero Qwen pre-inference;
- `local-first` stays local when healthy local compute is appropriate;
- explicit provider/model selection is exact or rejected, never silently replaced;
- `cloudAllowed` and provider allowlists are hard constraints;
- cloud credentials are referenced, not stored in Project JSON;
- model availability comes from provider discovery rather than a stale hardcoded cloud-model enum;
- provider fallback cannot silently cross a material privacy/cost boundary;
- budget admission occurs before provider I/O.

See [docs/MULTI_PROVIDER_FOUNDATION.md](docs/MULTI_PROVIDER_FOUNDATION.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Credentials, pricing and budgets

Cloud credentials use macOS Keychain for durable desktop storage or environment references for headless use. Raw API keys are not returned by the administration API and are not written to Project metadata, telemetry or prompts.

Pricing is versioned/configured per provider/model with source and verification timestamp. Usage is recorded in a persistent ledger with normalized input/output/cache/reasoning token counters.

Projects support:

- daily USD budget;
- monthly USD budget;
- per-job USD budget;
- warning fractions;
- hard-stop admission;
- concurrency-safe upper-bound reservations.

For `Auto`, a cloud attempt denied by budget may fall back to an eligible local candidate. Explicit cloud selection remains fail-closed rather than silently changing the requested model.

## Windows local inference worker

Recommended current worker configuration:

```text
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
```

The Windows Worker is local **inference compute**, not the owner of the Project agent. For Project-aware execution, the agent runs on the Mac control plane; cloud calls go directly from the Mac while Qwen calls may go to the authenticated Windows worker.

Legacy strict local/remote execution remains available for compatibility.

See:

- [docs/REMOTE_WORKER_ARCHITECTURE.md](docs/REMOTE_WORKER_ARCHITECTURE.md)
- [docs/WINDOWS_HOST_ENSURE.md](docs/WINDOWS_HOST_ENSURE.md)
- [docs/WINDOWS_REMOTE_SETUP.md](docs/WINDOWS_REMOTE_SETUP.md)
- [docs/NORDVPN_MESHNET.md](docs/NORDVPN_MESHNET.md)

## Standalone Console

Run the current browser-accessible standalone control plane with:

```bash
npm run console
```

Default bind:

```text
http://127.0.0.1:7557
```

The standalone UI currently exposes three operational surfaces:

- **Agent** — sessions, decisions, plan, diff, validation, research and quality evidence;
- **Projects** — provider/model discovery, routing policy, credentials, pricing, privacy and budgets;
- **Runs** — Project execution boundary, routing trace, provider attempts/fallbacks, spend and budget evidence.

Project/provider/credential administration is restricted to loopback clients. The UI does not recompute routing or financial state; it renders backend-authoritative snapshots.

The next product step is packaging this same control plane and React UI as `Local Coder.app` on macOS while preserving `npm run console` as a fallback.

## Persistent repository intelligence

Local Coder retains evidence-backed per-repository knowledge such as architecture boundaries, conventions, procedures, invariants, failure lessons, regression invariants, successful task episodes and Git-change history.

Authority remains:

```text
current source + executable tests
        > fresh regression/invariant memory
        > other repo intelligence
        > generic model knowledge
```

See [docs/REPO_INTELLIGENCE.md](docs/REPO_INTELLIGENCE.md).

## Research Broker

Research is local-first and retrieved text is treated as untrusted evidence, never executable instructions.

Microsoft Learn defaults:

```text
LOCAL_CODER_RESEARCH_ENABLED=true
LOCAL_CODER_MICROSOFT_LEARN_RESEARCH_ENABLED=true
LOCAL_CODER_MICROSOFT_LEARN_MCP_URL=https://learn.microsoft.com/api/mcp?maxTokenBudget=2400
```

Optional generic search:

```text
LOCAL_CODER_SEARXNG_URL=http://<trusted-instance>
```

## Shared control-plane configuration

Mac source of truth:

```text
~/.local-coder-mcp/control-plane.json
```

New writes never persist the Windows worker bearer token inline; secure installs use a credential reference. Legacy v0.14 inline-token configuration remains readable for migration compatibility.

## Claude / MCP setup

On Mac:

```bash
npm run install:claude:worker -- --host <WINDOWS_MESHNET_IP>
npm run install:routing
npm run install:claude-token-saver
```

Preferred engineering entrypoint: **`local_engineer`**.

Claude routing principle:

```text
normal engineering
  → Local Coder first

local success
  → present the Local Coder result; do not redo it

material decision
  → elicitation or a tiny question bridge

unresolved external fact / genuinely premium judgment
  → compact escalation only
```

## Execution modes

| Mode | Behavior |
| --- | --- |
| `local` | Ollama + repository execution on the same machine. |
| `remote` | Authenticated remote worker required; no silent Mac fallback. |
| `auto` | Prefer remote local-compute worker and fall back to Mac Ollama when allowed. |

```text
LOCAL_CODER_EXECUTION_MODE=local|remote|auto
```

Project-aware multi-provider routing is a separate layer above this local-compute topology.

## Eval suite

```bash
npm run eval:agent
```

The existing harness records task success, elapsed time, quality score, token counts, changed files, repairs, validation, user decisions and escalation. The current roadmap extends it with per-provider/model comparisons, known cost and Auto Router calibration.

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

See [docs/ROADMAP.md](docs/ROADMAP.md) for the authoritative current checklist.

Current product-completion sequence:

1. package `Local Coder.app` for macOS;
2. propagate active-run cancellation end-to-end;
3. add opt-in real Anthropic/OpenAI smoke validation;
4. calibrate and benchmark the Auto Router with persisted execution history;
5. release/documentation hardening.

Repo Impact Graph / GraphRAG and broader multi-worker scheduling remain post-MVP candidates.

## License

MIT
