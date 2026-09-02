# Provider Connection Profiles and Work Hub

## Status

This document describes the first production-shaped implementation of multi-identity provider connections and the local Work Hub in the standalone Local Coder desktop application.

The implementation is intentionally split into two layers:

1. **Connection profiles** answer _which exact identity pays for / authenticates this model call?_
2. **Work Hub sources** answer _which exact account and read-only connector produced this calendar/ticket/message data?_

A provider brand is not an identity. `OpenAI`, `Anthropic`, and `Ollama` remain provider families; each account or credential is represented as an independent connection instance.

## Connection model

Local Coder currently understands these connection classes:

| Connection class | Provider family | Authentication owner | Billing mode | MCP source capable |
| --- | --- | --- | --- | --- |
| Ollama local | Ollama | local runtime | local | no |
| OpenAI API credential | OpenAI | Local Coder secret reference | API/metered | no |
| Anthropic API credential | Anthropic | Local Coder secret reference | API/metered | no |
| ChatGPT account | OpenAI | official Codex runtime | subscription/account | yes, when Codex exposes/configures MCP |
| Claude account | Anthropic | official Claude Code runtime | subscription/account | yes, when the account exposes/configures MCP/connectors |

Examples that are intentionally distinct:

```text
GPT · ChatGPT Personal       subscription account
GPT · Personal API           OPENAI_API_KEY profile
GPT · Company API            organization-scoped API profile
Claude Personal              Claude subscription account
Claude LiveNation            Claude Enterprise account
Claude · Personal API        Anthropic API profile
Ollama local                 local runtime
```

The Chat model catalog contains **connection instances**, not only the base provider family. This means two chats can select different identities even if both ultimately use OpenAI or Anthropic.

## API credential isolation

Existing Local Coder credential profiles remain the storage abstraction for API keys:

- raw secrets stay in macOS Keychain or an environment variable;
- metadata stores only the secret reference;
- every credential becomes a stable connection identity;
- provider-level dollar budgets remain enforced before the connection alias is applied.

A credential carrying `organizationId` is still a hard Project boundary. Organization-scoped API credentials are visible in Settings so the user can understand what exists, but they are deliberately omitted from the project-less personal Chat catalog. They must be selected through a Project that explicitly binds that credential.

This preserves the previous invariant that a corporate API key cannot silently become a personal Chat credential.

## Claude account profiles

Claude account profiles use one `CLAUDE_CONFIG_DIR` per identity under:

```text
~/.local-coder-mcp/claude-profiles/
```

Authentication is performed by official Claude Code commands such as:

```text
claude auth login
claude auth login --sso
claude auth status
```

Local Coder does not read `.credentials.json`, browser cookies, OAuth tokens, or Keychain entries. It only supplies the selected profile directory to the official runtime.

The live technical proof completed during this feature demonstrated:

```text
Local Coder profile: livenation
  -> isolated CLAUDE_CONFIG_DIR
  -> Claude Enterprise identity
  -> Claude Code print mode
  -> Claude.ai LiveNation Jira connector
  -> mcp__claude_ai_LN_Jira__jira_search
  -> assigned Jira issues returned successfully
```

This is the evidence behind promoting the spike into the desktop connection system.

## ChatGPT / Codex account profiles

ChatGPT account profiles use one independent `CODEX_HOME` per identity under:

```text
~/.local-coder-mcp/codex-profiles/
```

Local Coder invokes only official Codex CLI login/status/exec/MCP surfaces. Authentication remains owned by Codex. Profile metadata never contains a ChatGPT OAuth token or API key.

Ordinary account execution uses an ephemeral, read-only Codex execution boundary. Work Hub MCP access is configured separately and explicitly.

Relevant official references:

- Codex authentication: https://developers.openai.com/codex/auth
- Codex CLI: https://developers.openai.com/codex/cli/reference
- Codex repository: https://github.com/openai/codex

## Chat behavior

For project-less Chat, the model picker can now represent exact connections instead of failing when multiple credentials for the same provider exist.

Conceptually:

```text
Chat A -> Claude Personal
Chat B -> Claude LiveNation
Chat C -> ChatGPT Personal
Chat D -> OpenAI API / Personal key
Chat E -> Ollama
```

The selected synthetic connection provider is persisted in the existing `ModelSelection.providerId`, so no second identity-selection mechanism is required in the conversation store.

Legacy `openai` / `anthropic` provider IDs remain available for backward compatibility with existing conversations. New exact connection aliases disambiguate multiple identities.

### Account Chat capability boundary

Subscription-account Chat is model-oriented. It does not receive a generic renderer-to-CLI prompt bridge, and the provider adapter rejects declared external capability requests. MCP data acquisition belongs to Work Hub sources, where the allowed connector tools are explicit and auditable.

## Work Hub architecture

The Work Hub never merges credentials or sessions. It merges **normalized results**.

```text
Claude Personal ---------> Calendar collector ----┐
                                                   |
Claude LiveNation -------> Jira collector --------+--> normalized local Work Hub
                         -> Calendar collector ----+       |
                                                   |       +--> Today
ChatGPT Company B -------> Teams collector --------+       +--> Calendar
                         -> ticket collector ------+       +--> My work
                                                           +--> Inbox
```

Every collector runs under exactly one connection profile. The output receives immutable provenance:

```ts
{
  sourceId,
  connectionId,
  providerFamily,
  system,
  externalId,
  collectedAt
}
```

The aggregate is assembled locally. Local Coder does **not** send LiveNation + Personal + Company B aggregate data back to one corporate provider to summarize it.

If a future cross-company summary requires an LLM, the safe default should be local inference unless policy explicitly permits another route.

## Normalized contracts

### Calendar

The provider/connector is instructed to normalize remote calendar semantics to:

```ts
{
  kind: 'calendar',
  sourceId,
  connectionId,
  providerFamily,
  system,
  externalId,
  title,
  start,
  end,
  allDay,
  calendar?,
  location?,
  meetingUrl?,
  organizer?,
  status?,
  url?,
  collectedAt
}
```

This is independent of whether the original remote source is Google Calendar, Microsoft 365/Outlook calendar, or another MCP-backed calendar.

### Tickets / work items

Remote status is preserved verbatim and also mapped to a common status:

```text
backlog
TODO
todo
in-progress
blocked
review
qa
done
cancelled
unknown
```

Normalized ticket shape:

```ts
{
  kind: 'ticket',
  key,
  title,
  status,              // original remote status
  normalizedStatus,    // common Work Hub status
  priority?,
  assignee?,
  dueAt?,
  updatedAt?,
  project?,
  ...provenance
}
```

Jira `Ready for Code Review`, for example, becomes `review` while the original value is retained for display/debugging.

### Messages

The common inbox shape intentionally remains small:

```ts
{
  kind: 'message',
  title,
  preview?,
  sender?,
  timestamp,
  channel?,
  unread?,
  requiresAttention?,
  ...provenance
}
```

The current Messages source is intentionally scoped to Jira comments on the current account's assigned tickets and attention-worthy Slack messages. It does not crawl GitHub, email, Teams, calendars, or other connectors on the account. The normalized shape can still accommodate future messaging providers without putting vendor fields into the Work Hub UI.

## Work Hub source configuration

A source contains:

```ts
{
  id,
  label,
  connectionId,
  kind: 'calendar' | 'tickets' | 'messages',
  system,
  toolAllowlist,
  retention,
  enabled
}
```

The `connectionId` is the security/isolation boundary. A LiveNation Jira source cannot accidentally run through the Personal profile because the collector resolves the exact bound connection.

### Connector discovery and bounded access

The desktop discovers the healthy connectors owned by the source's exact account, selects only the servers relevant to the source kind, and exposes those servers to the collector. A calendar source does not initialize Jira, Slack, or every other connector on a large enterprise account.

For Claude, the selected provider-managed server name is converted to its MCP namespace (for example `Google Calendar` becomes `mcp__claude_ai_Google_Calendar__*`). The broad account-wide `mcp__*` pattern is never used. Legacy sources may still carry an explicit `toolAllowlist`, but users do not need to find or enter MCP tool names in the desktop UI.

Collector prompts additionally prohibit remote mutations: create/update/delete/comment/send/transition/acknowledge operations are outside the Work Hub read path.

Enterprise policy remains authoritative. If the remote organization requires an interactive approval or disables a connector, Local Coder records the source error rather than bypassing the restriction.

## Retention and stale-while-revalidate

Work Hub keeps its latest normalized snapshot under `~/.local-coder-mcp/work-hub/cache/`. The desktop can therefore render meetings, tickets and messages immediately after it reopens, then refresh those sources in the background. A manual **Sync** requests the same revalidation immediately, which replaces the cached snapshot only after a successful collection.

Cache files use owner-only permissions where the OS supports them and contain normalized remote data only, never OAuth/API credentials. Failed or interrupted refreshes preserve the last successful snapshot. The former `memory` source value is accepted for compatibility and migrated to this local cache behavior.

## Desktop surfaces

### Settings -> Connections

Shows:

- Claude Code runtime state;
- Codex/ChatGPT runtime state;
- all subscription account profiles;
- individual API-key connection identities;
- Ollama local connection;
- login / Enterprise SSO / ChatGPT device-login actions;
- account MCP discovery.

### Global Work Hub

A global launcher is mounted outside individual Chat/Project surfaces and contains:

- **Today** — today's meetings + active work + attention messages;
- **Calendar** — a weekly agenda with current-time indicator, overlapping event layout and meeting join actions on hover;
- **My work** — active tickets grouped by normalized status;
- **Inbox** — normalized message sources;
- **Sources** — account binding, discovered connector systems, retention, live sync stage, duration, result count and actionable failure state.

## Security properties

The implementation deliberately does not provide the renderer with:

- arbitrary `spawn` / `exec`;
- arbitrary Claude/Codex prompt execution;
- OAuth token access;
- API-key reads;
- browser cookie access;
- credential-file access;
- Keychain inspection;
- a generic MCP call surface.

Renderer IPC is limited to account management, safe status/MCP discovery, connection listing and host-defined Work Hub collection operations.

## CI and test strategy

CI uses fake Claude and Codex executables. It performs no paid/provider network inference and does not require real account login.

Coverage includes:

- independent `CLAUDE_CONFIG_DIR` profiles;
- independent `CODEX_HOME` profiles;
- path traversal rejection;
- no fallback between account profiles;
- ambient Anthropic/OpenAI credential stripping;
- secret redaction;
- timeout/cancellation;
- missing runtime errors;
- multiple API credentials becoming separate connection identities;
- organization API credentials staying Project-only;
- ticket/calendar/message normalization;
- provider/source provenance;
- atomic normalized-data caching, restart restore and stale-while-revalidate behavior;
- refusal to use model-only/API connections as Work Hub MCP sources;
- explicit MCP allowlist requirement;
- bounded desktop IPC contract.

## Product-policy gates

Technical support is not the same as contractual authorization to distribute account-subscription routing as a commercial third-party product.

For Claude, retain the existing Anthropic legal/compliance gate documented by the spike:

- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/mcp

For ChatGPT/Codex, authentication uses the official Codex runtime and ChatGPT login path, but external product distribution/account-routing terms must likewise be reviewed before presenting this as a generally available third-party authentication product.

Local technical functionality can remain useful independently of that decision: API-key connections, local Ollama, normalized Work Hub architecture, Project credential isolation and connector provenance do not depend on copying subscription credentials.
