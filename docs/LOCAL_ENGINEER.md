# Local Engineer — Claude interface, local engineering loop

`local_engineer` is the preferred v0.9 entry point for an **open-ended repository engineering goal**.

Claude remains the interface the developer talks to. The local worker is responsible for doing as much normal engineering work as possible before consuming premium Claude reasoning.

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
   +--> bounded repo map / persistent context evidence
   +--> investigation (thinking=high)
   +--> targeted literal searches
   +--> evidence-backed planning (thinking=high)
   +--> bounded task execution / retries
   +--> deterministic validation
   +--> adversarial review (thinking=high)
   +--> bounded repair
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

## Why this is not just "ask a smaller model to act like Opus"

The local model is deliberately placed inside a stricter engineering protocol:

1. inspect repository structure;
2. retrieve bounded file evidence;
3. formulate targeted searches;
4. reason from collected evidence instead of model memory;
5. refuse implementation while material ambiguity remains;
6. decompose into small exact-file tasks;
7. execute through the existing transactional executor;
8. run real deterministic validation;
9. review the resulting diff adversarially;
10. repair only within the already-approved scope;
11. escalate compactly when confidence/research/judgment is insufficient.

The goal is outcome quality through **model + tools + evidence + decomposition + feedback**, not claiming that a local model has the same raw reasoning capability as Claude/Opus.

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

The developer does not need to manually prepare a detailed implementation plan first.

The local worker gathers evidence, creates a plan and executes it when safe.

## Escalation contract

A non-success local result is not an instruction for Claude to redo the entire task.

It contains an `escalation` object with:

```text
kind
reason
questions[]
researchRequests[]
evidence[]
resumeWith
```

Claude should resolve only that missing information.

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

Claude can then use web/repository tools and call the local worker again:

```text
local_engineer
  workspace=<same active worktree>
  goal=<same goal>
  claudeGuidance="Official documentation confirms ...; use contract X ..."
```

The local worker re-investigates with that premium evidence available and continues locally.

## When the local engineer intentionally asks for Claude

Current host-level hard premium gates include:

- cryptographic/encryption/signature/key-derivation design;
- destructive production-data operations;
- production access-control/IAM/credential decisions.

The evidence-backed planner may also escalate when:

- external/current documentation is required;
- a product or architecture choice is materially ambiguous;
- a sensitive auth/credential/permission behavior is unresolved;
- repository evidence is too weak;
- implementation validation fails to converge;
- adversarial review cannot establish confidence.

When Claude supplies the missing decision through `claudeGuidance`, bounded mechanical implementation can return to the local worker.

## Rollback semantics

The local engineer is transactional from the developer workspace's perspective.

If investigation/planning escalates, no implementation has been applied.

If implementation later fails or review requires Claude, the local execution workspace is restored to its pre-engineer snapshots and the remote response contains no changes to apply to the Mac.

A successful remote run returns file contents with before-state SHA-256 preconditions. The Mac applies them only if its concrete worktree has not changed while the Windows job was running.

## Local review

The reviewer uses the same local model family as the planner/coder, so it is not treated as independent proof.

It is deliberately adversarial and receives:

- original goal;
- plan decisions;
- actual diff;
- deterministic validation output.

Tests/typecheck/lint/build remain the strongest independent evidence. A low-confidence review escalates rather than silently approving.

## Multiple Claude sessions

There is **one Windows worker service**, not one heavyweight model process per Claude session.

Every Claude Desktop/Code session may connect through its own local stdio MCP process and submit work to the same Windows worker.

Default:

```text
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
OLLAMA_NUM_PARALLEL=1
```

This means:

```text
Claude session A -> job A -----> running
Claude session B -> job B -----> queued
Claude session C -> job C -----> queued
```

The sessions remain independent; only the Windows execution resource is serialized.

`local_coder_health` exposes compact queue metadata (`activeJobs`, `queuedJobs`, job kind and opaque isolation key) without exposing prompts/company names.

### Why default to one heavy job

For the initial Ryzen 9 / RTX 3060 12 GB / 64 GB RAM host, the priority is stable interactive development and avoiding resource thrashing.

A local-engineer job may combine:

- a ~23 GB model;
- model context/KV cache;
- Git mirror/worktree I/O;
- package bootstrap;
- TypeScript/test/build processes.

Sequential heavy jobs are safer than running multiple 35B pipelines simultaneously.

## Optional concurrency

If resource observation later justifies it:

```powershell
[Environment]::SetEnvironmentVariable(
  "LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS",
  "2",
  "User"
)
```

Restart the Windows worker afterwards.

With `2`:

- different concrete worktree isolation keys may overlap in non-inference phases;
- jobs for the same concrete checkout never overlap;
- Ollama inference remains machine-wide serialized;
- tests/builds may overlap and therefore consume more CPU/RAM.

Do not raise concurrency merely because many Claude sessions exist. Queueing is an intentional resource-control mechanism.

## Claude Engineering OS compatibility

The Engineering OS remains authoritative for repository/task isolation.

Use the workspace/worktree belonging to the current Project/session. `local-coder` hashes the concrete checkout path into an opaque isolation key; it does not merge company/project/session context.

For mutable parallel work in the same repository, create/use separate validated worktrees according to the Engineering OS policy.

## Work Broker compatibility

Work Broker remains a separate company/integration MCP. It owns company-scoped operational context and credentials.

`local-coder` does not infer or combine `company_id` values and does not use Work Broker as a hidden cross-company state store. Claude passes only the active repository workspace and task context relevant to the current session.

## Which local-coder tool should Claude choose?

Use:

```text
local_engineer
```

when the user gives an outcome and expects the system to investigate/plan/implement.

Use:

```text
execute_local_code_task_compact
```

when the approach and exact editable files are already known.

Use:

```text
execute_local_code_plan_compact
```

when Claude already has a concrete dependency-ordered implementation plan.

`get_local_run` remains lazy; full diffs/plans should not be loaded into Claude context unless needed.
