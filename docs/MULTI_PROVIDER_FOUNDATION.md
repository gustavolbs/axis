# Multi-provider foundation

This document records the provider boundary introduced before routing, credentials, budgets, and the standalone desktop shell are enabled.

## Design boundary

`InferenceProvider` is deliberately narrower than the engineering agent runtime.

Providers own only model-compute concerns:

- model discovery;
- provider health;
- inference transport;
- structured-output translation;
- reasoning-control translation;
- streaming operational signals;
- normalized usage metadata.

Providers do **not** own:

- repository/workspace access;
- Repo Intelligence or regression memory;
- context retrieval/evidence selection;
- planning/DAG semantics;
- file mutation;
- deterministic validation;
- review/repair policy;
- project privacy rules;
- budgets/pricing;
- routing.

Those remain runtime responsibilities so Ollama, Anthropic, OpenAI, and future providers consume the same evidence contracts.

## Compatibility rule

The existing Ollama/Qwen execution path and Windows Worker protocol remain unchanged in this foundation PR. `OllamaInferenceProvider` adapts the existing client to the new contract rather than replacing it.

Cloud providers are optional. Merely upgrading Local Coder does not require an Anthropic or OpenAI key and does not change the current `local_engineer` route.

## Secret handling in this layer

Provider constructors accept credentials from the caller but never persist them. HTTP failures are sanitized before they become `ProviderError` messages. New cloud credentials must not be written to `control-plane.json`; durable storage is intentionally deferred to the secure-credentials milestone (macOS Keychain plus a headless secret source).

OpenAI Responses requests explicitly use `store: false` in this foundation.

## Usage normalization

`InferenceUsage.inputTokens` means total model input tokens represented by the provider response. Cache reads/writes are also exposed separately when the API provides them so the later pricing engine can apply the correct rates.

- Anthropic reports uncached input, cache creation, and cache reads as separate counters. The adapter sums those fields for normalized total input while retaining each cache counter.
- OpenAI reports `input_tokens` plus cache details. The adapter preserves the API total and the detailed cached/cache-write counters.
- Reasoning/thinking token counts are recorded only when the provider exposes a numeric usage counter. Hidden reasoning text is never copied into progress events.

## Official API contracts checked on 2026-08-31

### Anthropic

Implementation is based on the first-party Claude API documentation:

- Models API — `GET /v1/models`, model capabilities and pagination: https://platform.claude.com/docs/en/api/models/list
- Messages API — `POST /v1/messages`, authentication, streaming and usage: https://platform.claude.com/docs/en/api/messages/create
- Structured outputs — `output_config.format` with `type: "json_schema"`: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Thinking controls — adaptive thinking for newer models, capability-dependent manual thinking for older supported models: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Prompt-cache usage counters: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Pricing reference (not yet used for calculation in this PR): https://platform.claude.com/docs/en/about-claude/pricing
- Rate limits (consumed later by retry/router policy): https://platform.claude.com/docs/en/api/rate-limits

The adapter uses model capability metadata returned by the Models API instead of deriving Anthropic feature support from hardcoded model-name regexes.

### OpenAI

Implementation is based on the first-party OpenAI developer documentation:

- Responses API — `POST /v1/responses`, structured text configuration, reasoning and usage: https://developers.openai.com/api/reference/cli/resources/responses/methods/create
- Models API — `GET /v1/models`: https://developers.openai.com/api/reference/cli/resources/models
- Current model catalog: https://developers.openai.com/api/docs/models/all
- Current model guidance, reasoning and prompt caching: https://developers.openai.com/api/docs/guides/latest-model

The provider does not encode the current GPT family as a TypeScript enum. Availability comes from model discovery; future routing/catalog policy may annotate discovered models with Local Coder-specific suitability data.

## Streaming privacy

Provider progress is intentionally operational only:

- waiting for first response;
- reasoning signal observed;
- generating output;
- event count;
- generated output character count.

Thinking/reasoning text is not included in `ProviderProgress`. Final answer text remains the provider result, while safe runtime-authored reasoning summaries stay a responsibility of the agent runtime.

## Next milestones

1. Secure credentials and isolated Project configuration.
2. Per-stage Cognitive Router and compute/workspace scheduling.
3. Usage ledger, pricing catalog, estimates, budgets, and fallback gates.
4. Standalone desktop shell and chat-first UI.

Repo Impact Graph / GraphRAG remains explicitly outside this sequence.
