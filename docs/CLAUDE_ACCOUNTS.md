# Claude Accounts

## Status

Claude account profiles are now a first-class Local Coder desktop feature rather than a command-line-only spike.

The feature keeps multiple Claude subscription identities isolated by assigning one `CLAUDE_CONFIG_DIR` to each profile and delegates authentication to the official Claude Code runtime. Local Coder stores only safe profile metadata and never reads OAuth tokens, Claude credential files, browser cookies, or macOS Keychain contents.

## Proven live behavior

The original technical spike was validated manually with isolated Personal and Enterprise identities. The Enterprise profile successfully:

- remained authenticated independently from the other profile;
- ran `claude -p` through its selected profile;
- loaded the LiveNation Claude.ai MCP connector set;
- invoked `mcp__claude_ai_LN_Jira__jira_search` non-interactively;
- returned the current Jira issues assigned to that Enterprise identity.

This proves the technical path:

```text
Local Coder profile
  -> isolated CLAUDE_CONFIG_DIR
  -> Claude subscription identity
  -> Claude Code
  -> account-specific Claude.ai connectors
  -> organization MCP tool
```

## Desktop UI

Open **Settings -> Claude accounts**.

The page can:

- detect the installed Claude Code runtime and version;
- list every isolated account profile;
- create a new profile without handling credentials;
- show authentication state and safe account metadata;
- launch normal Claude sign-in or Enterprise SSO through Claude Code;
- list MCP connections for each authenticated profile.

Existing profiles created by the spike harness appear automatically because the UI uses the same profile store.

## Isolation and security

Each profile has a separate configuration directory under `~/.local-coder-mcp/claude-profiles/`. The subprocess environment is deliberately narrow and does not inherit ambient Anthropic API/OAuth credentials that could override the selected subscription identity.

The desktop bridge does not expose arbitrary Claude prompt execution. It exposes bounded account-management operations only. This prevents renderer code from turning account management into an unrestricted shell or MCP execution surface.

## What is not implemented here

This feature does not yet aggregate data across accounts and does not yet make subscription accounts another API-key provider in generic model routing.

Those are separate architectural decisions because they introduce additional concerns:

- normalization and persistence of cross-organization data;
- capability-level read/write policy for MCP tools;
- data retention and organization-boundary rules;
- subscription quota accounting versus API-dollar budgets;
- explicit Project/account bindings;
- Anthropic and Enterprise contractual requirements for productized subscription-account use.

## Future unified work view

A safe future collector can query each selected account independently and persist only normalized results locally. For example:

```text
Personal Claude profile -> Calendar MCP -> normalized events
Company A profile       -> Calendar/Jira MCP -> normalized events + tickets
Company B profile       -> Calendar/Jira MCP -> normalized events + tickets
                                      |
                                      v
                         Local Coder unified work store
                                      |
                         Today / Calendar / Tickets UI
```

No credential would cross profile boundaries. Each collection run would execute under the source profile and only its returned business data would be normalized into the local view.

## Productization gate

Technical success does not by itself resolve the external policy question. Anthropic's current documentation directs developers building products/services to use supported developer authentication methods and imposes restrictions around third-party routing of Claude subscription credentials. Before distributing this account-provider architecture as a commercial third-party integration, confirm the permitted authentication model with Anthropic and any applicable Enterprise agreement.
