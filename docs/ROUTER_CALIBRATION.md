# Router history and calibration

Local Coder's Cognitive Router uses deterministic host-side scoring. It does not call an LLM to decide which LLM should receive a stage.

This document describes the persistent signals that replace cold-start assumptions as a Project accumulates real executions.

## What is persisted

`RoutingHistoryStore` records one compact event for each provider attempt that actually performs inference I/O:

- Project ID and organization ID;
- inference stage;
- provider ID, provider kind and model ID;
- success or error outcome;
- wall-clock attempt latency;
- whether the attempt was a fallback;
- coarse failure class: retryable, rate-limited or fatal.

It deliberately does **not** persist system prompts, user prompts, model output, hidden reasoning, API keys, raw error bodies or repository content.

Admission denials are policy outcomes rather than provider reliability evidence, so they are not recorded. User cancellation is also excluded: cancelling a job must not make a healthy provider look unreliable.

## Isolation and storage

The default root is:

```text
~/.local-coder-mcp/routing-history/
```

Each Project is stored under the SHA-256 `projectIsolationKey(organizationId, projectId)`. Events include both identifiers and are rejected on read if the payload does not match the requested isolation scope.

Directories are created with mode `0700` and event files with mode `0600` where the platform supports POSIX permissions. Writes are atomic per event.

`LOCAL_CODER_ROUTING_HISTORY_PATH` can override the root for tests or managed installations.

## Sampling policy

Defaults:

- history window: 30 days;
- retained observations per stage/provider/model: 100;
- minimum observations before success rate is exposed: 3;
- minimum successful observations before p50 latency is exposed: 3.

Before those thresholds are reached, routing remains on deterministic cold-start behavior. This prevents one unusually fast, slow or failed call from swinging Auto routing.

Latency p50 is computed only from successful provider attempts. Success rate uses all actual provider attempts in the retained window.

## Relationship to quality

Provider reliability is not the same as engineering quality. A successful HTTP/model response is not evidence that a code change was correct.

The routing-history store therefore persists reliability and latency, not a fabricated quality score. Model `qualityScore` remains an explicit/eval-driven signal. Comparative task evals are the appropriate source for future quality calibration because they can observe validation, review and final quality-gate outcomes.

## Relationship to cost and usage

`UsageLedger` remains the source of token/cost accounting and budget settlement. Routing history is separate because the usage ledger records successful settled inference and cannot, by itself, provide an unbiased provider failure rate.

If another `RoutingMetricsSource` is configured, its defined fields take precedence while missing fields fall back to routing history. This preserves external queue/cost estimators without discarding learned reliability and latency.

## Execution semantics

The router history observer is best-effort telemetry:

- a history write failure never changes the provider result;
- it never changes budget settlement;
- it never causes or prevents fallback;
- it never turns cancellation into a provider failure.

Strict Local-only Projects keep their legacy Ollama execution path, but successful/failed local calls still feed the same isolated history so later policy changes can start with real local latency/reliability data.
