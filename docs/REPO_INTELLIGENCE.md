# Persistent Repo Intelligence — v0.10

v0.10 makes `local_engineer` progressively more effective on repositories it has already worked with.

This is **not model fine-tuning**. Qwen weights do not change. Improvement comes from persistent, evidence-backed knowledge stored on the execution worker and retrieved before each engineering run.

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
learn reusable source-backed facts
```

The intended effect is to combine a strong local model with accumulated codebase familiarity while keeping current source/tests authoritative.

## Storage

Memory is kept **outside target repositories**.

Default Windows worker location:

```text
~/.local-coder-mcp/worker/repo-intelligence/<identity-key>/memory.json
```

No `.local-coder` memory directory is written into company source trees.

## Identity and isolation

v0.10 distinguishes three concepts:

```text
concrete checkout/worktree  -> scheduling isolation
Git clone/common-dir        -> memory trust scope
workspace path in repo      -> sub-project identity
```

The Mac derives two opaque hashes:

- `isolationKey` from the concrete checkout/worktree path;
- `memoryScopeKey` from Git's `--git-common-dir`.

The worker never needs the raw Mac path.

The final repo-memory identity is derived from:

```text
opaque clone memory scope
+ Git origin URL
+ workspace-relative path
```

Consequences:

- linked worktrees created from the **same clone** share repo intelligence;
- two independent clones of the same origin do **not** share memory;
- different origins do not share memory;
- monorepo sub-workspaces get independent memory identities;
- separate company/trust contexts can remain isolated simply by using separate clones/worktree roots managed by the Engineering OS.

In local-only execution, local-coder derives the same clone scope directly from the local Git common-dir.

## What is remembered

Durable facts are bounded and typed as:

- `architecture` — code boundaries, layers, ownership relationships;
- `convention` — recurring repository conventions;
- `invariant` — behavior that must remain true;
- `procedure` — repeatable project-specific workflows;
- `episodic` — useful facts about a previous task;
- `failure` — reusable lessons from a failed approach/review issue.

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

1. resolves repo/clone/workspace identity;
2. loads that identity's memory document;
3. compares previous known SHA with current HEAD;
4. checks fingerprints of source files supporting stored facts;
5. marks changed knowledge stale;
6. retrieves only high-value facts related to the new goal;
7. injects a compact memory capsule into investigation/planning context.

The whole memory file is never dumped into the model prompt.

### During a task

Memory is advisory:

```text
current source + tests + explicit requirements
            >
repo intelligence
            >
generic model memory
```

Stale facts are labeled:

```text
STALE: verify source before relying
```

and heavily down-ranked during retrieval.

### After a successful task

A low-reasoning local learner pass receives a bounded task result:

```text
goal
plan decisions
changed files
review result
validation result
repair rounds
bounded diff
```

For the recommended Qwen3.8 worker this learner uses `think=low`; expensive reasoning is reserved for investigation/planning/review.

The learner extracts at most a small set of reusable facts. Durable source-backed facts are accepted only when their cited source paths participated in actual evidence/plan/change scope.

The successful run is also stored as an episode.

### After escalation/failure

Historical outcome may be recorded, but speculative architecture/convention/invariant/procedure facts are not learned from a non-success result.

This prevents failed approaches from silently becoming future “truth”.

## Stale knowledge detection

v0.10 uses both Git history and file fingerprints.

### Git SHA delta

When HEAD advances:

```text
lastSeenSha..currentSha
```

changed paths are detected. Matching memories are marked stale and the change is stored as a Git-change episode.

### File fingerprints

Source-backed facts store SHA-256 fingerprints of supporting files.

Before reuse, fingerprints are compared against the current worktree. This catches uncommitted changes even when HEAD is unchanged:

```text
fact learned
   ↓
source file edited locally
   ↓
HEAD unchanged
   ↓
fingerprint differs
   ↓
fact becomes stale
```

This matters because dirty Mac source state is reconstructed on the Windows disposable worktree before local engineering starts.

## Familiarity score

A local-engineer result can surface:

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

The score is diagnostic, not a trust permission. High familiarity enables more targeted investigation; it never permits skipping validation.

## Multiple companies / projects / worktrees

Ownership remains:

```text
Work Broker / Engineering OS
  -> company / project / session / worktree identity

local-coder
  -> execution + repository-local learned knowledge
```

The worker does not learn company credentials or merge company context.

The clone-scoped memory key is deliberately compatible with Engineering OS worktrees:

```text
clone A
  worktree A1 ─┐
  worktree A2 ─┼─ share repo memory A
  worktree A3 ─┘

separate clone B of same origin
  worktree B1 ─── independent repo memory B
```

Mutable job scheduling still uses the concrete checkout isolation key, so sharing memory does not mean concurrent jobs can edit the same worktree.

Repo-memory writes use a filesystem lock plus atomic replacement so concurrent worktrees cannot silently lose each other's learned updates.

## Memory quality rules

1. current source/tests always win;
2. stale memories must be verified before use;
3. durable architecture/convention/invariant/procedure facts require source paths;
4. successful execution/review is required before durable learning;
5. fact confidence is capped below 1.0;
6. memory is bounded by fixed fact/episode limits;
7. corrupt/incompatible memory is moved aside and rebuilt;
8. repo-intelligence failure never invalidates an otherwise-correct engineering run;
9. secrets, credentials, tokens, personal/user data and transient generated values must not be persisted by the learner;
10. a separate clone/trust scope never retrieves another clone's memory merely because the Git origin matches.

## Configuration

Repo intelligence is enabled by default.

Disable:

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

## Resetting one repo memory

The detailed local-engineer result exposes the opaque `identityKey`.

While no worker job is writing that memory, remove:

```text
~/.local-coder-mcp/worker/repo-intelligence/<identity-key>/
```

The next run starts with empty knowledge and rebuilds familiarity naturally.

## Why not fine-tune per repository?

For a changing repository, evidence-backed persistent memory is preferable because it can:

- become stale explicitly;
- be revalidated against source;
- forget/reset individual repo identities;
- update immediately after Git/source changes;
- remain auditable;
- avoid serving a separate adapter for every repository.

Future LoRA/fine-tuning may make sense for organization-wide style or recurring patterns across many repositories, but not as the primary store for facts that evolve with a codebase.

## Expected progression

Early use:

```text
low familiarity
-> broader bounded discovery
-> more source reads
-> cautious planning
```

After repeated successful work:

```text
higher familiarity
-> retrieve relevant architecture/invariants
-> targeted source verification
-> smaller investigation context
-> faster planning
-> fewer unnecessary Claude escalations
```

The goal is not to make Qwen intrinsically equal to a premium model. The goal is to make **engineering outcomes improve over time** through a capable local model plus accumulated codebase knowledge, evidence, deterministic validation and repair loops.
