# P1.5 — Implementation checklist

This is the versioned implementation checklist for **P1.5 — Companies, accounts, profiles and isolation** in PR #75 (`feat/parity-milestone-1`).

It supplements the broader parity inventory in `CODEX_CLAUDE_DESKTOP_PARITY.md`. Each item below is an implementation gate: Axis does not advance to the next gate until implementation, tests, Electron/visual smoke when applicable, adversarial review and exact-head CI are green.

## Checklist

- [x] **1. Canonical Company model**
  - canonical `Company → connections/resources → Projects → sessions` graph
  - stable connection → Company bindings for legacy migration
  - workspace paths are filesystem locations, never identity
  - Ollama/local execution is a shared capability, never a fake Company
  - no secrets, MCP payloads or workspace paths are persisted in Company context

- [x] **2. Local Company lifecycle**
  - create, edit, archive, restore, search and explicit ordering
  - immutable generated Company IDs
  - persisted name, description, color and icon
  - strict validation and reserved Personal context
  - backward-compatible migration of legacy Company records
  - Projects select an existing canonical Company instead of inventing IDs from free text
  - archived Companies preserve existing references but cannot receive new Projects
  - no destructive Company DELETE endpoint

- [x] **3. Personal-context isolation**
  - Personal is an explicit isolated Company scope
  - corporate Projects, Accounts, API Keys, conversations and resources do not enter Personal implicitly
  - runtime/API tests cover cross-company access rejection and Personal fallbacks

- [x] **4. Always-visible Company scope**
  - Company selector is present in desktop chrome and composer
  - approval and result surfaces preserve/display the selected Company
  - Company changes are explicit and scoped runtime routes reject cross-company Projects/jobs
  - Electron visual smoke covers composer, approval and result states

- [x] **5. First-class Connection Center**
  - multiple Claude Accounts, ChatGPT/Codex Accounts and API Keys are distinct identities
  - every non-local connection has exactly one canonical Company owner
  - multiple API Keys from the same provider remain separate connection IDs
  - Account authentication remains provider-owned; OAuth credentials are never copied into Axis
  - API Keys remain Keychain-backed and renderer only receives metadata
  - provider-managed MCP restrictions are surfaced without pretending Axis can override them
  - Connectors are embedded as a first-class sub-surface without duplicate Settings chrome
  - ownership-sensitive IPC uses dedicated Connection Center channels

- [x] **6. Independent connection adapters**
  - Ollama, Claude Account, ChatGPT/Codex Account and API-Key paths work independently
  - API-Key connections support official or per-connection custom API endpoints
  - endpoint metadata is persisted separately from the secret
  - OpenAI/Anthropic adapters receive the selected endpoint without changing stable connection identity
  - isolated tests cover Ollama-only, Claude-only, Codex-only and API-Key-only scenarios
  - Electron smoke validates a custom-endpoint API Key as the only configured cloud identity

- [x] **7. Shared Account/API Key connection form**
  - one Add connection form owns Authentication, Company, identity id and Name
  - Account and API Key creation consume the same Company/id/name state
  - switching authentication preserves all base values
  - Endpoint/API key appear only for API authentication
  - static regression tests prevent the form from splitting into incompatible products
  - Electron smoke proves the same live form node and base values survive Claude Account → OpenAI API Key → Claude Account

- [x] **8. Full API Key connection lifecycle**
  - backend lifecycle service: details/edit/rotate/enable-disable/test/remove
  - per-connection endpoint + explicit safe-header allowlist
  - authentication/protocol headers cannot be overridden by custom headers
  - stable Company binding survives secret/config removal
  - sibling API Key isolation test coverage
  - dedicated Connection Center IPC handlers
  - preload + renderer TypeScript bridge
  - Connection Center management UI
  - real Electron smoke for Test/Edit/Rotate/Disable/Remove
  - exact-head Linux/Windows/macOS CI + adversarial final review

- [ ] **9. Company Hub navigation + global Work Hub**
  - move Companies out of Settings into a first-class app context surface
  - list Personal + Companies in the primary sidebar
  - selecting a Company opens a Company-scoped secondary sidebar, following the existing Work Hub rail pattern
  - Company sidebar sections: Overview, Projects, Connections, MCPs, Skills and Settings, with later Company-scoped resources added in the same model
  - every Company section is filtered by the canonical selected Company; no implicit cross-company inheritance
  - Company-specific Sources/connections are configured and administered inside their owning Company
  - **Work Hub remains global, first-class and unique**, aggregating Personal + every Company instead of creating one Work Hub per Company
  - Work Hub retains Inbox, My Work, Today, Calendar and Sources/aggregation views, with Company identity visible on every item
  - `All` is the default Work Hub scope; explicit Company/Personal filters narrow the same global surface
  - Work Hub data keeps canonical provenance/ownership dimensions — at minimum `companyId`, `connectionId` and `sourceId` — so aggregation never erases isolation
  - Work Hub `Sources` is an aggregation/visibility/health surface; source configuration remains with the owning Company
  - Company Overview may show a scoped summary and deep-link to the global Work Hub already filtered to that Company
  - global Axis Settings retains only app-wide settings; Company-specific settings move into the selected Company

## Latest completed gate

**Item 8** is complete at SHA `81f28f7f6b31f10c3f95cc0e731c20b277c0d0ec` / CI run **#685**:

- Linux `check`: success
- Windows full build/test + PowerShell worker guards: success
- macOS desktop contract: success
- real Electron lifecycle smoke: success for Test → Edit → Rotate → Test updated credentials/headers → Disable/Enable → Remove
- smoke verifies the API secret never appears in renderer fields and diagnostic request output omits Authorization
- sibling API Key remains present and usable after removing the managed connection
- unsigned Intel/Apple Silicon macOS packaging and artifact verification: success
- adversarial final review found no new secret exposure, ownership/isolation regression or runtime behavior change in the final smoke-correlation patch

## Current gate

**Item 9 is the only active P1.5 implementation gate.**

The approved product architecture is intentionally asymmetric:

- **Company Hub:** owns and configures resources belonging to one Company.
- **Work Hub:** one global operational surface that aggregates Personal + every Company while preserving ownership and provenance on every item.

There must not be a global Work Hub plus duplicated per-Company Work Hubs.
