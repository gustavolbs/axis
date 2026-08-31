# Live cloud provider smoke validation

Local Coder has deterministic provider unit tests in normal CI. This smoke harness is different: it performs a **real paid API call** against the configured Anthropic and/or OpenAI account.

It is opt-in and is never run by ordinary pull-request CI.

## What it proves

For each selected provider the harness:

1. calls the live model-discovery endpoint;
2. verifies the explicitly selected model is actually present;
3. requires positively advertised structured-output support;
4. checks provider health;
5. executes a tiny JSON-schema request through `RoutedInferenceRuntime` with **only the cloud provider registered**;
6. verifies the structured response and normalized usage counters;
7. verifies the route completed in one cloud attempt without fallback.

Because Ollama is not registered in the smoke runtime, a successful result proves the cloud path is independent of Qwen/Ollama and does not require a local pre-pass.

The OpenAI adapter used by this path sets `store: false`; that transport contract is also covered by deterministic provider tests. The remote service does not expose a response field that can independently prove its storage-side behavior, so the smoke harness does not claim otherwise.

## Local execution

Build first through the npm command and provide an exact discovered model ID. Local Coder intentionally does **not** auto-select a paid model for smoke tests.

Anthropic:

```bash
ANTHROPIC_API_KEY='...' \
LOCAL_CODER_SMOKE_ANTHROPIC_MODEL='<exact-model-id>' \
npm run smoke:cloud -- --provider anthropic
```

OpenAI:

```bash
OPENAI_API_KEY='...' \
LOCAL_CODER_SMOKE_OPENAI_MODEL='<exact-model-id>' \
npm run smoke:cloud -- --provider openai
```

Both:

```bash
ANTHROPIC_API_KEY='...' \
OPENAI_API_KEY='...' \
LOCAL_CODER_SMOKE_ANTHROPIC_MODEL='<exact-model-id>' \
LOCAL_CODER_SMOKE_OPENAI_MODEL='<exact-model-id>' \
npm run smoke:cloud -- --provider all
```

The harness prints provider/model identity, discovered model count, latency and normalized token usage. It never prints credentials.

## GitHub Actions

The manual **Cloud Provider Smoke** workflow requires repository Actions secrets:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`

Only the provider selected by the workflow input is invoked. Model IDs are explicit workflow inputs rather than repository secrets.

Missing secrets or model IDs fail the requested smoke instead of silently skipping it. This prevents a green manual run from being mistaken for a live provider validation when no paid request was actually made.
