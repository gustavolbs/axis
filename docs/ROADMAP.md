# Local Coder roadmap

Status baseline: 2026-08-31.

## Completed runtime foundation

- [x] Provider-neutral `InferenceProvider` boundary.
- [x] Ollama, Anthropic and OpenAI provider adapters using current provider APIs.
- [x] Model discovery instead of hardcoded cloud model enums.
- [x] macOS Keychain-backed cloud credentials plus environment-backed headless credentials.
- [x] Project definitions with organization/workspace isolation, provider allowlists, privacy policy and concurrency policy.
- [x] Deterministic, explainable Cognitive Router with `auto`, `local-first`, `balanced`, `speed-first`, `deep` and `frontier-only` policies.
- [x] Explicit model selection with no silent replacement.
- [x] Direct-to-cloud routing without a mandatory Qwen pre-pass.
- [x] Project-aware Agent Runtime hosted by the Mac control plane.
- [x] Windows Worker exposed as local inference compute while cloud providers run directly from the Mac.
- [x] Strict Local-only compatibility path preserving legacy Ollama behavior.
- [x] Persistent pricing/usage ledger and per-job/daily/monthly budget admission.
- [x] Concurrent budget reservations and deterministic settlement by inference attempt.
- [x] Local fallback when an Auto cloud attempt is denied by budget, while explicit cloud selection remains fail-closed.
- [x] Operational Project administration API restricted to loopback clients.
- [x] Standalone Console surfaces for Agent, Projects and Runs.
- [x] Project/provider/model/credential/pricing/budget administration UI.
- [x] Project run inspector with routing trace, fallback evidence, usage and budget snapshots.

## Product-completion sequence

These are the remaining items required to complete the current Local Coder standalone product direction.

### 1. macOS desktop shell

- [ ] Package the existing standalone control plane and React UI as `Local Coder.app`.
- [ ] Keep the renderer sandboxed: no Node integration, context isolation on, navigation/window creation restricted.
- [ ] Start/stop the local control-plane process with the app lifecycle.
- [ ] Detect startup failure/port collision and present a recoverable error state.
- [ ] Produce unsigned local `.app`/DMG artifacts in CI; signing/notarization stays configuration-driven so credentials are never committed.
- [ ] Preserve `npm run console` as a headless/browser-accessible fallback.

### 2. Active-run cancellation

- [ ] Add a cancellable job state and persisted cancellation event.
- [ ] Propagate `AbortSignal` through Project Agent calls, routed provider inference and local/remote worker requests.
- [ ] Release active budget reservations on cancellation.
- [ ] Stop starting new implementation/validation/repair work once cancellation is observed.
- [ ] Add cancellation actions to standalone Agent/Runs surfaces.

### 3. Real provider smoke/e2e validation

- [ ] Add opt-in smoke scripts for Anthropic and OpenAI that require credentials from the existing credential system/environment.
- [ ] Validate model discovery, structured output, usage normalization and `store:false`/non-persistence assumptions without committing credentials.
- [ ] Add a Project-level cloud-routing smoke path proving direct cloud execution without Ollama dependency.
- [ ] Keep cloud smoke tests disabled in normal public CI unless explicit secrets are configured.

### 4. Router calibration and comparative evals

- [ ] Persist provider/stage latency, success and quality observations in a routing-history store.
- [ ] Feed sufficiently sampled history into routing candidates instead of cold-start priors.
- [ ] Extend eval harness to compare local Qwen, configured Anthropic models, configured OpenAI models and Auto Router.
- [ ] Report task success, quality, elapsed time, provider/model calls, fallbacks, token usage and known cost.
- [ ] Keep cold-start behavior deterministic when history is absent or below minimum sample count.

### 5. Documentation and release hardening

- [ ] Document desktop installation, first-run provider setup and Project isolation semantics.
- [ ] Add macOS packaging CI and artifact smoke validation.
- [ ] Add a release checklist for signing/notarization, migration compatibility and credential safety.

## Post-MVP candidates

These are intentionally not prerequisites for the standalone multi-provider product.

- [ ] Repo Impact Graph / hybrid code GraphRAG.
- [ ] Multi-worker scheduling beyond the current local compute topology.
- [ ] Stale mirror/index/run retention and garbage collection.
- [ ] Dependency/template worktree cache optimization.
- [ ] Automatic update channel and signed release delivery.
