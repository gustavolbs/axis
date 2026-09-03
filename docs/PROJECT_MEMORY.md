# Project Memory — provider-neutral repository intelligence

Status: architecture contract for the multi-company Axis workbench.

This document carries forward the Project Memory direction added to `main` after PR #75 branched, while separating it from the implementation-status checklist in `CODEX_CLAUDE_DESKTOP_PARITY.md`.

## Product invariant

Project Memory belongs to the **Project**, not to an AI provider.

The owning identity is conceptually:

```text
Company + Project + repository/workspace identity
```

Claude Accounts, ChatGPT/Codex Accounts, API-key connections, Ollama, the desktop runtime and Local Workers are consumers/producers of that memory. They never become the memory owner.

A model switch inside the same authorized Project should not force the next model to rediscover validated repository knowledge from zero. A Company or Project switch must never inherit that knowledge implicitly.

## Current foundation

`src/repo-intelligence.ts` already provides the durable storage primitives:

- typed facts: architecture, convention, invariant, regression, procedure, episodic and failure;
- source paths and source fingerprints;
- observed and last-validated Git SHA;
- confidence, freshness/stale state and timestamps;
- bounded task-ranked retrieval;
- regression memories that remain high-priority compatibility constraints;
- Git-change episodes and source-fingerprint revalidation;
- atomic file replacement and an inter-process memory lock;
- optional low-reasoning learning after an evidence-backed engineering run.

Current source and tests remain authoritative over stored memory.

PR #75 adds the first provider-neutral consumption bridge: **Project Chat and Cowork now resolve the same Company + Project + repository memory scope**. A durable fact learned by a validated Cowork run can therefore be retrieved by a later Project Chat using Claude, Codex, an API-key model or Ollama, provided that connection is authorized for the same Project. Chat does not promote its free-form answer into durable memory.

## Isolation

The effective identity must include all of:

```text
companyId
projectId
repository identity
workspace/sub-project identity
```

The provider, model, authentication method and session id are intentionally not part of the durable-memory ownership key.

Consequences:

- two connections in the same Project can share validated knowledge;
- two models on the same connection can share validated knowledge;
- a later desktop/worker consumer can share the Project memory when it resolves the same Project identity;
- two Projects in the same Company do not share memory automatically;
- two Companies do not share memory automatically even when they reference the same Git origin or physical checkout;
- raw provider-private memory is not imported as authoritative Project Memory.

Tests must cover same-repository/different-Company and same-repository/different-Project cases explicitly.

## Memory classes

The target model separates two classes instead of treating every historical event as a durable fact.

### Durable knowledge

Examples:

- architecture boundaries;
- conventions;
- invariants;
- regression-sensitive behavior;
- repeatable procedures;
- durable decisions;
- repository-specific gotchas.

Durable knowledge requires repository evidence and successful validation when it represents implementation truth. Speculation from a model, user-supplied prose alone, or an unsuccessful run must not silently become shared truth.

### Episodic memory and handoff

Examples:

- current goal;
- branch/worktree;
- investigation performed;
- files active or changed;
- decisions already made;
- failed approaches;
- validations already run;
- unresolved questions;
- next recommended step.

Episodes remain attributed to their session/run/worktree. Sharing an episode does not grant permissions and does not make an old observation more authoritative than the current checkout.

## Retrieval contract

Project Memory is retrieved **per task**, not dumped wholesale into a prompt.

Ranking should account for:

- fact kind;
- tags;
- source paths;
- lexical/semantic relevance;
- confidence;
- freshness;
- recency;
- Git proximity where useful.

The baseline must work without an extra LLM call. Embeddings or semantic consolidation are optional upgrades only when they demonstrate a useful retrieval gain.

A memory capsule must remain bounded and explicitly state that current repository evidence wins.

## Learning contract

The Axis runtime, rather than a provider-specific prompt convention, should eventually be the canonical event source for memory learning.

Useful lifecycle signals include:

```text
prompt
reads/searches
tool calls and results
edits/patches
commands
Git state
validation/tests
review findings
errors and repairs
context compaction
session completion
```

Only reusable, evidence-backed observations should be consolidated into durable facts. Session-specific state belongs in episodes/handoffs.

PR #75 deliberately keeps durable learning on the existing validated Cowork path. Project Chat consumes memory but does not write model-generated facts. This avoids turning conversational speculation into cross-provider truth before the unified tool/event runtime exists.

## Cross-provider handoff target

A future handoff should contain at least:

```text
companyId
projectId
session/run id
origin connection/model
branch/worktree
createdAt
goal
investigation summary
active/changed files
decisions
failed attempts
validation state
open questions
next step
```

Switching Claude → Codex → Ollama → another authorized connection in the same Project should consume the relevant durable-memory capsule plus the current handoff, without replaying the full historical transcript or re-reading the entire repository.

## Concurrency

Concurrent sessions/worktrees may share durable Project knowledge, but their episodes and mutations remain separately attributed.

Memory writes must remain atomic and locked so two sessions cannot overwrite each other's learning. A worktree must never use shared memory as justification to mutate another worktree.

## Product UI target

A later Project Memory surface should support:

- search;
- source/evidence inspection;
- freshness and stale state;
- origin/session/model metadata where applicable;
- edit/correct;
- pin/unpin;
- revalidate;
- forget individual facts;
- reset Project Memory without deleting conversations or credentials.

The UI must make it clear whether an item is durable knowledge or session handoff state.

## External clients

Axis remains the source of truth. External memory systems may be optional adapters, not mandatory infrastructure.

An eventual bridge should prefer **MCP stdio/on-demand** so Claude Code, Codex CLI, Cursor or another MCP-capable client can query the same Project Memory without requiring:

- Docker;
- a fixed local port;
- a permanently resident daemon;
- an Axis cloud backend.

External imports/exports must be reviewable and must not copy credentials or silently merge memories across Companies.

## Deferred after PR #75

PR #75 stops after establishing multi-company ownership, Project-aware Chat/Cowork, review surfaces and the first shared Project Memory consumption path.

The next runtime-focused PRs should own:

1. the unified model → tool call → result loop and typed event transcript;
2. runtime-driven Project Memory capture instead of provider-specific lifecycle hooks;
3. structured cross-provider/session handoffs;
4. Project Memory inspection/edit/forget UI;
5. optional MCP stdio bridge;
6. richer Repo Impact Graph / GraphRAG indexing as a later optimization, not a prerequisite for the memory contract.
