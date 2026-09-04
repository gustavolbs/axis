# P1 Multi-Company Agent Runtime Gate

Date: 2026-09-04
Branch: `test/p1-multicompany-agent-runtime-gate`
Baseline: `main` at `686e7dd53baab56214973865c0e71b209ece1c5c`

# P1 Gate Result

**FAIL**

The merged P1 foundations are materially stronger than the old parity checklist suggests, and the real product composition now executes Chat and Cowork through the same `AgentRuntime`. However, P1 must not be declared complete yet: several acceptance requirements are only proven at module/fixture level or are not wired through the real product path.

A green CI run is required for this branch, but green CI does not change this gate to PASS while the blockers below remain.

## Preconditions

- PASS — CHAT C / provider-neutral Git and managed-worktree foundation is merged.
- PASS — CHAT I / Chat + Cowork product composition through `AgentRuntime` is merged.
- PASS — CHAT J / effective runtime policy, redaction and security hardening is merged.
- PASS WITH FORMAL BLOCKER — G2 is resolved as an accepted fail-closed blocker. ChatGPT/Codex Account is intentionally not admitted into the canonical runtime until Axis can prove pre-execution interception of every model-visible tool call.

## Acceptance matrix

| # | Requirement | Result | Product-level evidence / limitation |
| --- | --- | --- | --- |
| 1 | Chat and Cowork use the same `AgentRuntime` | PASS | `AgentProductRuntime` is the single product composition path. `test/agent-product-runtime.test.ts` exercises Chat and Cowork through the same instance while changing only scoped authority/tool catalogs. |
| 2 | Real engineering loop | PASS for local runtime/tool integration; live-provider matrix PARTIAL | `test/agent-product-runtime.test.ts` drives search → read → edit → failing real process validation → repair → passing validation → real Git diff against a temporary repository. Filesystem, process and Git are real local implementations; the provider transport is scripted, so this does not by itself prove every live Account/API transport. |
| 3 | Safe parallel Git/worktrees | PASS | Cowork creates or recovers a Company/Project/job-owned checkout before AgentRuntime composition, persists and revalidates its exact root across restart, isolates jobs, preserves the source checkout, and refuses cleanup when dirty or unmerged work remains. |
| 4 | Company isolation E2E | PASS for canonical runtime/tool boundaries; live UI/provider matrix PARTIAL | Product composition rejects forged Company and cross-Project Connection selection before credentials/provider execution. Filesystem, process, Git, MCP, browser, memory and runtime-policy suites contain cross-Company negative coverage. A single live matrix spanning every external provider/resource is not present in CI. |
| 5 | Connection isolation E2E | PARTIAL | Connection identity is immutable and distinct even for the same provider/auth family; native adapter tests cover Account/API-key architecture and no silent model/connection fallback. CI does not exercise two real Claude/ChatGPT accounts or two real API keys simultaneously because live credentials are intentionally absent. |
| 6 | Account/API Key same architecture | PARTIAL | Claude Account, OpenAI API Key, Anthropic API Key and Ollama enter through `AgentProviderAdapter`. ChatGPT/Codex Account remains fail-closed under G2; therefore the complete Account/API-key acceptance matrix is not yet satisfied. |
| 7 | Local/shared inference keeps Company/resource scope | PASS | Shared Ollama remains Company-neutral while sessions stay Company-scoped. The product now composes an authenticated Local Worker target that executes eligible native tools with runtime-issued authority, revalidates root/Company/capabilities, returns lifecycle, propagates cancellation, and never falls back to desktop. |
| 8 | Approvals before mutations | PARTIAL | In-process ask → pause, deny → zero execution and approve → exactly one matching mutation are covered through the product path. Pending approval checkpoints and resolutions now persist durably; full restarted product/UI acceptance evidence remains outstanding. |
| 9 | Project Memory cross-provider, same Project | PARTIAL | Project Memory persists provider-neutral lifecycle handoffs and is partitioned by Company + Project + repository identity; same physical path in another Company is denied by scope. Product tests prove lifecycle handoff retrieval, but the full live Provider X session → process restart → Provider Y product session scenario is not automated with real providers. Raw chain-of-thought is not part of the canonical protocol. |
| 10 | Crash/restart never duplicates mutations | PARTIAL | Product sessions persist transcript, authority, target, worktree, pending decision and mutation ledger. Unresolved started/unknown mutations pause after restart until explicit retry/accept/cancel, and authority mismatch fails closed. Local background-process metadata/output also persists, but a live handle restores as an explicit indeterminate orphan rather than an unsafe fake reattachment. |
| 11 | No hidden provider filesystem/shell/MCP | PASS for admitted adapters; ChatGPT/Codex blocked | Generic inference adapters require provider-managed tool execution to be disabled; Claude Account uses the canonical Account protocol; hidden/unrecognized provider tool calls fail closed. ChatGPT/Codex Account stays outside the runtime because its provider-managed tool surface cannot yet be proven suppressible/interceptable. |
| 12 | Final CI green | PENDING until PR CI | Required commands are `npm run release:validate` and `npm run check`; PR CI runs the full check on Linux and Windows plus Electron build/visual smoke/package validation on macOS. |

## Engineering-loop evidence

The product regression test uses a real temporary Git repository and real Axis filesystem/process/Git tools. The scripted model dynamically requests:

1. `search_text`;
2. `read_file`;
3. `edit_file`;
4. `process_exec` returning exit code 1;
5. another `edit_file` after the failure;
6. another `process_exec` returning exit code 0;
7. `git_diff`;
8. final response.

No final editable-file list is declared before exploration. This is valid evidence for host/runtime/tool integration, but not a substitute for live provider transport evidence.

## Multi-Company and security negatives

The merged suites provide executable fail-closed coverage for the following boundaries:

- canonical Company/Project/Connection ownership before provider credential resolution;
- exact model and Connection selection with no silent substitution;
- filesystem traversal, absolute path and symlink escape;
- process cwd escape and filtered environment;
- exact-root Git access, traversal/pathspec rejection and source checkout protection;
- MCP Company/Project resource scoping;
- browser private/link-local/metadata protection and redirect re-authorization;
- forged/foreign resource binding rejection by immutable session context;
- shared-local Connection transport without shared Company authority;
- external prompt/content treated as data rather than permission or policy authority;
- lifecycle/audit redaction of common secrets and credential-bearing URLs.

These tests are meaningful because the filesystem/process/Git implementations execute real local OS/Git operations in temporary roots. Tests that use a fake provider/browser/MCP backend are recorded as boundary evidence only, not as proof of a live external integration.

## Worktree finding

Cowork allocates or recovers a managed checkout before its mutating AgentRuntime session is composed. The job persists its Company/Project/repository/job ownership lock and passes only that exact checkout as the session root; delete is an explicit cleanup lifecycle operation. The remaining gap is full renderer/restart retention evidence rather than the former product-composition blocker.

## Restart finding

`AgentProductRuntime` and `AgentProductExecutionBridge` still keep the live pending approval continuation in process-local maps. `StandaloneJobManager` now persists and rehydrates the exact checkpoint payload needed to rebuild authority, transcript, pending decision/resolution and mutation state after an app restart; full renderer-driven continuation evidence remains outstanding.

Implemented in the product runtime: a restart-safe checkpoint persists immutable session authority, transcript, pending decision/resolution and mutation ledger state; recovery distinguishes resolved entries from `started`/`unknown` entries and does not automatically replay uncertain mutations. Managed-worktree identity and bounded background-process metadata are durable. Safe reattachment to a still-live OS process/PTY remains required for the full gate; until then, restart exposes an indeterminate orphan and disables stdin/signal/resize control.

## Exact execution-target finding

The product resolves the trusted `RemoteWorkerAgentExecutionTarget` before session start and composes only its supported filesystem, foreground-process and Git-read capabilities into immutable authority. The authenticated per-call protocol carries non-secret session/root/tool identity plus an explicit runtime grant, reconstructs a bounded checkout, revalidates scope on the Worker, propagates cancellation, applies content mutations by compare-and-swap, and returns progress/activity/result to the canonical lifecycle. Unsupported durable-state categories are absent from the remote catalog and never fall back to desktop.

## Live-provider finding

CI intentionally has no user Account sessions or production API keys. Therefore it cannot truthfully prove the requested live matrix of two accounts of one provider, two API keys of one provider and Account + API Key with real remote inference.

Required P1 evidence: an opt-in local/manual gate harness that consumes secret references from the normal Axis credential stores (never repository secrets), runs the same product scenario for the configured Connections, records only redacted evidence, and fails if a requested Connection/model/target is substituted. This harness must include Claude Account and at least OpenAI/Anthropic API-key paths; ChatGPT/Codex Account remains blocked until G2 is technically resolved.

## UI finding

The macOS CI runs real Electron rendering and visual smoke for the canonical runtime states, including progress and decision surfaces. The visual harness is fixture-driven rather than driven by a live provider completing the entire engineering loop. Treat this as real renderer evidence, but only partial end-to-end product evidence for the P1 gate.

## Blockers, priority order

1. **P0 — G2 / ChatGPT-Codex Account:** keep blocked until all model-visible provider tools can be suppressed or intercepted before execution.
2. **P1 — live Connection matrix harness:** prove two same-provider Accounts, two same-provider API Keys and Account + API Key using real configured Connections without leaking secrets.
3. **P1 — live product UI evidence:** drive the canonical runtime UI with the actual product lifecycle for the full engineering loop, not only isolated canonical fixtures.

## What is explicitly not claimed

- Direct Git-tool worktree tests are **not** called product-level worktree PASS.
- Scripted provider adapters are **not** called live Account/API-key PASS.
- Electron fixture rendering is **not** called full live-provider UI PASS.
- Durable checkpoint unit coverage is **not** called full renderer-driven runtime recovery.
- Local Worker BASE covers the tested eligible tool set; it does **not** claim remote background processes or Git index/ref/worktree mutations whose durable state cannot yet be transported losslessly.
- The accepted G2 blocker is **not** treated as proof that ChatGPT/Codex Account passed the runtime gate.

P1 remains **FAIL** until the P0 blockers above are resolved and the required real-product evidence is collected.
