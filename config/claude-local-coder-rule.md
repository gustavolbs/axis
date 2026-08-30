# Local Coder

Use `local-coder` to minimize Claude context/tokens without lowering review quality.

## Routing

- Deterministic work (format/search/test/lint/typecheck/build/generators) -> normal tools.
- Architecture, ambiguity, unknown-root-cause debugging, auth/security, migrations, production infra, concurrency, subtle performance, or broad risky changes -> Claude.
- Bounded implementation with a known approach -> local executor.
- When routing is unclear, use `classify_local_code_task`.

## Context first

Before broad repository reading, prefer `prepare_local_context`. Treat its `file:line` evidence as a compact starting point; verify cited source for architecture/high-risk decisions. Avoid reading whole files/repos unless needed.

## Small/medium implementation

Prefer `execute_local_code_task_compact` over the full-result executor. Provide minimal `editableFiles`, only necessary context files, constraints, and targeted validation. Review the returned review capsule. Use `get_local_run` lazily for `diff`, `validation`, or `full` only when the capsule is insufficient, suspicious, high-risk, or failed.

## Large features

Claude owns requirements, architecture, contracts, decomposition, and final integration review. Split large work into bounded subtasks (normally 1-5 editable files each) with dependencies and validation, then prefer one `execute_local_code_plan_compact` call. Never send one giant open-ended feature to the local model. If plan preflight or execution escalates, Claude resolves the blocker or submits a narrower corrected plan.

## Quality guardrails

- Local model never owns architecture/product/security decisions.
- Never broaden edit allowlists just to make delegation easier.
- Never claim validation passed unless the MCP says so.
- Low-risk clean capsules can be reviewed from compact evidence; fetch full diff when `fullDiffRecommended` is true or judgment requires it.
- Project-specific instructions override this global default when they conflict.

Preferred pattern:

`compact context -> Claude decides -> local execution -> validation -> compact review -> lazy detail only if needed`
