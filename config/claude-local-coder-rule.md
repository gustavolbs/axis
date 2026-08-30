# Local Coder Delegation

Use the `local-coder` MCP to reduce expensive model work without reducing code quality.

## Default workflow

1. Use Claude for problem framing, repository inspection, ambiguity resolution, architecture, and choosing the implementation approach.
2. Before writing straightforward code yourself, check whether the task is safe to delegate to `execute_local_code_task`.
3. Delegate when the implementation is bounded and the approach is already clear.
4. Give the local executor an absolute workspace path, an explicit editable-file allowlist, only the relevant context files, hard constraints, and the narrowest useful validation commands.
5. When the executor returns `success`, review its diff and validation output. Accept it if correct; make only necessary corrections.
6. When it returns `escalated`, validation is inconclusive, or the diff is suspicious, take over with Claude.

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
- Do not ask the local model to discover architecture or decide product behavior.
- Do not provide the entire repository as context. Send only files needed to perform the known implementation.
- Keep `editableFiles` explicit and minimal. Do not broaden the allowlist merely to avoid thinking about scope.
- Choose validation from the repository's existing scripts and conventions. Prefer targeted checks before broad suites when appropriate.
- Never report local validation as successful unless the MCP result says it passed.
- Review every returned diff before declaring the task complete.
- If project-level instructions conflict with this rule, follow the project-level instructions.

## Cost discipline

For a task that satisfies the delegation criteria, prefer one well-specified local execution call over implementing the same code through many Claude edit/tool turns. Do not delegate trivial deterministic work that a formatter, codemod, grep, compiler, test runner, or other non-LLM tool can perform more reliably.
