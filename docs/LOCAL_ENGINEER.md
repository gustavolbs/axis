# Local Engineer — Claude interface, local engineering loop

`local_engineer` is the preferred v0.10 entry point for an **open-ended repository engineering goal**.

Claude remains the interface the developer talks to. The Windows worker should perform as much normal engineering work as possible before consuming premium Claude reasoning.

```text
Developer
   |
   v
Claude Desktop / Claude Code
   |
   | local_engineer(workspace, goal)
   v
Windows local-coder worker
   |
   +--> retrieve persistent repo intelligence
   +--> bounded current repo evidence
   +--> investigation / reasoning
   +--> targeted searches
   +--> evidence-backed planning
   +--> bounded task execution / retries
   +--> deterministic validation
   +--> adversarial review
   +--> bounded repair
   +--> learn reusable source-backed facts
   |
   +--> success ----------------------> Claude summarizes
   |
   +--> needs-claude / escalated
              |
              v
       compact escalation capsule
              |
              v
       Claude resolves exact gap
       (reasoning / web / other tools)
              |
              | claudeGuidance
              v
         local_engineer resumes
```

## Default model profile

The recommended Windows worker uses:

```text
qwen3.8:27b
context=16384
parallel inference=1
```

The local-engineer stages express **model-agnostic reasoning intent**:

```text
investigation  high
planning       high
review         high
learning       low
coding         low/off where appropriate
```

For Qwen3.8, the Ollama client maps `high` intent to `think:true`, allowing the model's current template to select its default **xhigh** reasoning mode instead of sending the unsupported literal `high` value. Other models keep the existing behavior.

The model supports a much larger advertised context, but the worker intentionally starts at 16K. Repo intelligence and targeted evidence retrieval should improve quality before context size is increased.

## Why this is not just "ask a smaller model to act like Opus"

The local model is inside a stricter engineering protocol:

1. retrieve relevant repository memory;
2. inspect current repository structure and source evidence;
3. invalidate stale memory when source changed;
4. formulate targeted searches;
5. reason from evidence instead of model memory alone;
6. refuse implementation while material ambiguity remains;
7. decompose into small exact-file tasks;
8. execute through the transactional executor;
9. run real deterministic validation;
10. review the diff adversarially;
11. repair only inside the approved scope;
12. persist only reusable source-backed lessons after successful work;
13. escalate compactly when confidence/research/judgment is insufficient.

The target is **model + tools + evidence + accumulated repo knowledge + decomposition + feedback**, not pretending local raw intelligence equals Claude/Opus.

## Example

Developer message in Claude:

```text
Temos um repo chamado Work Broker MCP e quero usar React nele.
Entenda o projeto, quebre em etapas e faça a alteração.
```

Claude should normally call:

```text
local_engineer
  workspace=<active Project/session worktree>
  goal=<developer request>
```

The developer does not need to manually prepare an implementation plan first.

## Persistent repo intelligence

Before investigation, the worker retrieves a compact set of relevant memories such as:

```text
architecture boundaries
conventions
invariants
procedures
past task lessons
past failure lessons
recent Git changes
```

Current source and tests remain authoritative. Every source-backed memory carries fingerprints and becomes stale when its supporting file changes, including uncommitted changes.

After a successful run, a low-effort learning pass extracts a small number of reusable source-backed facts. Failed/escalated work is not promoted into durable architectural truth.

See [REPO_INTELLIGENCE.md](./REPO_INTELLIGENCE.md).

## Escalation contract

A non-success local result is **not** an instruction for Claude to redo the entire task.

It contains:

```text
kind
reason
questions[]
researchRequests[]
evidence[]
resumeWith
```

Claude resolves only that missing information.

Example:

```json
{
  "kind": "external-research",
  "reason": "Current upstream behavior cannot be established from repository evidence.",
  "questions": [
    "Which current React API contract should this repository target?"
  ],
  "researchRequests": [
    "Check the official React documentation for the relevant API behavior."
  ]
}
```

Claude can then call:

```text
local_engineer
  workspace=<same active worktree>
  goal=<same goal>
  claudeGuidance="Official documentation confirms ...; use contract X ..."
```

The worker resumes locally with the premium evidence available.

## When the local engineer intentionally asks for Claude

Host-level hard premium gates include:

- cryptographic/encryption/signature/key-derivation design;
- destructive production-data operations;
- production access-control/IAM/credential decisions.

The planner may also escalate when:

- current external documentation is required;
- product/architecture judgment is materially ambiguous;
- a sensitive auth/credential/permission behavior is unresolved;
- repository evidence is too weak;
- implementation validation fails to converge;
- adversarial review cannot establish confidence.

## Rollback semantics

If investigation/planning escalates, no implementation is applied.

If implementation fails or review requires Claude, the worker restores the execution workspace to its pre-engineer snapshots and returns no changes for Mac application.

A successful remote run returns file contents with before-state SHA-256 preconditions. The Mac applies them only when its concrete worktree still matches the state that started the run.

## Local review

The reviewer uses the same model family as planner/coder, so it is **not** independent proof.

It receives the original goal, evidence-backed plan, actual diff and deterministic validation output, and is instructed to falsify correctness rather than confirm the coder.

Tests/typecheck/lint/build remain the strongest independent evidence. Low confidence escalates rather than silently approving.

## Multiple Claude sessions

There is one Windows worker service, not one Qwen process per Claude session.

Default:

```text
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
OLLAMA_NUM_PARALLEL=1
```

So:

```text
Claude session A -> running
Claude session B -> queued
Claude session C -> queued
```

This protects the Ryzen/RTX workstation from model/build resource thrashing while still allowing any number of Claude sessions to submit work.

`local_coder_health` exposes compact queue metadata without prompts/company names.

### Optional concurrency

If later raised to `2`:

- different concrete worktree jobs may overlap in non-inference phases;
- jobs for the same checkout never overlap;
- Ollama inference remains machine-wide serialized;
- tests/builds can consume CPU/RAM concurrently.

Do not raise it merely because many Claude sessions exist.

## Engineering OS / Work Broker isolation

Engineering OS remains authoritative for company/project/session/worktree identity. Work Broker remains authoritative for company-scoped integrations and credentials.

`local-coder` receives the concrete workspace from the active Claude session and does not merge context across companies.

For repo intelligence:

- linked worktrees from the same Git clone share an opaque memory scope;
- separate clones get different memory scopes even when the origin URL is identical;
- monorepo sub-workspaces remain distinct identities;
- memory lives outside target repositories on the Windows worker.

This gives parallel worktrees shared repo familiarity without allowing a separate clone/trust context to inherit it accidentally.

## Which local-coder tool should Claude choose?

Use `local_engineer` when the user gives an outcome and expects investigation/planning/implementation.

Use `execute_local_code_task_compact` when the approach and exact editable files are already known.

Use `execute_local_code_plan_compact` when Claude already has a concrete dependency-ordered implementation plan.

`get_local_run` remains lazy; full diffs/plans should not be loaded into Claude context unless needed.
