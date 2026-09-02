# Claude Accounts

Claude subscription profiles remain supported, but they are now one implementation of the broader **Provider Connections** architecture.

The current design, UI, security boundaries, per-chat identity routing, ChatGPT/Codex account profiles, API-key connection instances and Unified Work Hub are documented in:

- [`CONNECTION_PROFILES_AND_WORK_HUB.md`](./CONNECTION_PROFILES_AND_WORK_HUB.md)

## Claude-specific isolation

Each Claude profile still receives its own `CLAUDE_CONFIG_DIR` under `~/.local-coder-mcp/claude-profiles/`. Authentication is delegated to official Claude Code login/status flows. Local Coder does not read OAuth tokens, Claude credential files, browser cookies or macOS Keychain contents.

The Enterprise technical proof remains valid:

```text
Local Coder connection
  -> isolated CLAUDE_CONFIG_DIR
  -> Claude Enterprise identity
  -> Claude Code print mode
  -> LiveNation Claude.ai connector set
  -> mcp__claude_ai_LN_Jira__jira_search
  -> assigned Jira issues returned successfully
```

## Desktop location

Claude profiles are now managed under **Settings -> Connections**, alongside ChatGPT account profiles, individual API-key connections and Ollama.

MCP-backed calendar/ticket/message collection is configured separately in **Work Hub -> Sources**. That separation is intentional: ordinary model selection chooses an inference identity, while Work Hub sources declare exactly which account and connector capabilities may be used to collect normalized data.

## Productization gate

The technical implementation does not by itself settle external commercial/authentication policy. Before distributing subscription-account routing as a third-party product, confirm the permitted authentication model with Anthropic and any applicable Enterprise agreement.
