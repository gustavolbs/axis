# Persistent Repo Intelligence — v0.10

v0.10 makes `local_engineer` progressively more effective on repositories it has already worked with.

This is **not** model fine-tuning. Qwen weights do not change. The improvement comes from a persistent, evidence-backed knowledge layer stored beside the Windows worker state.

```text
Claude UI
   |
   v
local_engineer
   |
   +--> persistent repo intelligence
   |      architecture
   |      conventions
   |      invariants
   |      procedures
   |      task episodes
   |      failure lessons
   |      Git changes
   |
   +--> current repository evidence
   |
   v
reason -> plan -> code -> validate -> review
   |
   v
learn reusable evidence-backed facts
```

The intended effect is that a generic local model becomes increasingly similar to an engineer who already knows the codebase, while current source code and tests remain authoritative.

## Storage

Repo intelligence is kept outside target repositories.

Default worker location:

```text
~/.local-coder-mcp/worker/repo-intelligence/<identity-key>/memory.json
```

On the recommended Mac -> Windows architecture this path is on the **Windows execution machine**, not the Mac and not the company repository.

The identity key is a SHA-256-derived opaque value from:

```text
Git origin URL + workspace-relative path
```

The raw company/project name is not needed for the memory filename.

A monorepo package used as a distinct workspace gets a distinct identity from the monorepo root.

## What is remembered

Durable facts are bounded and classified as:

- `architecture` — code boundaries, layers, ownership relationships;
- `convention` — recurring code/project conventions;
- `invariant` — behavior that must remain true;
- `procedure` — repeatable project-specific workflows;
- `episodic` — useful facts about a previous task;
- `failure` — reusable lessons from an approach/review problem.

Each fact records:

```text
kind
text
tags
confidence
source paths
source fingerprints
observed-at Git SHA
last-validated Git SHA
stale flag
created/updated timestamps
```

Architecture/convention/invariant/procedure memories require repository source evidence. Model-only speculation is not promoted as durable knowledge.

## Learning lifecycle

### Before a task

`local_engineer`:

1. resolves the Git repository/workspace identity;
2. loads the repo's memory document;
3. compares the previous known SHA with current HEAD;
4. checks fingerprints of source files supporting stored facts;
5. marks changed knowledge stale;
6. retrieves only the highest-value facts related to the new goal;
7. injects a compact memory capsule into investigation/planning context.

The whole memory file is never dumped into the model context.

### During a task

Memory is advisory.

The prompt explicitly tells the local engineer:

```text
current source/tests > repo intelligence
```

Stale facts are labeled:

```text
STALE: verify source before relying
```

They are also heavily down-ranked during retrieval.

### After a successful task

A low-effort local learner call receives a bounded summary of:

```text
goal
plan decisions
changed files
review result
validation result
repair rounds
bounded diff
```

It extracts at most 12 reusable facts.

Only source paths that were part of the actual evidence/plan/change set are accepted for durable source-backed facts. This makes it harder for the learner to invent unsupported architecture knowledge.

The run is also recorded as an episode.

### After an escalation/failure

The historical outcome may be recorded, but speculative durable architecture/convention facts are **not** learned from a non-success result.

This avoids training the memory on an approach that was never accepted.

## Detecting stale knowledge

v0.10 uses two mechanisms.

### Git SHA delta

When HEAD advances:

```text
lastSeenSha..currentSha
```

is inspected with Git. Changed paths are recorded as a Git-change episode and matching memories are marked stale.

### File fingerprints

Every source-backed fact stores SHA-256 fingerprints of its supporting files.

Before reuse, the current file fingerprints are compared.

This catches changes that have **not been committed yet**:

```text
fact learned
   |
source file edited locally
   |
HEAD unchanged
   |
fingerprint differs
   |
memory becomes stale
```

This is important because the Mac workspace may contain dirty changes when it is sent to the Windows worker.

## Familiarity score

Each `local_engineer` result can include:

```json
{
  "repoIntelligence": {
    "enabled": true,
    "familiarity": {
      "overall": 63,
      "architecture": 75,
      "conventions": 58,
      "history": 70,
      "freshness": 94,
      "facts": 24,
      "episodes": 18,
      "staleFacts": 2
    },
    "retrievedFacts": 8,
    "learnedFacts": 4,
    "gitChangesDetected": 3
  }
}
```

The score is diagnostic, not a trust permission.

A high score means the worker can usually perform more targeted investigation. It never permits skipping validation or ignoring current repository evidence.

## Multiple companies / projects

Repo intelligence does not replace Work Broker or Claude Engineering OS identity/isolation.

Recommended ownership remains:

```text
Work Broker / Engineering OS
  -> company / project / session / worktree identity

local-coder
  -> execution + repository-local learned knowledge
```

Different Git repository/workspace identities use different memory directories and cannot retrieve each other's facts.

Memory files remain outside every target repo, so no `.local-coder` knowledge is accidentally committed to a company repository.

When multiple Windows jobs operate on different worktrees of the same repository, repo-intelligence updates use a **per-repository filesystem lock** plus atomic file replacement. This prevents concurrent jobs from silently losing each other's learned facts.

## Memory quality rules

Persistent memory follows these rules:

1. current source code and tests always win;
2. stale memories must be verified before use;
3. source-backed durable facts require source paths;
4. successful execution/review is required before durable learning;
5. confidence is capped below 1.0;
6. memory is bounded (facts and episodes are retained within fixed limits);
7. corrupt/incompatible memory is moved aside and rebuilt instead of blocking engineering;
8. repo-intelligence failure never invalidates an otherwise-correct `local_engineer` run;
9. secrets, credentials, tokens, personal/user data, and transient generated values must not be persisted by the learner.

## Configuration

Repo intelligence is enabled by default.

Disable it on a worker:

```powershell
[Environment]::SetEnvironmentVariable(
  "LOCAL_CODER_REPO_INTELLIGENCE_ENABLED",
  "false",
  "User"
)
```

Re-enable:

```powershell
[Environment]::SetEnvironmentVariable(
  "LOCAL_CODER_REPO_INTELLIGENCE_ENABLED",
  "true",
  "User"
)
```

Restart the worker after changing user environment variables.

Override storage location:

```powershell
[Environment]::SetEnvironmentVariable(
  "LOCAL_CODER_REPO_INTELLIGENCE_PATH",
  "D:\\local-coder\\repo-intelligence",
  "User"
)
```

If unset, storage lives under the existing worker state directory.

## Resetting one repo's memory

The compact `local_engineer` result exposes an opaque `identityKey` in the detailed run result. The corresponding directory can be removed on the Windows worker while no local-coder job is running:

```text
~/.local-coder-mcp/worker/repo-intelligence/<identity-key>/
```

The next run starts with empty knowledge and rebuilds familiarity naturally.

Do not delete memory files while a worker job is actively writing them.

## Why not fine-tune per repository?

For a changing repository, persistent evidence-backed memory is preferable initially because it can:

- become stale explicitly;
- be revalidated against source;
- forget/reset individual facts;
- update immediately after a commit;
- remain auditable;
- avoid training/serving a separate adapter for every repository.

A future LoRA/fine-tuning layer may be useful for organization-wide coding style or repeated patterns across many repositories, but it should not be used as the primary store for facts that change with the codebase.

## Expected progression

Early use:

```text
familiarity low
-> broad but bounded discovery
-> more source reads
-> cautious planning
```

After repeated successful work:

```text
familiarity higher
-> retrieve relevant architecture/invariants
-> targeted verification
-> smaller investigation context
-> faster planning
-> fewer unnecessary Claude escalations
```

The objective is not to make Qwen intrinsically as capable as a premium model. The objective is to combine a capable model with accumulated repository knowledge, evidence, deterministic tooling, validation, and repair loops so the **engineering outcome** improves over time.
