# Local Coder

Claude is always the user-facing engineering interface. `local-coder` is the preferred execution/reasoning substrate for normal repository work so Claude tokens are reserved for premium reasoning, external research, and genuinely unresolved high-risk decisions.

## Primary routing

- Open-ended repository engineering request, bug investigation, feature, refactor, migration within an existing application architecture, or request such as "understand this repo, break this into steps, and implement it" -> prefer `local_engineer` first.
- Already-known small/medium implementation with explicit files/approach -> prefer `execute_local_code_task_compact`.
- Claude already has a detailed multi-task plan -> prefer `execute_local_code_plan_compact`.
- Pure deterministic work (format/search/test/lint/typecheck/build/generators) -> normal deterministic tools when they are already sufficient.
- Cryptography design, destructive production-data operations, production access-control decisions, or another local-engineer escalation -> Claude resolves the exact premium gap first.

Do not force Claude to investigate/decompose a normal task merely because it is broad. `local_engineer` exists to perform structured local investigation, evidence gathering, planning, implementation, validation, adversarial review, and bounded repair.

## Claude -> local -> Claude -> local loop

For `local_engineer`:

1. Send the active Project/session workspace plus the user's goal and only useful Project context/constraints.
2. Let the local worker investigate and plan from repository evidence.
3. If it returns `status=success`, do not redo the whole investigation/implementation in Claude. Summarize the result; fetch `get_local_run` diff/validation/full details only when suspicious, required by Project policy, or requested by the user.
4. If it returns `status=needs-claude` or `status=escalated`, read the returned `escalation` capsule.
5. Resolve **only** its exact `questions` and `researchRequests`. Use Claude reasoning/web/repository-specific tools when needed.
6. Call `local_engineer` again with the same goal and concise `claudeGuidance` containing the resolved decision/evidence.
7. Repeat only while the local worker has a concrete resumable gap. Claude may take over directly when the escalation says the remaining work itself requires premium execution.

This makes Claude the control/interface layer, not the mandatory implementation planner.

## Sensitive work

Authentication, authorization, credentials, permissions, sessions, tokens, and secrets are not automatic implementation blockers.

- If the local engineer can establish the behavior safely from existing repository contracts, it may proceed.
- If a material sensitive decision is unresolved, it must return `sensitive-decision` without applying changes.
- Claude resolves that behavior/contract and calls `local_engineer` again with `claudeGuidance`.
- Already-scoped mechanical sensitive changes may still use `local-supervised` with `sensitiveDecisionResolved=true` and mandatory full-diff Claude review under the existing bounded-executor policy.

Cryptography design and the explicitly hard premium categories remain Claude decisions.

## Evidence and quality

- Local investigation must use bounded repository evidence, searches, existing scripts, and actual validation rather than model memory alone.
- Never claim validation passed unless the MCP reports it.
- Local review is adversarial but correlated with the coder; deterministic tests/typecheck/lint/build remain the primary independent evidence.
- Failed local review or insufficient confidence must escalate instead of silently approving.
- Never broaden editable-file allowlists merely to avoid an escalation.
- `get_local_run` is lazy: do not load full local plans/diffs into Claude context by default.

## Multiple Projects / sessions

The same global `local-coder` MCP may be called from multiple Claude sessions and multiple companies/repositories.

- Preserve the active Claude Engineering OS Project/session/worktree identity. Never combine context from different Projects or companies.
- A mutable task operates only on the concrete workspace/worktree supplied by that session.
- The Windows worker accepts jobs from independent MCP processes. It queues heavy jobs by default to protect GPU/RAM and never overlaps jobs for the same concrete checkout isolation key.
- Separate validated worktrees may be allowed to overlap only when worker concurrency is explicitly raised; Ollama inference remains serialized.
- Do not invent a cross-company scheduler or shared task context inside local-coder. Work Broker / Engineering OS remain authoritative for company/project/task identity.

## Remote mode

Prefer strict `LOCAL_CODER_EXECUTION_MODE=remote` on the Mac/Windows setup. If the Windows worker is unavailable, return the failure to Claude. Never silently load the heavyweight model or run heavy validation on the Mac as a fallback.

Project-specific instructions override this global default when they conflict.

Preferred pattern:

`Claude UI -> local_engineer -> local evidence/reason/plan/code/validate/review -> success OR compact escalation -> Claude resolves exact gap -> local_engineer resumes`
