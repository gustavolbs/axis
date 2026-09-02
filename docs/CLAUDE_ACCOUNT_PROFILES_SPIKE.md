# Claude Account Profiles Spike

## Status

Experimental only. This spike does **not** register Claude subscriptions as production inference providers, does not change provider budgets/capability governance, and does not bind any Project to an account automatically.

## Hypothesis

The spike tests whether Local Coder can keep multiple Claude Code identities authenticated side by side and select one explicitly for an execution by setting a distinct `CLAUDE_CONFIG_DIR` for every subprocess.

The implementation uses only documented Claude Code CLI surfaces:

- `CLAUDE_CONFIG_DIR` for isolated Claude configuration;
- `claude auth login` / `claude auth login --sso` for official authentication;
- `claude auth status` for status;
- `claude -p` for non-interactive execution;
- `claude mcp list` plus the interactive `/mcp` command for MCP/connector inspection.

No OAuth token is read, copied, parsed, logged, or stored by Local Coder.

## Important production/commercial gate

Anthropic's current legal/compliance documentation says third-party products that interact with Claude capabilities should use API-key authentication and restricts routing requests through Claude.ai subscription OAuth credentials on behalf of users. Therefore a technically successful local spike is **not** sufficient approval for a production or commercially distributed account-provider feature.

Before productizing this architecture, obtain an explicit determination from Anthropic that the intended Local Coder integration and the relevant Team/Enterprise agreement permit it. If Anthropic requires API-key authentication for this product surface, the production result is NO-GO even if the local technical experiment works.

## Implementation

### Profile metadata

Local Coder stores only safe metadata under:

```text
~/.local-coder-mcp/claude-profiles/
  profiles.json
  personal/
  livenation/
```

`profiles.json` contains only `id`, `name`, and optional `organizationLabel`. `configDir` is derived from the selected profile id and never supplied by callers. Profile ids are validated and path traversal is rejected.

The per-profile directory is handed to the official Claude CLI as:

```text
CLAUDE_CONFIG_DIR=<profile.configDir>
```

Local Coder deliberately does not inspect files Claude creates below that directory.

### Runtime environment

The Claude subprocess receives an explicit, narrow environment plus exactly one `CLAUDE_CONFIG_DIR`. Ambient provider credentials such as `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` are not inherited, because those values could override subscription authentication and defeat account isolation.

The CLI is spawned with `shell: false`, timeout/cancellation support, bounded output capture, and a SIGTERM -> SIGKILL termination sequence. Captured stdout/stderr are sanitized for known secret values, Anthropic token patterns, and bearer tokens.

### No implicit account selection

Every account operation requires a `profileId`. There is no default-profile fallback and no Project binding in this spike. A future Project integration must make the profile binding explicit and apply existing Project/provider/capability governance before launching the account runtime.

## Security: deliberately not done

This spike does **not**:

- read or copy OAuth tokens;
- read Claude Desktop sessions or cookies;
- inspect macOS Keychain or Claude credential internals;
- persist credentials in Local Coder settings;
- put credentials in telemetry;
- call private Anthropic endpoints;
- impersonate Claude Desktop;
- bypass Enterprise policy;
- inherit ambient Anthropic API/OAuth credentials;
- auto-select a Claude account based on another Project or prior run;
- change Anthropic API-key provider behavior, budgets, provider routing, or capability defaults.

`claude -p` is intentionally **not** run with `--bare`: that mode skips auto-discovery including MCP/config context and is not suitable for proving the subscription-account + connector hypothesis. The selected Claude Code profile's own officially managed configuration may therefore participate in the run; Project-level use must remain explicit and governed.

## Automated tests

`test/claude-account-profiles.test.ts` uses a fake local CLI process. It performs no Anthropic network call and no paid inference.

Coverage includes:

1. two profiles use different directories;
2. invalid ids and path traversal are rejected;
3. invocation receives exactly the selected `CLAUDE_CONFIG_DIR`;
4. there is no automatic fallback to another profile;
5. auth status exposes only allowlisted identity metadata;
6. stdout/stderr redact token-shaped values;
7. timeout terminates the subprocess;
8. `AbortSignal` cancellation terminates the subprocess;
9. missing `claude` binary reports a clear error;
10. persisted metadata cannot contain an OAuth token;
11. ambient Anthropic credentials are not inherited;
12. existing fail-safe provider capability defaults remain unchanged and the spike module is not coupled to provider/project governance classes.

## Manual live spike

Prerequisite: install Claude Code through an officially supported Anthropic method. Local Coder does not install or update it.

Build first:

```bash
npm run build
```

### 1. Create isolated profiles

```bash
node scripts/claude-account-profile-spike.mjs create personal "Claude Personal"
node scripts/claude-account-profile-spike.mjs create livenation "Claude LiveNation" "LiveNation"
node scripts/claude-account-profile-spike.mjs list
node scripts/claude-account-profile-spike.mjs discover
```

Record the two `configDir` values. They must be different.

### 2. Authenticate Personal through the official flow

```bash
node scripts/claude-account-profile-spike.mjs login personal
node scripts/claude-account-profile-spike.mjs status personal
```

Complete the browser/OAuth flow opened by Claude Code itself. Local Coder does not capture the browser session or credentials.

### 3. Authenticate Enterprise/LiveNation through official SSO

```bash
node scripts/claude-account-profile-spike.mjs login livenation --sso
node scripts/claude-account-profile-spike.mjs status livenation
```

Complete the corporate SSO flow in Claude Code. If the organization disables Claude Code, OAuth, MCP, or a connector, stop and record the policy result; do not work around it.

### 4. Prove simultaneous isolation

Run repeatedly, in alternating order:

```bash
node scripts/claude-account-profile-spike.mjs status personal
node scripts/claude-account-profile-spike.mjs status livenation
node scripts/claude-account-profile-spike.mjs status personal
```

Expected: each status remains authenticated and reports the intended identity/organization. If both profiles unexpectedly report the same account, mark profile isolation NO-GO and do not inspect/copy Claude credential storage to diagnose it.

Anthropic documents that when `CLAUDE_CONFIG_DIR` is set, Claude Code stores `.credentials.json` under that directory and keys the macOS Keychain entry to that directory, so different config directories read different Keychain entries. The spike still treats credential storage as opaque and validates only supported CLI behavior; it never reads Keychain or credential files itself.

### 5. Prove non-interactive execution on each subscription identity

```bash
node scripts/claude-account-profile-spike.mjs invoke personal "Reply only with OK"
node scripts/claude-account-profile-spike.mjs invoke livenation "Reply only with OK"
```

Expected: both return `OK` without an Anthropic API key. These are live Claude calls and may consume subscription/Agent SDK quota; they are never run in CI.

### 6. Inspect MCPs/connectors

First inspect CLI-configured or enterprise-managed MCP servers:

```bash
node scripts/claude-account-profile-spike.mjs mcp-list personal
node scripts/claude-account-profile-spike.mjs mcp-list livenation
```

Then inspect the selected Claude.ai account interactively, because Claude.ai connectors are surfaced by Claude Code's `/mcp` UI:

```bash
node scripts/claude-account-profile-spike.mjs shell livenation
```

Inside Claude Code:

```text
/status
/mcp
```

Confirm the LiveNation identity and whether corporate connectors such as Jira/Confluence appear. Team/Enterprise organizations may restrict available connectors/admin configuration; that policy is authoritative.

If Jira is visible and corporate policy allows the access, perform the manual proof:

```text
List my Jira issues assigned to me.
```

Do not add a server, copy a token, or bypass an organization restriction merely to make this test pass.

### 7. Programmatic MCP proof

After identifying the exact allowed MCP tool pattern from the live account, test it through the non-interactive surface. Example only — replace the pattern with the real server/tool name discovered above:

```bash
node scripts/claude-account-profile-spike.mjs invoke livenation \
  "Using only the available Jira MCP tools, list my Jira issues assigned to me." \
  --allowed-tools "mcp__REAL_JIRA_SERVER__*"
```

A successful programmatic MCP invocation is stronger evidence than connector visibility alone. If the connector is visible interactively but unavailable to `claude -p`, record that as a surface-specific limitation rather than bypassing it.

## Results

| Test | Result |
| --- | --- |
| Personal OAuth login | pending manual |
| Enterprise SSO login | pending manual |
| Profiles simultaneously authenticated | pending manual |
| Identity remains distinct after alternating profiles | pending manual |
| `claude -p` Personal | pending manual |
| `claude -p` Enterprise | pending manual |
| `claude mcp list` | pending manual |
| Claude.ai `/mcp` connector visibility | pending manual |
| Jira MCP invocation interactive | pending manual |
| Jira MCP invocation via `claude -p` | pending manual |
| Anthropic terms/contract approval for production use | pending external determination |

## Go / No-Go criteria

### Technical GO

The spike is technically successful if we can prove all of the following without manipulating credentials directly:

- multiple accounts remain authenticated at the same time;
- each account is isolated through its explicitly selected profile;
- official OAuth/SSO works for the intended identities;
- `claude -p` invokes the selected subscription identity without an API key.

MCP/connector use is tracked separately because availability can depend on account surface and Enterprise policy.

### Technical NO-GO

Stop if the experiment requires any of the following:

- copying or parsing an OAuth token;
- reusing Claude Desktop cookies/session state;
- private endpoints or reverse engineering;
- bypassing Enterprise policy;
- relying on implicit/shared identity behavior that prevents proving profile isolation.

### Production/commercial GO

Requires both technical GO **and** confirmation that Anthropic's current terms and the relevant Enterprise agreement permit the account-provider architecture for Local Coder. Without that confirmation, do not ship this as a production third-party OAuth integration.

## Future Project binding proposal (not implemented)

If the spike succeeds and the policy/legal gate is cleared, model Claude subscription identities separately from API-key providers:

```text
Inference Connections
  API Providers
    - OpenAI API
    - Anthropic API
    - Ollama

  Account Providers
    - Claude Account
        - Personal
        - LiveNation
        - Company B
```

A future Project may contain an explicit immutable/confirmed binding such as:

```text
Project: LiveNation
claudeAccountProfile: livenation
folder: ~/work/livenation/repo
capabilities:
  Jira: allowed
  Confluence: allowed
```

The account profile carries identity and organization policy; it is not another API key. Project execution must fail closed if no account profile was explicitly selected, if the binding is missing, or if existing capability policy denies the requested MCP/tool.

## Official references used by this spike

- Claude Code environment variables: https://code.claude.com/docs/en/env-vars
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code authentication and credential precedence: https://code.claude.com/docs/en/authentication
- Claude Code MCP/connectors: https://code.claude.com/docs/en/mcp
- Claude Code legal and compliance / credential-use restrictions: https://code.claude.com/docs/en/legal-and-compliance
