# P1 Multi-Company Agent Runtime Gate

Date: 2026-09-03
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
| 3 | Safe parallel Git/worktrees | FAIL at product composition | The Git tool layer has real managed worktree create/list/remove, source-checkout protection, dirty-tree preservation behavior, ownership locks and same-repository checks. The product session currently freezes only the Project checkout root; it does not allocate a per-task managed worktree checkout as the task root. Advertising/using worktrees from the normal product agent therefore cannot satisfy the end-to-end requirement yet. |
| 4 | Company isolation E2E | PASS for canonical runtime/tool boundaries; live UI/provider matrix PARTIAL | Product composition rejects forged Company and cross-Project Connection selection before credentials/provider execution. Filesystem, process, Git, MCP, browser, memory and runtime-policy suites contain cross-Company negative coverage. A single live matrix spanning every external provider/resource is not present in CI. |
| 5 | Connection isolation E2E | PARTIAL | Connection identity is immutable and distinct even for the same provider/auth family; native adapter tests cover Account/API-key architecture and no silent model/connection fallback. CI does not exercise two real Claude/ChatGPT accounts or two real API keys simultaneously because live credentials are intentionally absent. |
| 6 | Account/API Key same architecture | PARTIAL | Claude Account, OpenAI API Key, Anthropic API Key and Ollama enter through `AgentProviderAdapter`. ChatGPT/Codex Account remains fail-closed under G2; therefore the complete Account/API-key acceptance matrix is not yet satisfied. |
| 7 | Local/shared inference keeps Company/resource scope | PASS for Ollama/shared-local policy; Local Worker FAIL | Shared Ollama transport stays Company-neutral while each session remains Company-scoped. `AgentProductRuntime`, however, currently constructs `LocalAgentExecutionTarget` for the product path and does not execute tools through a real Local Worker `AgentExecutionTarget`; exact worker-vs-desktop execution is therefore not proven end-to-end. |
| 8 | Approvals before mutations | PARTIAL | In-process ask → pause, deny → zero execution and approve → exactly one matching mutation are covered through the product path. Pending approval checkpoints and resolutions now persist durably; full restarted product/UI acceptance evidence remains outstanding. |
| 9 | Project Memory cross-provider, same Project | PARTIAL | Project Memory persists provider-neutral lifecycle handoffs and is partitioned by Company + Project + repository identity; same physical path in another Company is denied by scope. Product tests prove lifecycle handoff retrieval, but the full live Provider X session → process restart → Provider Y product session scenario is not automated with real providers. Raw chain-of-thought is not part of the canonical protocol. |
| 10 | Crash/restart never duplicates mutations | PARTIAL | Tool contracts preserve `mutationStatus: unknown` when commit/rollback cannot be proven and avoid unsafe automatic retry. Product sessions now persist canonical transcript, authority, pending decision and mutation ledger state; managed-worktree identity and resumable background-process metadata still need end-to-end integration. |
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

The managed Git worktree backend is not the same thing as product-level worktree orchestration.

A product agent session currently starts with the Project checkout root frozen in `AgentSessionContext`. A managed worktree is created later by a tool call, but the immutable session cannot dynamically promote that new checkout into an exact Git root. Simply exposing the worktree storage directory would be unsafe/incomplete: filesystem/process could traverse into it while Git exact-root checks would still reject the storage directory itself as the managed checkout.

Required P1 fix: allocate/recover the task worktree before the mutating agent session is composed, bind that exact checkout as the session workspace root, persist its ownership identity with the job, and make cleanup an explicit job lifecycle operation. Until that exists, the main checkout cannot be considered protected by the real Cowork product path.

## Restart finding

`AgentProductRuntime` and `AgentProductExecutionBridge` keep pending approvals and active turn state in process-local maps. `StandaloneJobManager` persists conversation/job state, but it does not reconstruct the exact canonical pending tool call + permission fingerprint + runtime checkpoint after an app restart.

Implemented in the product runtime: a restart-safe checkpoint persists immutable session authority, transcript, pending decision/resolution and mutation ledger state; recovery distinguishes resolved entries from `started`/`unknown` entries and does not automatically replay uncertain mutations. Managed-worktree identity and resumable background-process metadata remain required for the full gate.

## Exact execution-target finding

The frozen runtime supports `AgentExecutionTarget`, but the product composition currently installs a `LocalAgentExecutionTarget` under the configured target ID. Renaming the ID is not equivalent to executing through Local Worker.

Required P1 fix: resolve the exact trusted execution-target implementation before session start, compose its capabilities into the immutable context, and fail explicitly if that target is unavailable. No desktop/worker fallback may occur silently.

## Live-provider finding

CI intentionally has no user Account sessions or production API keys. Therefore it cannot truthfully prove the requested live matrix of two accounts of one provider, two API keys of one provider and Account + API Key with real remote inference.

Required P1 evidence: an opt-in local/manual gate harness that consumes secret references from the normal Axis credential stores (never repository secrets), runs the same product scenario for the configured Connections, records only redacted evidence, and fails if a requested Connection/model/target is substituted. This harness must include Claude Account and at least OpenAI/Anthropic API-key paths; ChatGPT/Codex Account remains blocked until G2 is technically resolved.

## UI finding

The macOS CI runs real Electron rendering and visual smoke for the canonical runtime states, including progress and decision surfaces. The visual harness is fixture-driven rather than driven by a live provider completing the entire engineering loop. Treat this as real renderer evidence, but only partial end-to-end product evidence for the P1 gate.

## Blockers, priority order

1. **P0 — product task worktree orchestration:** create/recover a managed worktree before Cowork mutation and bind the exact checkout root to the session; preserve dirty main checkout and enforce per-job ownership/cleanup.
2. **P0 — real Local Worker execution target:** compose an actual worker `AgentExecutionTarget`; exact target failure must remain fail-closed with no desktop fallback.
3. **P0 — G2 / ChatGPT-Codex Account:** keep blocked until all model-visible provider tools can be suppressed or intercepted before execution.
4. **P1 — live Connection matrix harness:** prove two same-provider Accounts, two same-provider API Keys and Account + API Key using real configured Connections without leaking secrets.
5. **P1 — live product UI evidence:** drive the canonical runtime UI with the actual product lifecycle for the full engineering loop, not only isolated canonical fixtures.

## What is explicitly not claimed

- Direct Git-tool worktree tests are **not** called product-level worktree PASS.
- Scripted provider adapters are **not** called live Account/API-key PASS.
- Electron fixture rendering is **not** called full live-provider UI PASS.
- Durable conversation storage is **not** called exact runtime-checkpoint recovery.
- A Local Worker ID on a local execution target is **not** called Local Worker execution.
- The accepted G2 blocker is **not** treated as proof that ChatGPT/Codex Account passed the runtime gate.

P1 remains **FAIL** until the P0 blockers above are resolved and the required real-product evidence is collected.
