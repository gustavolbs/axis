# Runtime Security, Policies, and Effective Context

This document defines the cross-cutting security model for Axis runtime execution after the canonical product/runtime composition described in `docs/AGENT_RUNTIME_PRODUCT_COMPOSITION.md`.

The goal is not to add another tool-specific permission layer. The goal is to make the authority used for every runtime action explicit, Company-aware, Project-aware, auditable, and inspectable.

## Canonical authority

Every runtime decision is evaluated against the immutable `AgentSessionContext` that already defines:

- session id;
- Company;
- Project;
- exact Connection and auth kind;
- exact model;
- exact execution target;
- roots and root access;
- effective capabilities;
- permissions;
- bound resources such as MCP servers, browser and Project Memory.

Workspace paths, provider display labels, account names, tool output, repository content, browser content and MCP responses do not select or broaden Company authority.

Shared local Connections such as Ollama may have `connection.companyId === null`, but policy resolution still uses the active session Company. A shared local transport is therefore shared infrastructure, not shared Company authority.

## Authority modes

`RuntimeAuthorityMode` normalizes the product policy into five monotonic modes:

| Mode | Default behavior |
| --- | --- |
| `plan` | Read/validation only. Mutations, commands and external actions are denied. |
| `ask-before` | Read/validation are allowed. Other actions require a Runtime UI decision. |
| `workspace-write` | Ordinary in-workspace writes/commands are allowed. External and destructive actions require approval. |
| `auto` | Actions are allowed inside the scoped policy boundary. Destructive actions still require approval unless explicitly narrowed further. |
| `full-access` | Broadest mode. It is only effective when explicitly configured and is still subject to hard runtime boundaries and explicit deny rules. |

Company, Project and trusted session modes combine by choosing the most restrictive mode. A Project or session override cannot widen its parent scope.

## Persistent policy hierarchy

Runtime policies are persisted locally by `RuntimePolicyStore` and partitioned by Company, then Project.

A persisted rule contains:

- stable rule id;
- effect: `allow`, `ask` or `deny`;
- domain;
- optional case-insensitive glob over the canonical operation descriptor;
- optional note.

Supported domains are:

- `filesystem`;
- `process`;
- `git`;
- `mcp`;
- `browser`;
- `network`;
- `destructive`;
- `external`.

Example intent:

```text
allow process "npm test"
allow process "npm run lint"
ask  process "npm install"
deny process "rm *"
allow network "https://api.github.com/*"
deny network "https://metadata.example/*"
```

Policy composition is monotonic:

1. Company policy is evaluated.
2. Project policy may make it stricter, never broader.
3. A trusted session override may make it stricter, never broader.
4. If several matching rules disagree, the most restrictive effect wins: `deny > ask > allow`.
5. An explicit Runtime UI approval may satisfy one `ask`; it never overrides `deny`.

A rule stored under Company A is not visible when evaluating Company B.

## Approval binding

Permission approvals are intentionally one-shot.

A pending approval is bound to:

- session id;
- Company id;
- tool name;
- SHA-256 fingerprint of the raw tool arguments;
- canonical decision request id.

The argument fingerprint is computed before lifecycle redaction. UI-visible events can therefore hide credentials while the approval still applies only to the exact underlying tool call.

Approvals do not cross sessions or Companies and cannot be replayed after consumption.

## External content is data, not authority

The runtime system prompt and trusted composition enforce a strict authority boundary:

- web pages;
- MCP results;
- repository instructions;
- files;
- tool output;
- provider content

are data to be analyzed, not security policy.

External content cannot:

- change Company or Project;
- change Connection or model;
- change execution target;
- add or widen roots;
- enable a tool or MCP server;
- grant permissions;
- alter network policy;
- approve a mutation;
- construct a trusted session policy override.

`assertTrustedPolicyOverride()` rejects policy objects that do not originate from trusted session composition.

## Network boundary

`runtime-security/network-policy.ts` is the common outbound network classifier and authorizer. `runtime-security/secure-fetch.ts` performs manual redirect handling so every hop is re-authorized before a request is sent.

The boundary is used by:

- browser navigation;
- provider HTTP clients;
- MCP Streamable HTTP;
- MCP legacy SSE;
- Local Worker requests.

Default protections include:

- credential-bearing URLs are denied;
- metadata-service targets are denied;
- loopback requires explicit opt-in;
- private, link-local and reserved targets require explicit opt-in;
- deny lists win over allow lists;
- HTTP requires an explicit per-client opt-in;
- every redirect target is re-authorized;
- authorization/cookie/API-key style headers are stripped on cross-origin redirects.

### Provider rules

Cloud provider HTTP uses HTTPS and denies private/loopback targets.

Ollama receives an explicit local-only compatibility policy so ordinary loopback HTTP can work without making that permission global.

### Local Worker rules

The Local Worker policy is derived from the configured worker URL. Loopback/private access is allowed only because that destination was explicitly configured, and `allowedHosts` is narrowed to that configured hostname. Redirects cannot move the request to another host.

### MCP HTTP/SSE rules

Native MCP HTTP/SSE uses the common network policy and narrows the authorized host to the configured MCP server host after the initial authorization succeeds.

For legacy SSE, a server-provided message endpoint is re-authorized and must remain on the configured server origin. This prevents a trusted initial server from pivoting the client toward metadata, localhost, another private host, or another public origin.

## Secret redaction

`runtime-security/redaction.ts` is the canonical redaction layer for runtime-facing data.

It covers:

- common API key formats;
- bearer/basic authorization;
- GitHub/Slack-style tokens;
- JWT-shaped tokens;
- passwords;
- cookies;
- authorization headers;
- API-key/token/password/secret fields;
- private keys;
- credential-bearing URLs;
- secret references;
- known secret values supplied by the caller.

Redaction is applied before product lifecycle fan-out, so listeners such as Runtime UI, Project Memory and security audit receive a safe event representation.

Project Memory now reuses the same text redactor rather than maintaining a second secret-pattern implementation.

The process tool environment boundary remains complementary: ambient credential-shaped variables are dropped before process creation, and explicit credential-shaped overrides are rejected.

## Effective Context Inspector

`buildEffectiveRuntimeContext()` builds the canonical secret-free representation intended for Runtime UI inspection.

It is derived from the same immutable `AgentSessionContext` and `RuntimePolicyEngine` used for execution, not reconstructed from display state.

It exposes:

- Company;
- Project;
- Connection id/provider family/auth kind and whether the Connection is shared-local;
- exact model;
- execution target;
- effective authority mode plus Company/Project/session modes;
- roots and read/write access;
- enabled/denied MCP resources;
- permission entries;
- effective policy rules and their scopes;
- invariant network protections.

`AgentProductRuntime.effectiveRuntimeContext(sessionId)` exposes the representation to product/UI composition.

The inspector never includes credential material.

## Audit

The runtime-security audit layer records security-relevant decisions with the authority that produced them:

- permission requested;
- permission allowed/denied;
- policy decision;
- decision requested/resolved;
- tool mutation;
- external action;
- runtime error.

Each record includes the effective:

- session id;
- Company id;
- Project id when present;
- Connection id;
- model id;
- execution target id.

Audit detail is redacted before it is handed to an audit sink.

## Destructive operations

Destructive classification combines explicit tool mutation risk with known destructive process/Git operations and destructive tool naming.

Under `workspace-write` or `auto`, destructive activity requires explicit authority. `full-access` may allow it only when explicitly configured, and an explicit deny rule still wins.

Tool-local safety checks remain defense in depth. The runtime policy engine is the common authorization boundary and is not replaced by dispersed per-tool checks.

## Regression invariants

`test/runtime-security-policies.test.ts` pins the CHAT J requirements:

1. Company isolation of policies.
2. Project override cannot widen Company deny.
3. Session override cannot widen Project/Company deny.
4. Deny wins.
5. Approval does not cross session and is one-shot.
6. Approval does not cross Company.
7. Network redirect bypass is blocked.
8. Cross-Company MCP resource is blocked.
9. Browser private/metadata/credential-bearing targets are blocked.
10. Process environment does not leak ambient secrets.
11. Lifecycle/UI-facing values/Project Memory share redaction.
12. External content cannot elevate authority.
13. Effective Context matches the execution authority source.
14. Shared local Connection does not create shared Company authority.
15. Destructive operations require appropriate authority.

## Validation

Mergeable CHAT J changes must pass:

```bash
npm run release:validate
npm run check
```

CI runs `npm run check` on Linux and Windows and also validates the macOS desktop/package contract.
