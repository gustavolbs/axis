# Local Engineer — standalone engineering loop

Local Engineer is the core open-ended repository engineering workflow inside the Local Coder desktop application.

The developer talks directly to Local Coder. The app owns repository evidence, planning, implementation, validation, review, repair, routing and resumable guidance checkpoints.

```text
Developer
   |
   v
Local Coder.app
   |
   v
DesktopAppRuntime
   |
   +--> retrieve persistent Repo Intelligence
   +--> inspect bounded current repository evidence
   +--> adaptive impact analysis
   +--> optional Architect → Critic → Judge deliberation
   +--> targeted repository searches
   +--> evidence-backed planning
   +--> dependency-ordered implementation DAG
   +--> deterministic validation
   +--> adversarial review
   +--> bounded repair
   +--> quality gate
   +--> learn reusable source-backed facts
   |
   +--> success ----------------------> result in the app
   |
   +--> needs-guidance
              |
              v
       bounded guidance checkpoint
              |
              +--> material user decision
              +--> unresolved external research fact
              +--> non-convergent bounded repair/review
              |
              v
       user supplies guidance in Local Coder
              |
              v
       same job resumes from durable state
```

Claude Desktop and Claude Code are not part of this runtime contract. Anthropic models may still be selected as normal inference providers when a Project allows cloud usage.

## Default local model profile

The recommended Windows inference worker uses:

```text
qwen3.8:27b
context=16384
parallel inference=1
```

The engineering stages express model-agnostic reasoning intent:

```text
investigation  high
planning       high
review         high
learning       low
coding         low/off where appropriate
```

For Qwen3.8, the Ollama adapter maps high reasoning intent to the model's supported thinking mode rather than assuming a provider-specific literal level.

The worker intentionally starts at 16K context. Repo Intelligence and targeted evidence retrieval should improve quality before context size is increased.

## Why this is more than prompting a local model

The model runs inside a stricter engineering protocol:

1. retrieve relevant repository memory;
2. inspect current repository structure and source evidence;
3. invalidate stale memory when source changed;
4. formulate targeted searches;
5. reason from evidence instead of model memory alone;
6. pause when a material ambiguity remains;
7. decompose into small exact-file tasks;
8. execute through the transactional executor;
9. run real deterministic validation;
10. review the diff adversarially;
11. repair only inside the approved scope;
12. persist only reusable source-backed lessons after successful work;
13. request bounded guidance when confidence, current external evidence or user judgment is genuinely missing.

The target is **model + tools + evidence + accumulated repo knowledge + decomposition + feedback**, not raw model intelligence alone.

## Persistent Repo Intelligence

Before investigation, Local Coder retrieves a compact set of relevant memories such as:

```text
architecture boundaries
conventions
invariants
procedures
past task lessons
past failure lessons
regression invariants
recent Git changes
```

Current source and executable tests remain authoritative. Source-backed memory carries fingerprints and becomes stale when its supporting code changes, including uncommitted changes.

After a successful run, a low-effort learning pass extracts a bounded set of reusable source-backed facts. Failed or unresolved work is not promoted into durable architectural truth.

See [REPO_INTELLIGENCE.md](./REPO_INTELLIGENCE.md).

## Guidance contract

A resumable non-success result may carry an escalation capsule:

```text
kind
reason
questions[]
researchRequests[]
evidence[]
resumeWith
```

The public runtime state is `needs-guidance`, not a request for another assistant to redo the task.

Guidance supplied by the user is carried as `userGuidance` when the same job resumes. The standalone job manager stores that guidance with the durable session and resumes the existing engineering loop.

Typical guidance checkpoints are:

- a material product or architecture preference that repository evidence cannot infer;
- a current external provider/library/platform fact that the configured research backend could not resolve;
- a sensitive auth/credential/permission contract that should not be guessed;
- bounded implementation or review that failed to converge safely.

## External research

The Research Broker first attempts configured direct infrastructure such as SearXNG. Retrieved content is evidence, never instructions.

For Microsoft ecosystem questions, discovery can be narrowed to `site:learn.microsoft.com` without any MCP connection.

If research remains unresolved, Local Coder exposes the exact missing facts in a `needs-guidance` checkpoint. The user can resolve them with any trusted source or tool and paste the bounded evidence back into the app.

## Rollback semantics

If investigation or planning pauses for guidance, no implementation is applied.

If implementation fails or review cannot establish confidence, the active execution workspace is restored to its pre-run snapshots before the resumable result is returned.

A successful Windows-worker execution returns bounded file contents with before-state SHA-256 preconditions. The Mac applies them only when its concrete worktree still matches the state that started the run.

## Review semantics

The reviewer may use the same model family as planner/coder, so model review alone is not independent proof.

It receives the original goal, evidence-backed plan, actual diff, cumulative regression invariants and deterministic validation output, and is instructed to falsify correctness rather than confirm the implementation.

Tests, typecheck, lint and build remain the strongest independent evidence. Low confidence produces `needs-guidance` rather than silent approval.

## Concurrency

The standalone app can manage multiple jobs, while local inference remains intentionally bounded.

Recommended initial worker limits:

```text
LOCAL_CODER_WORKER_MAX_CONCURRENT_JOBS=1
OLLAMA_NUM_PARALLEL=1
```

That allows Local Coder to queue work without allowing multiple heavy local generations to exhaust the worker at the same time.
