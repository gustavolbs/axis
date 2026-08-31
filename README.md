# local-coder-mcp

Local-first software-engineering agent with two first-class interfaces:

- **Claude / MCP** — Claude can delegate engineering while Local Coder performs the heavy repository work;
- **Local Coder Console** — standalone Mac control plane for running the same agent without Claude.

The core runtime is intentionally interface-independent. Today the default execution model is Qwen3.8 27B on a remote Windows Ollama worker; future cloud/frontier providers can be added behind the same orchestration layer without changing the agent contract.

## v0.14 architecture

```text
                    ┌───────────────────────┐
                    │        Developer      │
                    └───────────┬───────────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
                    ▼                       ▼
            Claude Desktop/Code      Local Coder Console
                 MCP UI                    Mac UI
                    │                       │
                    └───────────┬───────────┘
                                ▼
                       Mac control plane
                                │
                         NordVPN Meshnet
                                │
                                ▼
                    Windows worker :7337
                                │
               ┌────────────────┼─────────────────┐
               ▼                ▼                 ▼
          Repo/Graph-ish      Qwen/Ollama     Build/Test/Git
           intelligence        reasoning       worktrees
               │                │                 │
               └────────────────┼─────────────────┘
                                ▼
                         Premium agent loop
```

The Windows worker keeps Ollama loopback-only and receives authenticated jobs from the Mac. It reconstructs bounded disposable worktrees rather than directly editing the live Mac checkout.

## Premium agent lifecycle

For a request such as:

```text
Implement feature X. Analyze the impact, break it into safe steps, execute it and validate the result.
```

Local Coder runs an adaptive lifecycle:

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
Implementation task 1/N ... N/N
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

Cognitive effort is adaptive (`fast`, `adaptive`, `deep`, `max`). Harder tasks can spend more test-time compute on independent proposals, criticism and review instead of asking one giant model call to solve everything at once.

See [docs/PREMIUM_LOCAL_AGENT.md](docs/PREMIUM_LOCAL_AGENT.md).

## Read-only research path

Explicit read-only work skips implementation entirely:

```text
Workspace
  ↓
Investigation
  ↓
complete missing local evidence
  ↓
Research Broker when an external fact is genuinely needed
  ↓
Report
  ↓
Complete
```

A request such as “read the rest of this file/test” is **local evidence**, not external research. Large files are retrieved around search hits, with bounded head/tail fallback and an automatic local evidence-completion round before any external escalation.

Microsoft ecosystem research can use the official Microsoft Learn MCP provider. Generic web discovery can use an explicitly configured SearXNG provider.

## Persistent repository intelligence

Local Coder maintains evidence-backed per-repository memory without fine-tuning model weights.

It can retain:

```text
architecture boundaries
conventions
procedures
invariants
failure lessons
regression invariants
successful task episodes
Git-change history
```

Authority order remains:

```text
current source + executable tests
        > fresh regression/invariant memory
        > other repo intelligence
        > generic model knowledge
```

Facts are tied to source fingerprints and Git state. If supporting code changes, memories become stale and must be revalidated.

### Regression memory

If a change only converges after repair, Local Coder records a high-priority `regression` memory describing the combined behavior that survived the final validation/review. Fresh regression memories are retrieved even when a future task has little semantic overlap.

Inside the **same run**, repair is monotonic: every discovered regression is added to a cumulative ledger. A later repair receives A+B+C simultaneously and must not solve the newest issue by reintroducing an earlier one.

Tests remain stronger than memory. The planner/reviewer asks for bounded regression coverage when the repository already provides an appropriate test surface.

See [docs/REPO_INTELLIGENCE.md](docs/REPO_INTELLIGENCE.md).

## Decision checkpoints

Local Coder should not ask the user to choose routine implementation details that repository conventions already answer.

When multiple materially different product/architecture choices remain, it produces a structured decision request with options, tradeoffs and an optional recommendation.

Preferred MCP path:

```text
Local Coder detects material choice
  ↓
MCP elicitation
  ↓
user selects
  ↓
agent resumes
```

If the Claude host cannot elicit directly, Claude should only bridge the exact question and return the user's answer as bounded guidance. It must not redo the repository analysis.

The standalone Console displays these decision checkpoints itself.

## Local Coder Console

The Console is the non-Claude interface to the same runtime.

```bash
npm run console
```

Default bind:

```text
http://127.0.0.1:7557
```

The Console is loopback-only by default and reads the shared control-plane configuration rather than depending on Claude configuration.

It exposes:

- persistent sessions;
- live task timeline;
- impact/deliberation/planning state;
- decision checkpoints;
- plan/DAG metadata;
- research evidence;
- diff/validation/result panels;
- quality score;
- model liveness and token/throughput telemetry.

Standalone session checkpoints store goal/status/decisions/results/timeline, not hidden chain-of-thought.

## Live observability

The worker reports operational state without exposing hidden reasoning text.

Model stream states:

```text
waiting
thinking
generating
```

Telemetry includes:

- current cognitive/engineering stage;
- stream chunk count;
- hidden-reasoning character count only;
- output character count;
- last stream activity / silence duration;
- elapsed time and stage SLA;
- prompt/completion tokens when available;
- tokens/second after completion;
- scheduler queue state;
- machine CPU/RAM/GPU telemetry.

The Windows dashboard is **SSE-first** via `/api/events`, with low-frequency HTTP fallback. It presents the full premium lifecycle:

```text
Workspace → Impact → Deliberation → Investigation → Research → Decision
→ Planning → Implementation → Validation → Review → Repair
→ Quality → Learning → Complete
```

## Stage budgets

Reasoning calls have stage-specific budgets instead of sharing the global emergency ceiling.

Typical defaults:

| Stage | Wall clock | Generated tokens |
| --- | ---: | ---: |
| Impact analysis | 5 min | 2,048 |
| Investigation | 5 min | 2,048 |
| Planning | 10 min | 3,072 |
| Review | 10 min | 3,072 |
| Read-only report | 8 min | 3,072 |
| Repo learning | 5 min | 2,048 |

The global 30-minute single-inference cap remains an emergency guard, not a normal planning SLA.

## Research Broker

Research is local-first and retrieved text is treated as untrusted evidence, never as executable instructions.

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

When a local stage requests external research, the broker attempts to resolve it and automatically resumes the agent. Only unresolved facts leave the local system.

## Default Windows model

Recommended current worker:

```text
LOCAL_CODER_MODEL=qwen3.8:27b
LOCAL_CODER_NUM_CTX=16384
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
```

16K is deliberate for the current 12 GB VRAM / 64 GB RAM worker. The runtime prioritizes evidence selection, search, memory and staged reasoning over dumping indiscriminate repository context into the model.

The architecture is model-agnostic: Qwen is a provider/model used by the runtime, not the product identity.

## Shared control-plane configuration

Worker connection state belongs to Local Coder, not Claude.

Mac source of truth:

```text
~/.local-coder-mcp/control-plane.json
```

The Claude installer and standalone Console use the same worker URL/token/model configuration. Environment variables may explicitly override it.

This avoids configuration drift where Claude and the Console accidentally use different worker credentials.

## Windows setup / repair

Canonical Windows command, PowerShell as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ensure-windows-host.ps1 `
  -MacIp <MAC_MESHNET_IP> `
  -ListenHost <WINDOWS_MESHNET_IP>
```

`ensure-windows-host.ps1` updates/builds/repairs the host, scheduled tasks, dedicated Node runtime, listener ownership, firewall shape and worker/dashboard health.

Use `-VerifyOnly` to validate without reinstalling.

See:

- [docs/WINDOWS_HOST_ENSURE.md](docs/WINDOWS_HOST_ENSURE.md)
- [docs/WINDOWS_REMOTE_SETUP.md](docs/WINDOWS_REMOTE_SETUP.md)
- [docs/NORDVPN_MESHNET.md](docs/NORDVPN_MESHNET.md)

## Claude / MCP setup

On Mac:

```bash
npm run install:claude:worker -- --host <WINDOWS_MESHNET_IP>
npm run install:routing
npm run install:claude-token-saver
```

The worker token is persisted independently in the Local Coder control-plane config. Do not rotate it during normal host maintenance.

Claude routing principle:

```text
normal engineering
  → Local Coder first

local success
  → Claude presents result; do not redo work

material decision
  → elicitation or tiny question bridge

unresolved external fact / genuinely premium judgment
  → compact escalation only
```

## Execution modes

| Mode | Behavior |
| --- | --- |
| `local` | Ollama + repository execution on the same machine. |
| `remote` | Authenticated remote worker required; no silent Mac fallback. Recommended. |
| `auto` | Prefer remote and optionally fall back locally. Use intentionally. |

```text
LOCAL_CODER_EXECUTION_MODE=local|remote|auto
```

## MCP tools

The preferred open-ended entrypoint is **`local_engineer`**.

Other tools remain available for health, classification, workspace discovery/search/context preparation, bounded task/plan execution, lazy run retrieval and telemetry.

Use the compact task/plan routes when the solution and editable boundaries are already known. Use `local_engineer` when the user gives an outcome and expects the system to investigate, decompose, implement and validate it.

## Eval suite

Agent quality must be measured, not assumed.

```bash
npm run eval:agent
```

The harness records task success, elapsed time, quality score, token counts, changed files, repairs, validation, user decisions and premium escalation. Seed workloads should be replaced with real repository tasks before using scores as a model/hardware decision signal.

## Safety boundaries

- explicit workspace and editable-file boundaries;
- path traversal / symlink escape protection;
- `.git`, `.ssh`, dependency folders and secret env files blocked by workspace policy;
- validation executables are allowlisted and run with `shell:false`;
- transactional task/plan/engineer rollback;
- authenticated remote worker + source-address firewall rules;
- dedicated Windows Node runtime and listener ownership verification;
- no silent local fallback in strict remote mode;
- per-checkout mutation exclusion and machine-wide local inference lock;
- clone-scoped memory isolation;
- source-fingerprint memory staleness;
- cumulative same-run regression ledger;
- compact escalation instead of unsafe guessing;
- external research content is data, never instructions.

## Roadmap

Completed in v0.14:

- [x] adaptive cognitive effort;
- [x] Architect/Critic/Judge deliberation for difficult work;
- [x] hierarchical dependency-ordered task execution;
- [x] independent multi-perspective review;
- [x] evidence-based quality score;
- [x] read-only fast path and local evidence completion;
- [x] Microsoft Learn / optional SearXNG Research Broker;
- [x] structured user-decision checkpoints + MCP elicitation fallback;
- [x] persistent repo intelligence with regression memory;
- [x] cumulative same-run regression ledger;
- [x] SSE-first operational observability;
- [x] standalone persistent Mac Console;
- [x] shared Local Coder control-plane configuration;
- [x] agent eval harness.

Next architectural candidates:

- [ ] Repo Impact Graph / hybrid code GraphRAG;
- [ ] provider-agnostic inference router for local + frontier/cloud models;
- [ ] deadline/cost/latency-aware multi-worker scheduling;
- [ ] active-run cancellation propagation;
- [ ] stale mirror/index/run retention policy;
- [ ] dependency/template worktree cache optimization.

## License

MIT
