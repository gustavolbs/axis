# local-coder-mcp

A global MCP bridge that lets Claude keep expensive reasoning/review work while delegating bounded implementation to a coding model running locally in Ollama.

```text
Claude Code Desktop / Code tab
          |
          | plan + bounded TaskSpec
          v
   local-coder-mcp
          |
          | local files + Ollama
          v
 qwen2.5-coder:14b
          |
          | edit -> validate -> retry
          v
     exact task diff
          |
          v
       Claude review
```

## v0.2 capabilities

The server exposes three MCP tools:

- `local_coder_health` — verifies Ollama connectivity and checks that the configured model exists.
- `delegate_code_task` — read-only delegation for cheap code/patch/analysis drafting.
- `execute_local_code_task` — bounded local implementation with explicit workspace/file permissions, validation, retry, rollback, and an invocation-scoped diff for Claude review.

`execute_local_code_task` is intentionally not a general shell agent. Claude must decide the implementation boundary first and explicitly provide the files that may be edited.

## Requirements

- Node.js 20+
- Ollama running locally
- `qwen2.5-coder:14b` installed, or another model configured through `LOCAL_CODER_MODEL`
- Claude Code Desktop / Claude Code with local MCP support

Verify Ollama first:

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

For an existing clone:

```bash
git pull
npm install
npm run check
npm run build
```

## Install globally in Claude Code Desktop

You do **not** need the Claude CLI for this repository's installer.

Claude Code Desktop and the Claude Code CLI share user-scoped MCP configuration in `~/.claude.json`. The installer adds `local-coder` at user scope so it is available across local projects in the **Code** tab.

It creates a timestamped backup before modifying an existing `~/.claude.json`.

```bash
npm run install:claude
```

Then fully quit and reopen Claude Code Desktop.

The generated entry is equivalent to:

```json
{
  "mcpServers": {
    "local-coder": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/local-coder-mcp/dist/index.js"],
      "env": {
        "OLLAMA_BASE_URL": "http://127.0.0.1:11434",
        "LOCAL_CODER_MODEL": "qwen2.5-coder:14b",
        "LOCAL_CODER_TIMEOUT_MS": "180000"
      }
    }
  }
}
```

> This is for Claude Code / the Code tab. The regular Claude chat surface and graphical Connectors/Plugins UI are separate concepts; a manual user-scoped stdio MCP does not need to appear there.

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

## Agentic execution example

`execute_local_code_task` accepts an absolute workspace, explicit editable files, optional read-only context files, and validation commands.

Conceptual input:

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

The local executor:

1. snapshots every editable file at invocation time;
2. reads only `editableFiles + contextFiles`;
3. sends those contents and the bounded task to the local Ollama model;
4. accepts complete-file edits only for `editableFiles`;
5. runs validation commands sequentially;
6. feeds validation failure back to the local model for another attempt;
7. returns an exact diff relative to the invocation snapshot;
8. returns `status: "success"` when validation passes;
9. returns `status: "escalated"` after the local retry budget is exhausted;
10. restores the invocation snapshot on failure by default.

Claude can then review the returned diff instead of generating the implementation itself.

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

The local model does **not** choose shell commands.

Validation commands are supplied by the caller and executed with `shell: false`. Default executable allowlist:

```text
npm, pnpm, yarn, bun
```

Package-manager invocations are additionally restricted to validation-oriented subcommands:

```text
npm   -> test, run
pnpm  -> test, run, exec
yarn  -> test, run
bun   -> test, run
```

This intentionally rejects operations such as `npm install`, `pnpm add`, arbitrary `sh -c`, and executable paths.

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

## Result contract

Successful execution returns data shaped roughly like:

```json
{
  "status": "success",
  "attempts": 1,
  "changedFiles": ["src/profile/UserProfile.tsx"],
  "diff": "...",
  "validation": [
    { "command": "npm", "args": ["test"], "ok": true }
  ],
  "rolledBack": false,
  "summary": "Implemented loading state using the existing Spinner.",
  "generations": [
    {
      "model": "qwen2.5-coder:14b",
      "promptTokens": 1234,
      "completionTokens": 420
    }
  ]
}
```

Failure after the retry budget returns `status: "escalated"`. With the default `rollbackOnFailure: true`, the attempted diff is still returned for diagnosis but the editable files are restored before control goes back to Claude.

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
- [x] basic generation telemetry
- [ ] Claude global delegation/routing policy
- [ ] automatic task classifier
- [ ] richer success-rate and token/cost telemetry
- [ ] optional workspace discovery/search tools for the local executor
- [ ] benchmark local models on real repository tasks

## License

MIT
