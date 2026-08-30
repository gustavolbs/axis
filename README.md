# local-coder-mcp

Global MCP bridge for keeping Claude focused on reasoning, architecture, and review while delegating bounded implementation and context preprocessing to local Ollama models.

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
                          +------------------------------+------------------+
                          |                                                 |
                     bounded task                                      large feature
                          |                                                 |
                          v                                                 v
        execute_local_code_task_compact                 Claude plans/decomposes once
                          |                                                 |
                          |                              execute_local_code_plan_compact
                          |                                                 |
                          +-------------------+-----------------------------+
                                              |
                                           Ollama
                                              |
                                  edit -> validate -> retry
                                              |
                                      full result saved locally
                                              |
                                      compact review capsule
                                              |
                                              v
                                      Claude final review
                                              |
                              get_local_run only when needed
```

## v0.5 capabilities

The server exposes twelve tools:

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

The full-result executors remain for compatibility. Claude should prefer the compact executors because they persist detailed results locally and return only the information needed for normal review.

## Token Killer

### 1. Compact execution results

`execute_local_code_task_compact` and `execute_local_code_plan_compact` execute the same bounded local workflows as their full-result counterparts, but store the complete result under:

```text
~/.local-coder-mcp/runs/<runId>/run.json
~/.local-coder-mcp/runs/<runId>/diff.patch
```

Claude initially receives only:

- status / escalation phase;
- attempts / completed tasks;
- changed-file count or small sample;
- validation summary;
- local token/latency metadata;
- deterministic review capsule;
- `runId`.

Use `get_local_run` with `summary`, `diff`, `validation`, or `full` only when more detail is required. Large views are paginated with `offset` and `maxChars`.

### 2. Context capsules

`prepare_local_context` builds and refreshes a persistent local repository index under:

```text
~/.local-coder-mcp/indexes/
```

The index caches path, mtime, size, code terms, imports, and exported symbols. Unchanged entries are reused on later tasks.

Given a task, the tool ranks likely relevant files and returns bounded evidence with exact `path`, `startLine`, and `endLine`. Claude uses this as a starting point instead of broadly reading the repository. Architectural or high-risk assumptions should still be verified from the cited source.

### 3. Review capsules

Compact execution returns a deterministic review capsule containing:

- additions/deletions;
- changed-file count;
- risk level (`low`, `medium`, `high`);
- review targets;
- validation status;
- flags for dependency/package changes, exports, suppressions, auth/security signals, environment files, migrations/infra, or large diffs;
- `fullDiffRecommended`.

Low-risk validated work can usually be reviewed from compact evidence. High-risk work explicitly tells Claude to fetch the full diff.

### 4. Smaller Claude startup context

The installed global rule at `~/.claude/rules/local-coder.md` is intentionally short. Detailed procedures live in this README and in MCP tool descriptions rather than being injected into every Claude session.

The MCP itself advertises concise server instructions so Claude Code MCP Tool Search can discover the server without loading all schemas up front.

## Claude-side token saver

v0.5 includes an optional user-level Claude Code optimizer:

```bash
npm run install:claude-token-saver
```

It backs up `~/.claude/settings.json`, then configures:

```json
{
  "env": {
    "ENABLE_TOOL_SEARCH": "true",
    "MAX_MCP_OUTPUT_TOKENS": "8000"
  }
}
```

It also installs a `PostToolUse` hook that compacts only **successful, noisy** npm/pnpm/yarn/bun test/lint/typecheck/check/build output before Claude sees it. Small outputs and failed commands are left untouched.

The installer deliberately does **not** set `MAX_THINKING_TOKENS`: global reasoning quality is not reduced to save tokens.

## Large-feature orchestration

For features such as dashboards or modules spanning many files:

1. Claude understands requirements, architecture, contracts, design-system patterns, and validation.
2. Claude decomposes the feature into bounded subtasks, normally 1-5 editable files each.
3. `execute_local_code_plan_compact` preflights classification and dependency DAG before edits.
4. Local tasks run sequentially through the bounded executor.
5. Each task validates and retries locally.
6. Final integration validation runs after all tasks succeed.
7. Failure rolls the whole feature back by default.
8. Claude receives one compact review result and fetches detailed diff only when justified.

The local model never owns architecture, product ambiguity, security-sensitive decisions, or large-feature decomposition.

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
- package-manager operations restricted to validation-oriented subcommands;
- failed bounded tasks roll back by default;
- failed plans roll back the full plan by default.

## Telemetry

Aggregate telemetry is stored locally at:

```text
~/.local-coder-mcp/telemetry.jsonl
```

It records route/status/attempt/task/token/duration/count metadata, not prompts or source code. Local Ollama API inference cost is reported as `$0`; electricity/hardware and Claude subscription usage are not estimated.

Detailed lazy run storage is separate from telemetry and intentionally contains local execution results/diffs so Claude can retrieve them later by `runId`. It remains on the local machine.

## Requirements

- Node.js 20+
- Ollama running locally
- `qwen2.5-coder:14b` installed, or another `LOCAL_CODER_MODEL`
- Claude Code Desktop / Code tab with local MCP support

## Install / update

```bash
git clone https://github.com/gustavolbs/local-coder-mcp.git
cd local-coder-mcp
npm install
npm run check
npm run build
```

Existing clone:

```bash
git switch main
git pull
npm install
npm run check
npm run build
```

### User-scoped MCP

```bash
npm run install:claude
```

The installer updates `~/.claude.json`. Existing installations pointing at the same `dist/index.js` do not need to be reinstalled after every build.

### Global routing policy

```bash
npm run install:routing
```

Installs:

```text
~/.claude/rules/local-coder.md
```

### Claude token saver

```bash
npm run install:claude-token-saver
```

Then fully quit and reopen Claude Code Desktop.

## Test without Claude

```bash
npx @modelcontextprotocol/inspector \
  "$(which node)" \
  "$(pwd)/dist/index.js"
```

Start with `local_coder_health`, then test `prepare_local_context` and one compact executor.

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

Use the existing benchmark harness with the same real task manifest across models:

```bash
LOCAL_CODER_MODEL=qwen2.5-coder:14b npm run benchmark -- benchmarks/my-real-tasks.json
```

Do this in disposable worktrees.

## Roadmap

- [x] MCP + Ollama bridge
- [x] bounded local executor
- [x] validation/retry/rollback
- [x] global routing + deterministic classifier
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
