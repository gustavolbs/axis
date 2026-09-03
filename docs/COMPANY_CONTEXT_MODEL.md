# Canonical company context

Axis uses **Company** as the product isolation concept for multi-company work. This document defines the first migration boundary introduced for the Codex/Claude Desktop parity roadmap.

## Canonical hierarchy

```text
Company
  ├─ connections / external resources
  ├─ Projects
  │    └─ sessions
  └─ company-scoped product state (introduced by later parity items)

Shared local execution capabilities
  └─ Ollama / local worker destinations
```

The last group is deliberately outside the Company identity tree. A local model or worker is an execution capability, not a company.

## Concepts that are not company identity

- A **workspace** is a filesystem location attached to a Project.
- An Account **organization label** is mutable display/provider metadata.
- A Claude/Codex **profile** is an authentication profile.
- `local` is a legacy execution scope and must never become a Company.
- `organizationId` and `organizationLabel` remain temporary migration inputs in older stores; new company-context consumers must use the canonical graph instead of independently interpreting them.

## Migration behavior

`CompanyContextStore` persists only the minimal stable mapping needed to bridge the current stores into the canonical model:

- known company ids and their first observed display names;
- stable connection-id → company-id bindings.

For an existing connection, legacy organization metadata is consumed only when no canonical binding exists. Once persisted, changing an Account label or a legacy organization hint cannot silently re-home that connection.

Projects currently provide their existing stable isolation id as a migration source. Sessions are associated with their Project's company, while projectless sessions belong to `personal`. A later parity checklist item will snapshot company/connection/model/destination directly into the session so those scopes become immutable for the life of that session.

## Persistence boundary

The company-context file intentionally does **not** store:

- workspace or repository paths;
- provider secrets or OAuth credentials;
- MCP payloads or tool output;
- prompts or conversation content;
- mutable provider/account labels after a binding is established.

The file is local-only, written with restrictive permissions, and lives at `~/.local-coder-mcp/company-context.json` by default.

## Runtime visibility

The desktop runtime exposes the normalized hierarchy through:

```text
GET /api/companies/context
```

Callers receive only canonical Company terminology plus `sharedConnectionIds`; they do not need to reconstruct company identity from workspace, organization labels, credential ids, or account profile names.
