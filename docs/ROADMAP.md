# Local Coder roadmap

Status baseline: 2026-09-01.

## Completed runtime foundation

- [x] Provider-neutral `InferenceProvider` boundary.
- [x] Ollama, Anthropic and OpenAI provider adapters using current provider APIs.
- [x] Model discovery instead of hardcoded cloud model enums.
- [x] macOS Keychain-backed cloud credentials plus environment-backed credentials where supported.
- [x] Project definitions with organization/workspace isolation, provider allowlists, privacy policy and concurrency policy.
- [x] Deterministic, explainable Cognitive Router with `auto`, `local-first`, `balanced`, `speed-first`, `deep` and `frontier-only` policies.
- [x] Explicit model selection with no silent replacement.
- [x] Direct-to-cloud routing without a mandatory Qwen pre-pass.
- [x] Project-aware Agent Runtime owned by the standalone Mac application.
- [x] Optional authenticated Windows worker exposed as local inference compute.
- [x] Strict local-only path preserving Ollama behavior.
- [x] Persistent pricing/usage ledger and per-job/daily/monthly budget admission.
- [x] Concurrent budget reservations and deterministic settlement by inference attempt.
- [x] Local fallback when an Auto cloud attempt is denied by budget, while explicit cloud selection remains fail-closed.
- [x] In-process `DesktopAppRuntime` behind an isolated Electron preload IPC bridge.
- [x] Standalone Agent, Chats, Projects, Runs and Settings surfaces.
- [x] Project/provider/model/credential/pricing/budget administration inside the app.
- [x] Run inspector with routing trace, fallback evidence, usage and budget snapshots.
- [x] Persistent Repo Intelligence, regression memory and cumulative regression ledger.
- [x] Investigation, planning, implementation DAG, deterministic validation, adversarial review, bounded repair and quality gate.
- [x] Optional direct research through configured infrastructure without MCP transports.

## Standalone desktop completion

The current product direction is one standalone macOS application. Claude Desktop/Claude Code is not a Local Coder host, and no browser console, dashboard service, MCP server or localhost control-plane process is part of the shipped product.

### 1. macOS desktop shell

- [x] Package the Agent Runtime and React UI as `Local Coder.app`.
- [x] Keep the renderer sandboxed: no Node integration, context isolation on, navigation/window creation restricted.
- [x] Run `DesktopAppRuntime` in the Electron main process rather than spawning a localhost server.
- [x] Route renderer requests/events through the narrow preload IPC bridge.
- [x] Add native folder selection, native theme synchronization, login-item settings and application-menu shortcuts.
- [x] Handle macOS traffic lights, collapsed-sidebar layout, minimum window size and persisted window bounds.
- [x] Avoid white boot flash and surface startup/render failures instead of leaving an invisible window.
- [x] Open safe external HTTPS links in the system browser.
- [x] Produce unsigned local `.app`/DMG artifacts in CI; signing/notarization remains configuration-driven so credentials are never committed.

### 2. Desktop UX audit v2

- [x] Text-driven send affordance with actionable provider/runtime errors.
- [x] Native Electron directory picker plus browser-compatible validation/recent-folder fallback in reusable folder fields.
- [x] Accessible collapsed rail with ARIA labels, tooltips and persistent profile/footer placement.
- [x] Sidebar resizer without horizontal overflow and automatic narrow-window collapse.
- [x] Vertically centered empty state outside the macOS title-bar area.
- [x] Composer-level focus ring and textarea autogrow.
- [x] Distinct hover/active/focus states and consistent primary/secondary button hierarchy.
- [x] Settings reduced to real General, Appearance, Model routing and API keys surfaces; legacy Advanced view removed.
- [x] Native `System` theme synchronization and corrected System preview.
- [x] Runs redesigned as an operational table/list.
- [x] Error toast auto-dismiss/actions plus persistent runtime connectivity status.
- [x] Native keyboard shortcuts and external-link handling.
- [ ] Consolidate historical UI class prefixes into one `lc-*` namespace. This is internal stylesheet debt only; it does not expose a Claude/MCP product integration.

### 3. Active-run cancellation

- [x] Add a cancellable job state and persisted cancellation event.
- [x] Propagate cancellation through Project Agent calls, routed provider inference, Ollama and local/remote worker requests.
- [x] Release active budget reservations on cancellation.
- [x] Stop starting new implementation/validation/repair work once cancellation is observed.
- [x] Add cancellation actions to Agent/Runs surfaces.

### 4. Real provider smoke/e2e validation

- [x] Add opt-in smoke scripts for Anthropic and OpenAI requiring explicit provider credentials and model IDs.
- [x] Validate model discovery, structured output and usage normalization without committing credentials.
- [x] Add a Project-level cloud-routing smoke path proving direct cloud execution without Ollama dependency.
- [x] Keep cloud smoke tests disabled in normal public CI; the live workflow is manual and fails closed when secrets/model IDs are absent.
- [x] Keep OpenAI `store:false` covered as a transport-contract assertion without claiming unverifiable server-side retention behavior.

### 5. Router calibration and comparative evals

- [x] Persist isolated provider/stage attempt latency and reliability observations without prompts or model output.
- [x] Feed sufficiently sampled history into routing candidates instead of latency/reliability cold-start assumptions.
- [x] Keep cold-start behavior deterministic when history is absent or below minimum sample count.
- [x] Extend eval harness to compare local Qwen, configured Anthropic models, configured OpenAI models and Auto Router.
- [x] Report task success, quality, elapsed time, provider/model calls, fallbacks, token usage and known cost.
- [x] Feed task-level eval evidence into explicit model quality profiles rather than treating transport success as engineering quality.

### 6. Documentation and release hardening

- [x] Document standalone desktop installation, first-run provider setup and Project isolation semantics.
- [x] Remove Claude/MCP routing/install instructions and browser/control-plane setup from active product documentation.
- [x] Use `~/.local-coder/settings.json` as the standalone settings source instead of shared `control-plane.json` state.
- [x] Add macOS packaging CI and artifact smoke validation.
- [x] Add a separate manual Developer ID + notarization release workflow that fails closed when credentials are absent.
- [x] Verify release artifacts with `codesign`, stapler and Gatekeeper, including the app copied inside the generated DMG.
- [x] Add a release checklist for signing/notarization and credential safety.

## External operational gates

These are not missing implementation; they require credentials or deliberate release inputs that are not committed to the repository.

- [ ] Execute live Anthropic/OpenAI smoke tests with real provider credentials and explicit current model IDs.
- [ ] Run the comparative eval suite on representative real repositories with the intended production provider/model set.
- [ ] Configure Apple Developer signing/notarization secrets and produce the first verified signed distribution artifact.
- [ ] Choose and bump the public release version/tag deliberately before distribution.

## Post-MVP candidates

- [ ] Repo Impact Graph / hybrid code GraphRAG.
- [ ] Multi-worker scheduling beyond the current local compute topology.
- [ ] Stale mirror/index/run retention and garbage collection.
- [ ] Dependency/template worktree cache optimization.
- [ ] Automatic update channel and signed release delivery beyond the current manual verified workflow.
