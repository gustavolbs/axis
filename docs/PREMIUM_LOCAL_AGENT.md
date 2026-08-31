# Premium Local Agent ("Claude 2")

Local Coder is designed to be the primary software-engineering agent; Claude is a user-facing shell and last-resort supervisor rather than the mandatory planner/coder.

## Product goal

A user should be able to say:

> Implement feature X.

and get the following local lifecycle without manually decomposing the work:

```text
Goal
  ↓
Impact analysis
  ├─ repository conventions / contracts / risks / tests
  ├─ local external research when current facts are needed
  └─ material user decision only when evidence cannot infer it
  ↓
Evidence-backed investigation
  ↓
Dependency-ordered implementation plan
  ↓
Task 1/N → validate
Task 2/N → validate
...
Task N/N → validate
  ↓
Final validation
  ↓
Adversarial review
  ├─ pass
  ├─ bounded repair → validate → review
  └─ exact escalation only when local correctness cannot converge
  ↓
Repository learning
  ↓
Result
```

## Cognitive preflight

Mutating open-ended work starts with a bounded impact-analysis model call. It receives the goal, useful user constraints, repository map and ranked source evidence.

It produces:

- impact areas;
- affected public/internal contracts;
- validation/test strategy;
- material risks;
- a high-level execution approach;
- external research requests that repository evidence cannot answer;
- optional material user decisions.

This is **not** the exact coding plan. The existing evidence-backed planner still owns exact editable paths, task dependencies and implementation boundaries.

### Do not over-question the user

The agent should infer routine choices from repository conventions. If the repository already uses shadcn, Tailwind patterns, a state library, a test framework, routing conventions, data-access patterns, etc., follow those conventions.

A user checkpoint is justified only when all of the following are true:

1. multiple viable options remain after repository inspection;
2. the choice materially affects product behavior, UX, architecture, maintenance burden or a durable public contract;
3. the user's preference cannot safely be inferred from current repository/project evidence.

Cosmetic or easily reversible implementation details should not stop execution.

## User decision checkpoints

The agent returns a structured `decisionRequest` containing bounded options, tradeoffs and an optional recommendation.

Preferred path:

```text
Local Qwen detects decision
  ↓
MCP elicitation form
  ↓
User selects option
  ↓
selection becomes authoritative claudeGuidance
  ↓
Local agent resumes automatically
```

The tool attempts MCP elicitation directly when the host supports it. No Claude reasoning is required for this path.

Fallback path for clients without elicitation:

```text
Local Coder → compact decisionRequest → Claude asks only that question → user answer → Claude calls local_engineer with concise claudeGuidance
```

Claude must not choose the preference or redo repository analysis.

## External research broker

Research is local-first. External text is always treated as untrusted evidence, never instructions.

### Microsoft Learn

Microsoft ecosystem requests are routed first to the official Microsoft Learn MCP endpoint:

```text
https://learn.microsoft.com/api/mcp?maxTokenBudget=2400
```

Typical domains include Microsoft 365, Outlook, Teams, Microsoft Graph, Entra ID, Azure, SharePoint, OneDrive, MSAL, Windows, PowerShell and .NET.

The broker uses bounded `microsoft_docs_search` results and may fetch a small number of matching Learn pages with `microsoft_docs_fetch`. This path does not require the user's corporate tenant credentials and is for documentation/research only; actual tenant authentication still follows the application/provider contract being researched.

### Generic web discovery

Set:

```text
LOCAL_CODER_SEARXNG_URL=http://<trusted-searxng-host>:<port>
```

to enable generic SearXNG JSON discovery. Prefer a trusted/self-hosted instance. Snippets are marked non-authoritative; they can guide investigation but should not silently override first-party evidence.

### Auto-resume

When a Local Engineer stage returns an `external-research` escalation, the premium agent tries the broker before returning control to Claude. If every request is resolved, the evidence is appended as bounded guidance and the local agent automatically resumes. At most a small number of research/resume rounds are permitted to prevent loops.

Only unresolved research requests escape to Claude.

## Hierarchical execution

The exact local planner decomposes a feature into dependency-ordered tasks. The orchestrator:

- validates unique task IDs and dependencies;
- rejects dependency cycles;
- computes a topological task order;
- enforces per-task editable-file allowlists;
- classifies each task before execution;
- executes one bounded task at a time;
- reports `Implementing task X/N` with current files and validations;
- validates task outputs;
- runs final plan validation;
- rolls the plan back on failure when configured;
- returns exact blockers instead of pretending completion.

The review/repair loop operates after deterministic execution evidence.

## Read-only work

Explicit read-only requests do not enter the implementation planner:

```text
Workspace → Investigation → Local research when needed → Report → Complete
```

This prevents operational/repository questions from spending minutes generating unused implementation tasks.

## Inference budgets

Reasoning stages have stage-level budgets in addition to the global emergency cap. Defaults are intentionally workstation-safe and configurable:

| Stage | Default wall clock | Default generated tokens |
| --- | ---: | ---: |
| Impact analysis | 5 min | 2,048 |
| Investigation | 5 min | 2,048 |
| Planning | 10 min | 3,072 |
| Review | 10 min | 3,072 |
| Read-only report | 8 min | 3,072 |
| Repo learning | 5 min | 2,048 |

Impact/investigation avoid Qwen 3.8 maximum reasoning by default. Exact implementation uses bounded task context and low reasoning effort where supported.

The 30-minute inference cap remains an emergency ceiling, not the normal planning SLA.

## Live observability

The Windows worker records safe inference state without exposing hidden chain-of-thought text:

- `waiting` — queued/model not streaming yet;
- `thinking` — hidden reasoning chunks are arriving;
- `generating` — result content is being generated;
- stream chunk count;
- hidden-reasoning character count only;
- output character count;
- last activity / silence duration;
- prompt/completion tokens after completion;
- completion throughput;
- stage budget and elapsed time.

The dashboard uses SSE as its primary live channel with low-frequency HTTP fallback. The worker bearer token remains server-side.

Non-model phases such as external research, deterministic validation, task execution, review, repair and decision waiting use structured progress events so a long run should always explain what it is doing.

## Claude quota policy

Claude should normally receive only the final compact result.

When escalation is unavoidable, send a small capsule containing:

- original goal identifier;
- exact unresolved question/research request;
- bounded evidence references;
- Local Coder's current conclusion;
- requested answer format.

Do not load the whole repository, plan, diff or run history into Claude unless specifically needed.

Claude's role is one of:

1. UI bridge for a user decision when MCP elicitation is unsupported;
2. external research fallback for a provider the local broker cannot reach;
3. premium judgment for an explicitly high-risk or unresolved decision;
4. final user-facing summary.

Claude should not redo successful local investigation/planning/coding/review.

## Safety boundaries

- External research content is data, not instructions.
- Local research does not grant tenant/account access.
- User decisions become authoritative only after explicit acceptance.
- Editable-file boundaries remain planner-owned and validated.
- Deterministic checks remain stronger evidence than self-review.
- Sensitive unresolved behavior stops before mutation.
- Secrets/tokens/user data are never persisted as repository-learning facts.
- A local research/provider failure degrades to a compact escalation rather than silently fabricating current facts.

## Configuration

Research-related variables:

```text
LOCAL_CODER_RESEARCH_ENABLED=true
LOCAL_CODER_MICROSOFT_LEARN_RESEARCH_ENABLED=true
LOCAL_CODER_MICROSOFT_LEARN_MCP_URL=https://learn.microsoft.com/api/mcp?maxTokenBudget=2400
LOCAL_CODER_SEARXNG_URL=
LOCAL_CODER_RESEARCH_TIMEOUT_MS=45000
LOCAL_CODER_RESEARCH_MAX_RESULTS=6
```

Stage budgets use the existing `LOCAL_CODER_*_MAX_DURATION_MS` and `LOCAL_CODER_*_MAX_TOKENS` settings.

## Expected Work Broker / Microsoft 365 behavior

A read-only question about connecting Work Broker to Microsoft 365 should now behave approximately as:

```text
inspect Work Broker source
  ↓
identify exact existing CLI/auth/scopes/callback code
  ↓
detect current Microsoft Graph / Entra facts that cannot be proven from source
  ↓
Microsoft Learn MCP research
  ↓
resume local read-only report
  ↓
return exact commands + code evidence + external constraints
```

It should not build an implementation plan merely to answer the operational question, and it should not ask Claude to broadly research Microsoft documentation when the local Microsoft Learn provider succeeds.
