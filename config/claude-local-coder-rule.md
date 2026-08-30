# Local Coder

Use `local-coder` to minimize Claude context/tokens without lowering engineering quality.

## Routing

- Deterministic work (format/search/test/lint/typecheck/build/generators) -> normal tools.
- Architecture, ambiguity, unknown-root-cause debugging, cryptography design, migrations, production infra, concurrency, subtle performance, or broad risky changes -> Claude.
- Bounded implementation with a known approach -> local executor.
- Auth/authorization/credentials/permissions/secrets are **not automatic implementation blockers**. Claude must first resolve the sensitive behavior/contract. If only bounded implementation remains, route it as `local-supervised` with `sensitiveDecisionResolved=true`, explicit files, known validation, and mandatory full-diff Claude review.
- When routing is unclear, use `classify_local_code_task`.

The classifier must judge the **work that remains**, not merely the domain touched. Sensitive reasoning stays in Claude; already-decided mechanical implementation can be local-supervised.

## Context first

Before broad repository reading, prefer `prepare_local_context`. Treat its `file:line` evidence as a compact starting point; verify cited source for architecture/high-risk decisions. Avoid reading whole files/repos unless needed.

## Small/medium implementation

Prefer `execute_local_code_task_compact`. Provide minimal `editableFiles`, necessary context, explicit constraints, targeted validation, and routing hints when sensitive code is involved. For `local-supervised`, fetch the stored full diff with `get_local_run(..., "diff")` and review it before approval.

## Large features

Claude owns requirements, architecture, contracts, sensitive decisions, decomposition, and final integration review. Split large work into bounded subtasks (normally 1-5 editable files each), then prefer one `execute_local_code_plan_compact` call. Sensitive subtasks whose decisions are already resolved may use `local-supervised`; unresolved sensitive reasoning remains in Claude. Never send one giant open-ended feature to the local model.

## Quality guardrails

- Local model never owns architecture/product/security decisions.
- `local-supervised` means execution is delegated, not judgment.
- Never broaden edit allowlists just to make delegation easier.
- Never claim validation passed unless the MCP says so.
- Normal low-risk work may use compact review evidence.
- `local-supervised`, high-risk, failed, suspicious, or `fullDiffRecommended` results require the relevant detailed evidence; supervised changes always require full diff review.
- Project-specific instructions override this global default when they conflict.

Preferred pattern:

`compact context -> Claude decides -> local/local-supervised execution -> validation -> compact review -> full diff only when required -> Claude final review`
