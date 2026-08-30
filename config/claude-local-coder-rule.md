# Local Coder Delegation

Use the `local-coder` MCP to reduce expensive model work without reducing code quality.

## Default workflow

1. Use deterministic repository tools directly for formatting, grep/search, generators, test execution, lint, typecheck, and build when no code reasoning is required.
2. For a coding task whose route is not obvious, call `classify_local_code_task` before implementing it. Supply whether the solution is known, whether discovery/architecture is still required, estimated edit scope, known validation, and relevant risk tags.
3. If the classifier returns `claude`, keep reasoning/implementation in Claude until the risky or ambiguous part is resolved.
4. If it returns `deterministic`, use the appropriate non-LLM repository tool rather than Claude or the local model.
5. If it returns `local`, delegate the bounded implementation to `execute_local_code_task`.
6. Before delegation, use `discover_local_workspace` or `search_local_workspace` only when needed to identify the minimum relevant files/scripts. Do not dump the repository into the local model.
7. Give the local executor an absolute workspace path, an explicit editable-file allowlist, only the relevant context files, hard constraints, and the narrowest useful validation commands.
8. When the executor returns `success`, review its diff and validation output. Accept it if correct; make only necessary corrections.
9. When it returns `escalated`, validation is inconclusive, or the diff is suspicious, take over with Claude.
10. Use `local_coder_telemetry` when evaluating routing effectiveness or deciding whether thresholds should change.

## Prefer local execution for

- small feature implementations with a clear design
- repetitive or mechanical refactors
- adding or updating tests for understood behavior
- typed boilerplate, adapters, mappers, serializers, mocks, fixtures, and Storybook stories
- straightforward React/TypeScript component changes
- lint, type, and test fixes whose cause is already understood
- narrow CRUD or API wiring after interfaces and behavior are known

## Keep in Claude

Do not delegate when the task primarily requires architecture or discovery, has unclear requirements, has broad or uncertain blast radius, or involves security-sensitive behavior. Keep authentication/authorization, cryptography, secrets, permissions, destructive data migrations, production infrastructure, concurrency/race conditions, subtle performance work, incident/debugging with unknown root cause, and large cross-cutting refactors in Claude unless the risky reasoning is finished and only a clearly isolated mechanical subtask remains.

## Delegation boundaries

- Prefer `execute_local_code_task` for real repository edits. Use `delegate_code_task` only for read-only snippets or bounded code generation that should not touch files.
- Treat `classify_local_code_task` as a routing guardrail, not as a substitute for project-specific safety instructions.
- Do not ask the local model to discover architecture or decide product behavior.
- Do not provide the entire repository as context. Send only files needed to perform the known implementation.
- Keep `editableFiles` explicit and minimal. Do not broaden the allowlist merely to avoid thinking about scope.
- Choose validation from the repository's existing scripts and conventions. Prefer targeted checks before broad suites when appropriate.
- Never report local validation as successful unless the MCP result says it passed.
- Review every returned diff before declaring the task complete.
- If project-level instructions conflict with this rule, follow the project-level instructions.

## Cost discipline

For a task that satisfies the delegation criteria, prefer one well-specified local execution call over implementing the same code through many Claude edit/tool turns. Do not delegate trivial deterministic work that a formatter, codemod, grep, compiler, test runner, or other non-LLM tool can perform more reliably.

Telemetry intentionally records only aggregate routing/execution metadata (status, attempts, tokens, durations, counts). It does not persist task prompts or source-code contents.
