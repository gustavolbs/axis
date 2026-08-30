# Local Coder Delegation

Use the `local-coder` MCP to reduce expensive model work without reducing code quality.

## Default workflow

1. Use deterministic repository tools directly for formatting, grep/search, generators, test execution, lint, typecheck, and build when no code reasoning is required.
2. For a coding task whose route is not obvious, call `classify_local_code_task` before implementing it. Supply whether the solution is known, whether discovery/architecture is still required, estimated edit scope, known validation, and relevant risk tags.
3. If the classifier returns `claude`, keep reasoning/implementation in Claude until the risky or ambiguous part is resolved.
4. If it returns `deterministic`, use the appropriate non-LLM repository tool rather than Claude or the local model.
5. If it returns `local`, delegate one bounded implementation to `execute_local_code_task`.
6. Before delegation, use `discover_local_workspace` or `search_local_workspace` only when needed to identify the minimum relevant files/scripts. Do not dump the repository into the local model.
7. Give the local executor an absolute workspace path, an explicit editable-file allowlist, only the relevant context files, hard constraints, and the narrowest useful validation commands.
8. When the executor returns `success`, review its diff and validation output. Accept it if correct; make only necessary corrections.
9. When it returns `escalated`, validation is inconclusive, or the diff is suspicious, take over with Claude.
10. Use `local_coder_telemetry` when evaluating routing effectiveness or deciding whether thresholds should change.

## Large features: plan once, execute locally in bounded steps

For a large request such as a dashboard, multi-screen feature, new module, broad UI area, or other implementation that naturally spans many files, do **not** send the whole request to `execute_local_code_task` and do not ask the local model to invent the architecture or decomposition.

Claude must first:

1. understand requirements and inspect the relevant architecture, patterns, types, design system, data flow, and test conventions;
2. resolve ambiguity and make architecture/product decisions;
3. define the implementation approach and integration boundaries;
4. decompose the feature into small bounded subtasks with explicit dependencies;
5. keep architecture/discovery/high-risk work in Claude;
6. pass only the already-decided local-safe subtasks to `execute_local_code_plan`.

Each local plan subtask should normally have one clear objective, preferably 1-5 editable files, explicit context files, known contracts, objective acceptance criteria, and targeted validation. Use `dependsOn` when a subtask requires changes from an earlier one.

`execute_local_code_plan` performs a full preflight before editing anything. Every subtask is classified again. A subtask classified as `claude` or `deterministic` blocks local plan execution so Claude can correct the plan instead of silently forcing unsafe work through the local model.

The orchestrator then:

- resolves the dependency order;
- snapshots all editable files before the plan starts;
- executes subtasks sequentially with the existing bounded local executor;
- validates every subtask;
- stops immediately on escalation;
- runs final integration validation after all subtasks succeed;
- returns one aggregate diff for the whole feature;
- rolls the entire feature back to the pre-plan snapshot on any failure by default.

After a successful plan, Claude must review the aggregate diff and final validation before declaring the feature complete. If the plan escalates, inspect `phase`, `failedTaskId`, subtask results, and the attempted diff, then either solve the blocker in Claude or submit a narrower corrected plan.

Preferred large-feature pattern:

`Claude plans once -> execute_local_code_plan -> many bounded local subtasks -> final validation -> aggregate diff -> Claude integration review`

Avoid:

`Claude implements every mechanical step itself` and `one giant local-model task for the entire feature`.

## Prefer local execution for

- small feature implementations with a clear design
- bounded subtasks of a larger feature already planned by Claude
- repetitive or mechanical refactors
- adding or updating tests for understood behavior
- typed boilerplate, adapters, mappers, serializers, mocks, fixtures, and Storybook stories
- straightforward React/TypeScript component changes
- loading, empty, error, and other known UI states
- lint, type, and test fixes whose cause is already understood
- narrow CRUD or API wiring after interfaces and behavior are known

## Keep in Claude

Do not delegate when the task primarily requires architecture or discovery, has unclear requirements, has broad or uncertain blast radius, or involves security-sensitive behavior. Keep authentication/authorization, cryptography, secrets, permissions, destructive data migrations, production infrastructure, concurrency/race conditions, subtle performance work, incident/debugging with unknown root cause, and large cross-cutting refactors in Claude unless the risky reasoning is finished and only clearly isolated mechanical subtasks remain.

Claude must also own the decomposition and final integration review of large features.

## Delegation boundaries

- Prefer `execute_local_code_task` for one real repository edit task.
- Prefer `execute_local_code_plan` when Claude has already decomposed a large feature into several bounded local-safe tasks.
- Use `delegate_code_task` only for read-only snippets or bounded code generation that should not touch files.
- Treat `classify_local_code_task` and plan preflight as routing guardrails, not as substitutes for project-specific safety instructions.
- Do not ask the local model to discover architecture, choose product behavior, or decompose a large feature.
- Do not provide the entire repository as context. Send only files needed to perform the known implementation.
- Keep `editableFiles` explicit and minimal. Do not broaden the allowlist merely to avoid thinking about scope.
- Choose validation from the repository's existing scripts and conventions. Prefer targeted checks before broad suites when appropriate, plus integration-level final validation for a multi-task plan.
- Never report local validation as successful unless the MCP result says it passed.
- Review every returned diff before declaring the task complete.
- If project-level instructions conflict with this rule, follow the project-level instructions.

## Cost discipline

For a task that satisfies the delegation criteria, prefer one well-specified local execution call over implementing the same code through many Claude edit/tool turns.

For a large planned feature, prefer one `execute_local_code_plan` call containing multiple bounded subtasks over many separate Claude implementation turns. This keeps Claude focused on planning and final review while the local model spends the bulk of implementation tokens.

Do not delegate trivial deterministic work that a formatter, codemod, grep, compiler, test runner, or other non-LLM tool can perform more reliably.

Telemetry intentionally records only aggregate routing/execution/orchestration metadata (status, attempts, task counts, tokens, durations, changed-file counts). It does not persist task prompts or source-code contents.
