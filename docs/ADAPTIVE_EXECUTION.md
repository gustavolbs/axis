# Adaptive Local Execution (v0.7)

The local executor is resource-aware by default:

```text
Claude plans / resolves ambiguity
        ↓
qwen2.5-coder:7b (fast attempt)
        ↓
validation / structured-output failure?
        ├─ no  → Claude review
        └─ yes → unload 7b, load qwen2.5-coder:14b
                     ↓
                 strong retry
                     ↓
                 validation
                     ↓
                 Claude review
```

## Why

The previous 14B-only default could create high unified-memory pressure on developer laptops. v0.7 keeps routine bounded implementation on the 7B model and pays the 14B resource cost only after the fast model proves insufficient.

## Resource guardrails

- Fast model default: `qwen2.5-coder:7b`.
- Strong retry model: `qwen2.5-coder:14b`.
- One Ollama inference at a time per local-coder MCP process.
- Before switching model tiers, the currently tracked model is explicitly unloaded through Ollama so 7B and 14B are not intentionally kept resident together.
- Default Ollama context window: `16384` tokens.
- Default local executor source-context cap: `96000` bytes (down from 600000).
- Fast model keep-alive: `90s`.
- Strong model keep-alive: `30s`.
- Invalid structured output is treated as a retryable local failure, allowing the strong model to rescue the task instead of immediately sending implementation back to Claude.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_CODER_ADAPTIVE_MODELS` | `true` | Enable fast-first / strong-retry execution |
| `LOCAL_CODER_FAST_MODEL` | `qwen2.5-coder:7b` | Default executor |
| `LOCAL_CODER_STRONG_MODEL` | `qwen2.5-coder:14b` | Retry/escalation executor |
| `LOCAL_CODER_NUM_CTX` | `16384` | Ollama `num_ctx` request option |
| `LOCAL_CODER_MAX_CONTEXT_BYTES` | `96000` | Maximum source bytes supplied to one local attempt |
| `LOCAL_CODER_FAST_KEEP_ALIVE` | `90s` | Fast-model residence after generation |
| `LOCAL_CODER_STRONG_KEEP_ALIVE` | `30s` | Strong-model residence after generation |

Legacy single-model mode remains available:

```bash
LOCAL_CODER_ADAPTIVE_MODELS=false \
LOCAL_CODER_MODEL=qwen2.5-coder:14b
```

## Install / update

Pull both candidate models once:

```bash
ollama pull qwen2.5-coder:7b
ollama pull qwen2.5-coder:14b
```

Then update the MCP and user-scoped Claude registration:

```bash
git switch main
git pull
npm install --no-package-lock
npm run check
npm run build
npm run install:claude
npm run install:routing
npm run install:claude-token-saver
```

Fully quit and reopen Claude Code Desktop afterward.

`local_coder_health` reports availability for both fast and strong models plus the configured context ceiling.

## Telemetry

v0.7 appends an `inference` event for every successful Ollama generation. `local_coder_telemetry` uses those exact events for new runs and reports `localInference.byModel`, allowing comparison of 7B vs 14B calls, tokens, and generation duration.

Older telemetry remains readable; when no v0.7 inference events exist in the selected window, the summary falls back to the previous aggregate execution records.
