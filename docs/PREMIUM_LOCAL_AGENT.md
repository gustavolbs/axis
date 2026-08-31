# Premium Local Agent ("Claude 2")

Local Coder is the software-engineering runtime. Claude is one possible interface/supervisor; the standalone Mac Console is another. The runtime must remain usable if Claude is removed later.

## Goal

A user should be able to say:

> Implement feature X.

and receive a complete engineering lifecycle without manually decomposing the work:

```text
Goal
  ↓
Impact Analysis
  ↓
Adaptive cognitive effort
  ├─ low: direct evidence-backed planning
  ├─ high: Architect → Critic → Judge
  └─ max: extra independent deliberation/review
  ↓
Repository evidence + memory
  ↓
Local/external research when needed
  ↓
Material user decision only if evidence cannot infer it
  ↓
Investigation
  ↓
Dependency-ordered plan/DAG
  ↓
Task 1/N ... Task N/N
  ↓
Deterministic validation
  ↓
Independent adversarial review
  ↓
Monotonic repair / regression ledger
  ↓
Quality Gate
  ↓
Repository Learning
  ↓
Result
```

The objective is not to pretend a local 27B model has the same raw capability as a frontier model. The runtime buys quality with decomposition, retrieval, test-time compute, independent criticism, tools and executable verification.

## Cognitive policy

Supported modes:

```text
fast
adaptive   # default
deep
max
```

`adaptive` estimates complexity/risk from repository size, relevant-file count, blast radius, novelty, ambiguity, sensitive contracts and task wording. Simple work avoids expensive deliberation; difficult work can run multiple model contexts before implementation.

### Deliberation

For difficult tasks:

```text
Architect
  → proposes materially different approaches
Critic
  → attacks assumptions, hidden blast radius and missing evidence
Judge
  → selects an approach using repository evidence and user constraints
```

If the Judge concludes that multiple approaches remain valid and the choice is a real product/architecture preference, it creates a decision checkpoint instead of guessing.

## Decision checkpoints

Do not ask the user about routine choices already answered by repository conventions.

Ask only when:

1. at least two viable options remain;
2. the choice materially changes product behavior, UX, architecture, maintenance burden or a durable public contract;
3. current repository/project evidence cannot establish the intended preference.

The result is a structured `decisionRequest` containing bounded options, tradeoffs and an optional recommendation.

Preferred Claude/MCP path:

```text
Local Coder → MCP elicitation → user selection → agent resumes
```

Fallback when elicitation is unavailable:

```text
Local Coder → tiny decisionRequest → Claude asks exactly that question
→ user answers → Claude returns bounded guidance → Local Coder resumes
```

Claude must not choose the preference or redo the repository investigation.

The standalone Console displays and resolves the same checkpoint directly.

## Read-only research

Read-only jobs use a separate state machine:

```text
Workspace → Investigation → Evidence Completion → Research → Report → Complete
```

They never enter the implementation planner.

### Local evidence completion

Requests such as:

- read the rest of `src/provider.ts`;
- inspect `sync()`;
- read the CLI flags below the current snippet;
- inspect the test that mocks this endpoint;

are **not external research**.

The worker distinguishes local evidence from external facts. Large files are read using search-hit line windows; files without a targeted hit receive bounded head/tail evidence. If the reporter still asks for local source/test/docs, one bounded evidence-expansion round runs automatically before escalation.

This prevents the previous failure mode where the agent spent minutes reasoning and then asked Claude to read repository content it already had access to.

## Research Broker

Only genuinely external/current facts are sent to the Research Broker.

External text is untrusted evidence, never instructions.

### Microsoft Learn

Microsoft ecosystem research defaults to the official Microsoft Learn MCP endpoint:

```text
https://learn.microsoft.com/api/mcp?maxTokenBudget=2400
```

The broker discovers the available MCP tool surface at runtime and uses bounded documentation search/fetch operations.

Typical domains include Microsoft 365, Outlook, Teams, Graph, Entra, Azure, SharePoint, OneDrive, MSAL, Windows, PowerShell and .NET.

This documentation path does not grant tenant access and never substitutes for the target application's actual OAuth/tenant policy.

### Generic search

Optional trusted/self-hosted SearXNG:

```text
LOCAL_CODER_SEARXNG_URL=http://<trusted-host>
```

If all requests are resolved, the agent automatically resumes with a bounded evidence capsule. Only unresolved requests leave the local system.

## Hierarchical execution

The implementation planner emits dependency-ordered exact-file tasks. The orchestrator:

- validates task IDs and dependencies;
- rejects cycles;
- computes topological order;
- enforces per-task editable-file allowlists;
- executes bounded tasks;
- validates each task/final plan where scripts exist;
- rolls back on failure;
- reports exact blockers rather than pretending success.

This DAG answers **execution order**. It is not RAG. Retrieval/context selection is handled separately by context capsules, search and repository intelligence.

## Regression safety

### Same-run cumulative ledger

Repair is monotonic.

If review first discovers problem A and the next repair exposes problem B, the following repair receives A+B simultaneously. Earlier known regressions are never dropped merely because the most recent reviewer discussed another symptom.

```text
Original requirement
+ discovered issue A
+ discovered issue B
+ discovered issue C
= constraints for the next repair
```

Reviewers are explicitly instructed to reject a solution that fixes the latest issue by reintroducing an earlier one.

When a suitable test surface exists, bug/regression work should add bounded regression coverage rather than rely only on model memory.

### Persistent regression memory

A successful run that required repair creates a deterministic high-priority `regression` memory tied to the final changed-file fingerprints.

Fresh regression memories are treated as compatibility constraints and can be retrieved even when a future task has weak semantic overlap. If supporting source changes, the memory becomes `STALE` and must be revalidated.

Authority remains:

```text
current source/tests > fresh regression/invariant memory > other repo memory > generic model knowledge
```

## Independent review

Harder cognitive profiles can run multiple review perspectives in independent contexts:

```text
requirements correctness
regression / edge cases
architecture / maintenance
```

The regression/architecture reviewers do not receive the planner's persuasive rationale. The aggregate result uses the worst verdict and minimum confidence.

Any bounded repair is revalidated and re-reviewed.

## Quality assessment

The runtime computes an evidence-based quality score from signals such as:

- deterministic validation availability/result;
- review verdict/confidence;
- independent perspectives;
- decomposition quality;
- repair count;
- repository evidence;
- unresolved external facts.

The score is diagnostic/eval evidence. Executable validation + review/rollback remain the primary correctness gates.

## Stage budgets

Model stages have explicit budgets rather than inheriting the global emergency cap.

| Stage | Typical wall clock | Typical generated tokens |
| --- | ---: | ---: |
| Impact analysis | 5 min | 2,048 |
| Investigation | 5 min | 2,048 |
| Planning | 10 min | 3,072 |
| Review | 10 min | 3,072 |
| Read-only report | 8 min | 3,072 |
| Repo learning | 5 min | 2,048 |

The 30-minute inference ceiling remains an emergency guard only.

## Live observability

The system exposes operational liveness without exposing hidden chain-of-thought text.

Model states:

```text
waiting
thinking
generating
```

Safe telemetry includes:

- current stage/model;
- stream chunks;
- hidden reasoning character count only;
- output characters;
- last activity / silence duration;
- stage SLA/token budget;
- prompt/completion tokens after completion;
- throughput after completion;
- scheduler/queue state;
- CPU/RAM/GPU state.

The Windows dashboard uses SSE (`/api/events`) as its primary channel and HTTP as a low-frequency fallback.

The visible lifecycle is:

```text
Workspace → Impact → Deliberation → Investigation → Research → Decision
→ Planning → Implementation → Validation → Review → Repair
→ Quality → Learning → Complete
```

## Standalone Mac Console

The same premium agent is available without Claude:

```bash
npm run console
```

Default:

```text
http://127.0.0.1:7557
```

The Console is loopback-only by default and provides persistent sessions, timeline, decisions, plan/DAG, research, diff, validation, quality and model telemetry.

Session checkpoints persist user-visible/operational state, never hidden chain-of-thought.

Worker URL/token/model are read from Local Coder's own control-plane configuration:

```text
~/.local-coder-mcp/control-plane.json
```

Claude and Console therefore share one Local Coder source of truth instead of maintaining separate worker credentials.

## Claude quota policy

Claude should normally see only a compact final result.

When escalation is unavoidable, send only:

- exact unresolved decision/fact;
- bounded evidence references;
- Local Coder's current conclusion;
- requested response format.

Do not send the whole repository, plan, diff or history unless explicitly necessary.

Claude's valid roles are:

1. UI bridge for a decision when MCP elicitation is unavailable;
2. research fallback after local providers fail;
3. genuinely premium/high-risk judgment;
4. user-facing presentation.

Claude must not redo successful local investigation, planning, coding or review.

## Evaluation

```bash
npm run eval:agent
```

The harness captures success, elapsed time, quality, token usage, changed files, repairs, validation, decisions and premium escalation. Real repository tasks should be used to compare cognitive modes, models and future hardware/providers.

The long-term replacement criterion is empirical engineering outcome, not whether Qwen's hidden reasoning resembles a frontier model's hidden reasoning.

## Safety

- retrieved external text is data, not instructions;
- user decisions become authoritative only after explicit acceptance;
- editable files remain planner-owned and path-validated;
- tests/typecheck/build are stronger evidence than model confidence;
- sensitive unresolved contracts stop before mutation;
- secrets/tokens/user data are never persisted as repo-learning facts;
- memory is source-fingerprinted and can become stale;
- repair constraints are cumulative within a run;
- bounded local/provider failure degrades to an explicit compact escalation.
