# local-coder-mcp

Global MCP bridge for keeping Claude focused on reasoning, architecture, sensitive decisions, and review while delegating bounded implementation and context preprocessing to local Ollama models.

## Architecture

```text
User task
   |
   +--> deterministic work --------------------------> normal tools
   |
   +--> prepare_local_context -----------------------> compact file:line capsule
   |                                                     |
   |                                                     v
   +-------------------------------------------------- Claude decides
                                                         |
                  +-------------------+------------------+------------------+
                  |                   |                                     |
               normal local      local-supervised                         Claude
                  |                   |                                     |
                  |          sensitive decision already                     |
                  |          resolved by Claude                             |
                  |                   |                                     |
                  +---------+---------+                                     |
                            |                                               |
                 compact task / Claude-planned feature                     |
                            |                                               |
                 Ollama edit -> validate -> retry                          |
                            |                                               |
                    compact review capsule                                 |
                            |                                               |
                full diff mandatory if supervised                          |
                            +---------------------> Claude final review <----+
```

## v0.6 capabilities

The server exposes twelve MCP tools:

- `local_coder_health`
- `classify_local_code_task`
- `discover_local_workspace`
- `search_local_workspace`
- `prepare_local_context`
- `delegate_code_task`
- `execute_local_code_task`
- `execute_local_code_task_compact` **preferred**
- `execute_local_code_plan`
- `execute_local_code_plan_compact` **preferred**
- `get_local_run`
- `local_coder_telemetry`

### Four routing classes

`classify_local_code_task` now returns one of:

- `deterministic` — existing tooling is better than any LLM;
- `local` — bounded implementation with known approach;
- `local-supervised` — sensitive domain, but Claude already resolved the sensitive behavior and only bounded implementation remains;
- `claude` — reasoning, architecture, discovery, or risk is still unresolved.

The key v0.6 rule is:

> classify the **work that remains**, not merely the domain touched.

Authentication, authorization, credentials, permissions, sessions, tokens, and secrets no longer automatically force all implementation into Claude.

Claude must first resolve the relevant sensitive behavior/contract. After that, a bounded implementation can be routed with:

```json
{
  "solutionKnown": true,
  "validationKnown": true,
  "sensitiveDecisionResolved": true,
  "riskTags": ["auth", "credentials"]
}
```

A `local-supervised` result means:

```text
Claude decides sensitive behavior
        ↓
local model implements only that bounded decision
        ↓
validation/retry stays local
        ↓
full diff is mandatory
        ↓
Claude reviews before approval
```

`local-supervised` does **not** allow the local model to redesign auth/security behavior.

Cryptography design, unresolved architecture/discovery, unknown-root-cause debugging, destructive migrations, production infrastructure, concurrency, and similar work remain Claude blockers.

## Token Killer

### Compact execution results

`execute_local_code_task_compact` and `execute_local_code_plan_compact` persist complete execution results under:

```text
~/.local-coder-mcp/runs/<runId>/run.json
~/.local-coder-mcp/runs/<runId>/diff.patch
```

Claude initially receives a compact result containing status, validation summary, routing/review metadata, changed-file counts, local token/latency data, and `runId`.

Use `get_local_run` with `summary`, `diff`, `validation`, or `full` only when needed. Results are paginated.

For `local-supervised`, the compact result explicitly requires Claude to fetch and review the full stored diff before approval.

### Context capsules

`prepare_local_context` maintains a persistent local repository index under:

```text
~/.local-coder-mcp/indexes/
```

It ranks likely relevant files and returns bounded `path:startLine-endLine` evidence so Claude does not need to broadly read the repository before every task.

### Review capsules

Compact execution returns deterministic review metadata including:

- additions/deletions;
- changed-file count;
- risk level;
- review targets;
- validation state;
- dependency/package signals;
- export/suppression signals;
- security/environment/migration/infra signals;
- `fullDiffRecommended`.

Normal low-risk validated work can stay compact. Supervised-sensitive work always forces full-diff review.

## Large-feature orchestration

For dashboards, modules, multi-screen features, or other broad implementation:

1. Claude understands requirements and architecture.
2. Claude resolves sensitive/product decisions.
3. Claude decomposes into bounded subtasks, normally 1–5 editable files each.
4. Normal subtasks route `local`.
5. Sensitive subtasks whose decisions are already resolved route `local-supervised`.
6. `execute_local_code_plan_compact` validates the dependency DAG and routing before editing.
7. Tasks execute sequentially through the bounded local executor.
8. Each task validates and retries locally.
9. Final integration validation runs after all tasks succeed.
10. Failure rolls the whole feature back by default.
11. Any supervised subtask forces full aggregate-diff Claude review.

The local model never owns large-feature decomposition or sensitive design decisions.

## Safety boundaries

- absolute workspace required;
- relative file paths only;
- path traversal rejected;
- symlink escapes rejected;
- `.git`, `node_modules`, `.ssh`, and real `.env*` secrets blocked;
- `.env.example`, `.env.sample`, and `.env.template` allowed;
- explicit editable-file allowlists;
- bounded file/context sizes;
- validation commands supplied by Claude, never invented by the local model;
- validation runs with `shell: false`;
- default executable allowlist: `npm,pnpm,yarn,bun`;
- failed bounded tasks roll back by default;
- failed plans roll back the full plan by default;
- supervised-sensitive execution injects a constraint forbidding redesign of sensitive contracts.

## Claude-side token saver

Install/update:

```bash
npm run install:claude-token-saver
```

It backs up `~/.claude/settings.json`, enables deferred MCP Tool Search, caps MCP output, and installs a `PostToolUse` hook that compacts only large successful validation output.

It deliberately does **not** lower Claude thinking-token settings.

## Global routing policy

Install/update:

```bash
npm run install:routing
```

This installs:

```text
~/.claude/rules/local-coder.md
```

The v0.6 rule explicitly teaches Claude that auth/security domain presence is not itself an implementation blocker: Claude resolves the sensitive decision first, then delegates the mechanical remainder as `local-supervised` with mandatory full-diff review.

## Telemetry

Aggregate telemetry is stored locally at:

```text
~/.local-coder-mcp/telemetry.jsonl
```

It records route/status/attempt/task/token/duration/count metadata, not prompts or source code. Classification telemetry distinguishes `local-supervised` from ordinary `local` work.

## Requirements

- Node.js 20+
- Ollama running locally
- `qwen2.5-coder:14b` installed, or another `LOCAL_CODER_MODEL`
- Claude Code Desktop / Code tab with local MCP support

## Install / update

Existing clone:

```bash
git switch main
git pull
npm install
npm run check
npm run build
npm run install:routing
```

If the MCP already points at the same `dist/index.js`, `npm run install:claude` is not required again.

For first setup:

```bash
npm run install:claude
npm run install:routing
npm run install:claude-token-saver
```

Fully quit and reopen Claude Code Desktop after changing user-level Claude configuration.

## Test without Claude

```bash
npx @modelcontextprotocol/inspector \
  "$(which node)" \
  "$(pwd)/dist/index.js"
```

Useful v0.6 classifier test:

```json
{
  "task": "Implement the already-decided credential removal behavior and update its tests.",
  "solutionKnown": true,
  "validationKnown": true,
  "estimatedFiles": 3,
  "riskTags": ["auth", "credentials"],
  "sensitiveDecisionResolved": true
}
```

Expected route:

```text
local-supervised
```

The same request without `sensitiveDecisionResolved: true` should remain in Claude.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama |
| `LOCAL_CODER_MODEL` | `qwen2.5-coder:14b` | local executor |
| `LOCAL_CODER_TIMEOUT_MS` | `180000` | model request timeout |
| `LOCAL_CODER_VALIDATION_TIMEOUT_MS` | `180000` | validation timeout |
| `LOCAL_CODER_MAX_FILE_BYTES` | `120000` | per-file limit |
| `LOCAL_CODER_MAX_CONTEXT_BYTES` | `600000` | local subtask context limit |
| `LOCAL_CODER_ALLOWED_COMMANDS` | `npm,pnpm,yarn,bun` | validation executable allowlist |
| `LOCAL_CODER_TELEMETRY_ENABLED` | `true` | aggregate telemetry |
| `LOCAL_CODER_TELEMETRY_PATH` | `~/.local-coder-mcp/telemetry.jsonl` | telemetry path |
| `LOCAL_CODER_RUN_STORE_PATH` | `~/.local-coder-mcp/runs` | lazy full run results |
| `LOCAL_CODER_CONTEXT_INDEX_PATH` | `~/.local-coder-mcp/indexes` | persistent context indexes |

## Benchmark

```bash
LOCAL_CODER_MODEL=qwen2.5-coder:14b npm run benchmark -- benchmarks/my-real-tasks.json
```

Use disposable worktrees.

## Roadmap

- [x] MCP + Ollama bridge
- [x] bounded local executor
- [x] validation/retry/rollback
- [x] deterministic/local/Claude routing
- [x] `local-supervised` sensitive execution routing
- [x] mandatory full-diff supervised review
- [x] workspace discovery/search
- [x] multi-task transactional orchestrator
- [x] telemetry + benchmark harness
- [x] compact/lazy execution results
- [x] deterministic review capsules
- [x] persistent context index + file:line context capsules
- [x] compact global Claude rule
- [x] Claude-side MCP output/tool-search guardrails
- [x] successful validation-output compaction hook
- [ ] benchmark candidate local models on the same real repository suite and choose the measured default

## License

MIT
