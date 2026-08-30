# local-coder-mcp

A global MCP bridge that lets Claude keep expensive reasoning/review work while delegating bounded implementation to a coding model running locally in Ollama.

```text
request
  |
  +--> deterministic tool? --> lint/test/format/search directly
  |
  +--> classify_local_code_task
          |
          +--> claude ------> discovery / architecture / risky reasoning
          |
          +--> local -------> execute_local_code_task
                                  |
                                  +--> bounded files
                                  +--> Ollama local model
                                  +--> edit -> validate -> retry
                                  +--> diff / success / escalation
                                          |
                                          v
                                     Claude review
```

## v0.3 capabilities

The server exposes seven MCP tools:

- `local_coder_health` — verify Ollama connectivity and configured model availability.
- `classify_local_code_task` — deterministic routing classifier: `deterministic`, `local`, or `claude`.
- `discover_local_workspace` — bounded workspace tree/package-script discovery without following symlinks.
- `search_local_workspace` — literal text/code search across bounded safe workspace files.
- `delegate_code_task` — read-only local-model delegation for cheap drafting.
- `execute_local_code_task` — bounded local implementation with explicit edit permissions, validation, retry, rollback, and exact diff.
- `local_coder_telemetry` — aggregate routing, success/escalation, retry, token, and duration telemetry.

`execute_local_code_task` is intentionally not a general shell agent. Claude must decide the implementation boundary first and explicitly provide the files that may be edited.

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

The routing policy is stored separately from project instructions and installs to:

```text
~/.claude/rules/local-coder.md
```

Install/update it with:

```bash
npm run install:routing
```

The policy tells Claude to:

1. prefer deterministic tools when no LLM is needed;
2. call `classify_local_code_task` when routing is not obvious;
3. keep discovery, architecture, security-sensitive, cross-cutting, and unknown-root-cause work in Claude;
4. use discovery/search only to identify minimal relevant context;
5. delegate bounded known implementations to `execute_local_code_task`;
6. review the returned diff and validation evidence;
7. take over when local execution escalates.

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

These tools are read-only and are intended to help Claude construct a minimal `editableFiles + contextFiles` TaskSpec.

## Agentic execution example

```json
{
  "workspace": "/Users/me/WORK/my-app",
  "task": "Add the existing Spinner while the profile query is loading.",
  "editableFiles": [
    "src/profile/UserProfile.tsx",
    "src/profile/UserProfile.test.tsx"
  ],
  "contextFiles": [
    "src/ui/Spinner.tsx"
  ],
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

The local executor snapshots every editable file, reads only explicitly supplied files, requests structured complete-file edits from Ollama, writes only allowlisted files, validates sequentially, retries with validation feedback, and returns an invocation-scoped diff. Failed tasks return `status: "escalated"` and roll back by default.

## Safety boundaries

### Workspace and file access

- `workspace` must be absolute.
- file arguments must be workspace-relative.
- `..` traversal is rejected.
- symlinks resolving outside the workspace are rejected.
- `.git`, `node_modules`, `.ssh`, and real `.env*` secret files are blocked.
- `.env.example`, `.env.sample`, and `.env.template` are allowed.
- edits are restricted to the exact `editableFiles` allowlist.
- per-file and total-context byte limits prevent accidental huge prompts.

### Command execution

The local model does **not** choose shell commands. Validation commands are supplied by the caller and executed with `shell: false`.

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

It intentionally does **not** persist prompts or source-code contents. Events contain aggregate metadata such as route, status, attempts, token counts, generation duration, validation duration, and changed-file count.

Call `local_coder_telemetry` to get a summary for a lookback window. It reports:

- classifier route counts;
- local execution success/escalation/error rate;
- retry rate and average attempts;
- changed-file count;
- local prompt/completion/total tokens;
- generation and validation time;
- local API inference cost (`$0`).

The cost field does not pretend to estimate hardware depreciation, electricity, or Claude planning/review usage.

Disable or relocate telemetry with configuration variables below.

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
| `LOCAL_CODER_MAX_CONTEXT_BYTES` | `600000` | Maximum combined repository file context |
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
- [ ] benchmark candidate local models on the same real repository task suite and choose/update the default model from measured results

## License

MIT
