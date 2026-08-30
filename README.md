# local-coder-mcp

A global MCP bridge that lets Claude keep expensive reasoning, architecture, and review work while delegating bounded implementation to a coding model running locally in Ollama.

```text
request
  |
  +--> deterministic tool? --> lint/test/format/search directly
  |
  +--> small/medium coding task
  |       |
  |       +--> classify_local_code_task
  |               |
  |               +--> claude ------> discovery / architecture / risky reasoning
  |               +--> local -------> execute_local_code_task
  |
  +--> large feature
          |
          +--> Claude understands + designs + decomposes once
                  |
                  +--> execute_local_code_plan
                          |
                          +--> preflight every subtask
                          +--> dependency ordering
                          +--> bounded local task 1 -> validate
                          +--> bounded local task 2 -> validate
                          +--> ...
                          +--> final integration validation
                          +--> aggregate feature diff
                          +--> transactional rollback on failure
                                  |
                                  v
                             Claude final review
```

## v0.4 capabilities

The server exposes eight MCP tools:

- `local_coder_health` — verify Ollama connectivity and configured model availability.
- `classify_local_code_task` — deterministic routing classifier: `deterministic`, `local`, or `claude`.
- `discover_local_workspace` — bounded workspace tree/package-script discovery without following symlinks.
- `search_local_workspace` — literal text/code search across bounded safe workspace files.
- `delegate_code_task` — read-only local-model delegation for cheap drafting.
- `execute_local_code_task` — one bounded local implementation with explicit edit permissions, validation, retry, rollback, and exact diff.
- `execute_local_code_plan` — transactional orchestration of a Claude-designed multi-subtask feature plan.
- `local_coder_telemetry` — aggregate routing, execution, orchestration, success/escalation, retry, token, and duration telemetry.

The local model is intentionally **not** the architect or feature planner. Claude owns ambiguity resolution, architecture, decomposition, and final integration review. The local model executes already-decided bounded work.

## Requirements

- Node.js 20+
- Ollama running locally
- `qwen2.5-coder:14b` installed, or another model configured through `LOCAL_CODER_MODEL`
- Claude Code Desktop / Claude Code with local MCP support

```bash
ollama list
ollama run qwen2.5-coder:14b
```

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
git pull
npm install
npm run check
npm run build
```

## Install globally in Claude Code Desktop

The installer adds `local-coder` at user scope in `~/.claude.json` and creates a timestamped backup before modifying an existing configuration.

```bash
npm run install:claude
```

Then fully quit and reopen Claude Code Desktop.

> This is for Claude Code / the Code tab. A manual user-scoped stdio MCP does not need to appear in the graphical Plugins/Connectors UI.

## Install the global routing policy

The routing policy installs to:

```text
~/.claude/rules/local-coder.md
```

Install/update it with:

```bash
npm run install:routing
```

The policy tells Claude to:

1. prefer deterministic tools when no LLM is needed;
2. classify uncertain routes;
3. keep discovery, architecture, security-sensitive, cross-cutting, and unknown-root-cause work in Claude;
4. delegate one bounded known implementation to `execute_local_code_task`;
5. for large features, plan/decompose once in Claude and send the bounded subtask plan to `execute_local_code_plan`;
6. review returned diffs and validation evidence;
7. take over when local execution or orchestration escalates.

Project-level rules remain able to override the global policy.

## Test without Claude

Use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector \
  "$(which node)" \
  "$(pwd)/dist/index.js"
```

Run `local_coder_health`. Expected output includes:

```json
{
  "ok": true,
  "configuredModel": "qwen2.5-coder:14b",
  "modelAvailable": true
}
```

The Inspector should list all eight tools above after building v0.4.

## Automatic task classifier

Example classifier input:

```json
{
  "task": "Add Vitest coverage for the existing mapper and fix the known TypeScript error.",
  "solutionKnown": true,
  "requiresDiscovery": false,
  "requiresArchitecture": false,
  "estimatedFiles": 2,
  "validationKnown": true
}
```

Expected route: `local`.

The classifier deliberately routes architecture, discovery, broad changes, authentication/authorization, cryptography/secrets, destructive migrations, production infrastructure, concurrency, incidents/unknown debugging, and subtle performance investigations back to Claude. Pure command execution such as "run the test suite" routes to `deterministic` instead of either LLM.

The classifier is a guardrail, not a security boundary. Project-specific instructions still win.

## Workspace discovery/search

Use `discover_local_workspace` to identify the repository shape and existing package scripts without giving the local model the whole repo. It skips generated/dependency directories such as `.git`, `node_modules`, `.next`, `dist`, `build`, `coverage`, and `.turbo`, and does not follow symlink entries.

Use `search_local_workspace` for bounded literal case-insensitive text search. It returns file/line/preview matches and honors the same workspace safety rules.

These tools are read-only and are intended to help Claude construct minimal `editableFiles + contextFiles` task specs or a multi-task plan.

## Single bounded task

```json
{
  "workspace": "/Users/me/WORK/my-app",
  "task": "Add the existing Spinner while the profile query is loading.",
  "editableFiles": [
    "src/profile/UserProfile.tsx",
    "src/profile/UserProfile.test.tsx"
  ],
  "contextFiles": ["src/ui/Spinner.tsx"],
  "constraints": [
    "Do not change the component public API",
    "Preserve the existing error state"
  ],
  "language": "TypeScript + React + Vitest",
  "validation": [
    { "command": "npm", "args": ["test", "--", "UserProfile"] },
    { "command": "npm", "args": ["run", "typecheck"] }
  ],
  "maxAttempts": 2,
  "rollbackOnFailure": true
}
```

`execute_local_code_task` snapshots every editable file, reads only explicitly supplied files, requests structured complete-file edits from Ollama, writes only allowlisted files, validates sequentially, retries with validation feedback, and returns an invocation-scoped diff. Failed tasks return `status: "escalated"` and roll back by default.

## Large-feature orchestration

For a request such as "build an analytics dashboard", Claude should first inspect the repository, decide the architecture and data flow, identify reusable design-system primitives, define component contracts, and split the implementation into bounded subtasks.

Then Claude can call `execute_local_code_plan` once:

```json
{
  "workspace": "/Users/me/WORK/my-app",
  "goal": "Implement the planned analytics dashboard using the existing design system and query layer.",
  "language": "TypeScript + React + Vitest",
  "context": "Dashboard architecture, component contracts, data flow, and acceptance criteria were already decided by Claude.",
  "sharedContextFiles": [
    "src/ui/Card.tsx",
    "src/ui/Table.tsx",
    "src/analytics/types.ts"
  ],
  "sharedConstraints": [
    "Do not add dependencies",
    "Preserve existing public APIs",
    "Use existing design-system primitives"
  ],
  "tasks": [
    {
      "id": "shell",
      "task": "Implement the already-designed dashboard shell and responsive layout.",
      "editableFiles": ["src/analytics/Dashboard.tsx"],
      "validation": [{ "command": "npm", "args": ["run", "typecheck"] }]
    },
    {
      "id": "metric-cards",
      "task": "Implement the planned metric-card components using the existing Card primitive.",
      "dependsOn": ["shell"],
      "editableFiles": [
        "src/analytics/MetricCard.tsx",
        "src/analytics/MetricCard.test.tsx"
      ],
      "validation": [{ "command": "npm", "args": ["test", "--", "MetricCard"] }]
    },
    {
      "id": "table",
      "task": "Implement the planned analytics table with the already-defined columns and data mapping.",
      "dependsOn": ["shell"],
      "editableFiles": [
        "src/analytics/AnalyticsTable.tsx",
        "src/analytics/AnalyticsTable.test.tsx"
      ],
      "validation": [{ "command": "npm", "args": ["test", "--", "AnalyticsTable"] }]
    },
    {
      "id": "integration",
      "task": "Wire the completed metric cards and analytics table into the dashboard shell according to the existing plan.",
      "dependsOn": ["metric-cards", "table"],
      "editableFiles": ["src/analytics/Dashboard.tsx"],
      "validation": [{ "command": "npm", "args": ["run", "typecheck"] }]
    }
  ],
  "finalValidation": [
    { "command": "npm", "args": ["test", "--", "analytics"] },
    { "command": "npm", "args": ["run", "typecheck"] }
  ],
  "rollbackPlanOnFailure": true
}
```

### Orchestrator guarantees

Before the first edit, the orchestrator:

- validates unique task ids and dependency references;
- rejects dependency cycles;
- resolves a deterministic dependency order;
- validates every referenced workspace path;
- snapshots the union of all editable files;
- classifies every subtask again.

If any subtask is classified as `claude`, the whole plan returns `phase: "preflight"` with blockers and **no model call or file edit occurs**. If a subtask is classified as `deterministic`, Claude is told to move that work into validation/tooling instead of wasting local LLM tokens.

During execution:

- subtasks run sequentially in dependency order;
- each subtask uses the same bounded local executor and its own retry budget;
- each failed subtask rolls back its own partial edits;
- the plan stops on the first escalation;
- final integration validation runs only after every subtask succeeds.

By default, any subtask escalation, exception, or final-validation failure restores **all** plan-editable files to their pre-plan snapshot. The returned attempted aggregate diff remains available for diagnosis while `rolledBack: true` makes clear that it is not persisted.

On success, Claude gets one aggregate feature diff plus every subtask result and final validation evidence, then performs the final integration review.

This is intentionally optimized for:

```text
Claude plans once
  -> local task 1
  -> local task 2
  -> local task 3
  -> ...
  -> integration validation
  -> one aggregate diff
  -> Claude final review
```

not for sending a giant open-ended feature prompt to the local model.

## Safety boundaries

### Workspace and file access

- `workspace` must be absolute.
- file arguments must be workspace-relative.
- `..` traversal is rejected.
- symlinks resolving outside the workspace are rejected.
- `.git`, `node_modules`, `.ssh`, and real `.env*` secret files are blocked.
- `.env.example`, `.env.sample`, and `.env.template` are allowed.
- edits are restricted to exact per-task `editableFiles` allowlists.
- plan preflight snapshots at most 120 unique editable files.
- per-file and per-subtask context byte limits prevent accidental huge prompts.

### Command execution

The local model does **not** choose shell commands. Validation commands are supplied by Claude and executed with `shell: false`.

Default executable allowlist:

```text
npm, pnpm, yarn, bun
```

Package-manager invocations are additionally restricted to validation-oriented subcommands. Operations such as package installation, arbitrary `sh -c`, and executable paths are rejected.

## Telemetry

Telemetry is enabled by default and stores JSONL locally at:

```text
~/.local-coder-mcp/telemetry.jsonl
```

It intentionally does **not** persist prompts, task text, goal text, file paths, or source-code contents. Events contain aggregate metadata such as route, status, attempts, task counts, token counts, generation duration, validation duration, and changed-file count.

Call `local_coder_telemetry` to get a summary for a lookback window. It reports:

- classifier route counts;
- single-task execution success/escalation/error rate;
- orchestration success/escalation/error rate;
- planned vs completed plan subtasks and task-completion rate;
- retry rate and average attempts;
- changed-file counts;
- local prompt/completion/total tokens;
- generation and validation time;
- local API inference cost (`$0`).

The cost field does not pretend to estimate hardware depreciation, electricity, or Claude planning/review usage.

## Benchmark harness

A benchmark runner is included so local models can be compared on **real bounded repository tasks**, not synthetic snippets.

1. Create a disposable worktree/repository state for benchmark tasks.
2. Copy `benchmarks/manifest.example.json` and replace the example with real tasks, explicit editable/context files, and validation commands.
3. Run one model:

```bash
LOCAL_CODER_MODEL=qwen2.5-coder:14b npm run benchmark -- benchmarks/my-real-tasks.json
```

4. Run another model with the same manifest.

The runner restores each task's editable files after execution and writes ignored JSON reports under `benchmarks/results/` containing success rate, attempts, tokens, latency, validation outcome, and classifier result.

Do not benchmark against a worktree with important uncommitted changes. Validation tools may create their own generated artifacts outside `editableFiles`, so disposable worktrees are recommended.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama server |
| `LOCAL_CODER_MODEL` | `qwen2.5-coder:14b` | Local executor model |
| `LOCAL_CODER_TIMEOUT_MS` | `180000` | Ollama request timeout |
| `LOCAL_CODER_VALIDATION_TIMEOUT_MS` | `180000` | Timeout for each validation command |
| `LOCAL_CODER_MAX_FILE_BYTES` | `120000` | Maximum size of one supplied/generated file |
| `LOCAL_CODER_MAX_CONTEXT_BYTES` | `600000` | Maximum combined repository file context per local subtask |
| `LOCAL_CODER_ALLOWED_COMMANDS` | `npm,pnpm,yarn,bun` | Validation executable allowlist |
| `LOCAL_CODER_TELEMETRY_ENABLED` | `true` | Enable aggregate local telemetry |
| `LOCAL_CODER_TELEMETRY_PATH` | `~/.local-coder-mcp/telemetry.jsonl` | Telemetry JSONL path |

## Roadmap

- [x] MCP stdio server
- [x] Ollama bridge
- [x] local model health check
- [x] read-only bounded delegation
- [x] workspace-aware file reading
- [x] explicit edit allowlist
- [x] path traversal + symlink escape protection
- [x] validation command allowlist
- [x] local retry loop
- [x] invocation-scoped diff
- [x] rollback + semantic escalation contract
- [x] Claude global delegation/routing policy
- [x] automatic deterministic task classifier
- [x] richer success-rate, retry, token, latency, and local API-cost telemetry
- [x] bounded workspace discovery/search tools
- [x] repeatable real-repository benchmark harness
- [x] Claude-planned multi-task local orchestration
- [x] dependency graph + preflight classification
- [x] plan-level integration validation + transactional rollback
- [x] orchestration telemetry
- [ ] benchmark candidate local models on the same real repository task suite and choose/update the default model from measured results

## License

MIT
