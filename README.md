# local-coder-mcp

A global MCP bridge that lets Claude delegate bounded coding work to a model running locally in Ollama.

## v0.1 goal

The first version intentionally does **not** edit files or run shell commands. It proves the critical path first:

```text
Claude Code Desktop (Code tab)
          |
          | MCP stdio
          v
   local-coder-mcp
          |
          | HTTP localhost:11434
          v
        Ollama
          |
          v
 qwen2.5-coder:14b
```

It exposes two MCP tools:

- `local_coder_health` — verifies Ollama connectivity and checks that the configured model exists.
- `delegate_code_task` — sends a bounded coding task to the local model and returns its answer plus basic token/duration telemetry.

After this bridge is validated, the next milestone is an agentic executor with restricted workspace access, file editing, tests/typecheck/lint, retries, diff return, and escalation back to Claude.

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

## Install

```bash
git clone https://github.com/gustavolbs/local-coder-mcp.git
cd local-coder-mcp
npm install
npm run check
npm run build
```

## Install globally in Claude Code Desktop

You do **not** need the Claude CLI for this repository's installer.

Claude Code Desktop and the Claude Code CLI share user-scoped MCP configuration in `~/.claude.json`. The installer below adds `local-coder` at user scope so it is available across all local projects in the **Code** tab.

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

> This is for Claude Code / the Code tab. The regular Claude Desktop chat app uses a separate MCP configuration.

## First test in Claude

Open any repository in Claude Code Desktop and ask:

> Use `local_coder_health` and tell me whether the local coding model is reachable.

Expected result includes:

```json
{
  "ok": true,
  "configuredModel": "qwen2.5-coder:14b",
  "modelAvailable": true
}
```

Then test actual delegation:

> Delegate this to the local coding model: create a strict TypeScript function that groups users by `companyId`, with no dependencies. Do not implement it yourself; show me the local model result.

Claude should call `delegate_code_task` and return the local model response with `[local-coder metadata]`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama server |
| `LOCAL_CODER_MODEL` | `qwen2.5-coder:14b` | Local executor model |
| `LOCAL_CODER_TIMEOUT_MS` | `180000` | Ollama request timeout |

## Why v0.1 is read-only

The first milestone isolates transport/model failures. Once Claude can discover the MCP tool and Ollama can answer through it, the MCP and inference layers are proven independently of repository permissions.

File writes and shell execution introduce additional boundaries:

- workspace resolution
- path traversal protection
- explicit write permissions
- command allowlists
- rollback
- tests and retry semantics
- git diff generation
- escalation back to Claude

Those belong in the next milestone.

## Roadmap

- [x] MCP stdio server
- [x] Ollama bridge
- [x] local model health check
- [x] bounded coding delegation
- [x] basic telemetry
- [ ] workspace-aware file reading
- [ ] patch/edit operations restricted to an allowed workspace
- [ ] test/lint/typecheck runner
- [ ] local retry loop
- [ ] git diff summary
- [ ] semantic failure/escalation contract for Claude
- [ ] global routing policy
- [ ] success-rate and token/cost telemetry

## License

MIT
