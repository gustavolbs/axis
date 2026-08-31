# Multi-provider comparative evaluations

`npm run eval:providers` compares the same Local Coder Agent Runtime across local Qwen, Anthropic, OpenAI and Auto Router variants.

The harness is intentionally end-to-end: it runs the Project-aware engineer, planning/implementation/validation/review/quality pipeline and routing/budget instrumentation rather than benchmarking an isolated prompt.

## Safety model

Comparative runs must not let one model's code changes influence the next model.

For every case/variant pair the harness:

1. resolves the source workspace's Git root and HEAD;
2. requires the source repository to be clean;
3. creates a detached temporary `git worktree` at that exact HEAD;
4. runs Local Coder only inside the disposable worktree;
5. removes the worktree after the case.

The source repository is never reset, checked out or cleaned by the harness.

By default the worktree does **not** reuse the source repository's `node_modules`, because a validation/package script could mutate dependencies through a symlink. If a repository needs the already-installed dependency tree and you accept that tradeoff, enable it explicitly with `--reuse-node-modules`. The harness never installs dependencies into the source repository itself.

Project metadata, credential metadata, Usage Ledger and Routing History used by an eval run are also temporary. Cloud credentials remain environment-backed; API key values are never written to the eval state or report.

## Model configuration

Cloud model IDs are explicit and never hardcoded in the harness:

```bash
export LOCAL_CODER_EVAL_ANTHROPIC_MODEL='<model id returned by Anthropic discovery>'
export LOCAL_CODER_EVAL_OPENAI_MODEL='<model id returned by OpenAI discovery>'
export ANTHROPIC_API_KEY='...'
export OPENAI_API_KEY='...'
```

Local Qwen defaults to the configured Local Coder model, or can be pinned for comparison:

```bash
export LOCAL_CODER_EVAL_OLLAMA_MODEL='<ollama model id>'
```

Explicit Anthropic/OpenAI variants force the control-plane local-compute topology to an unused local mode and allowlist only the selected cloud provider. This proves the cloud run does not depend on a Windows Worker or an Ollama pre-pass. The Auto variant uses the normal Local Coder topology and every configured eval provider.

## Cases

The existing `eval/local-agent-cases.json` is an example matrix and contains placeholder workspaces. A dry run may inspect this file, but `--execute` fails closed until every selected case uses a real workspace.

For a real comparison, create a case file with real, **clean Git workspaces** and goals that are objectively assessable. Use the same cases for every variant. Categories can include small changes, debugging, large features, architecture, research and material-decision behavior.

## Dry run

Dry run performs no model inference and tolerates the example workspace placeholders:

```bash
npm run eval:providers
```

or:

```bash
npm run eval:providers -- --file /path/to/cases.json
```

It reports selected variants, configuration readiness and source-isolation settings.

## Execute

```bash
npm run eval:providers -- \
  --execute \
  --file /path/to/cases.json \
  --variants qwen,anthropic,openai,auto \
  --out ./eval/results/provider-comparison.json
```

If deterministic validation in the disposable worktree needs the source repository's existing dependency tree, explicitly opt in:

```bash
npm run eval:providers -- \
  --execute \
  --reuse-node-modules \
  --file /path/to/cases.json
```

The process exits with code `2` when one or more case expectations fail, and `1` for harness/configuration failures.

## Report

Each case/variant record contains:

- expected-case pass/fail;
- Local Coder result status and phase;
- final Quality Score/band when available;
- elapsed time;
- routing stage/provider/model trace;
- fallback attempts;
- prompt/completion token counts returned by providers;
- known cost and unknown-cost event count from Project budget accounting;
- changed-file count;
- deterministic validation outcomes.

Aggregate sections report pass/success rate, mean quality, mean elapsed time, tokens, known cost and fallback count per variant plus category-level results. The report also records whether source `node_modules` reuse was enabled.

Known cost uses the normal Local Coder `PricingStore`. If pricing is not configured for a cloud model, the report keeps that fact explicit through `unknownCostEvents` rather than inventing a price.

## Quality calibration

Transport success is not engineering quality. The harness derives model quality recommendations only from full successful Agent Runtime results with a final Quality Score, and requires at least three successful samples per explicit model.

By default these recommendations are written only to the eval report. To deliberately apply them to the normal provider model profiles:

```bash
npm run eval:providers -- \
  --execute \
  --file /path/to/cases.json \
  --apply-quality-profiles
```

That flag is intentionally explicit because it mutates persistent provider settings. Auto Router itself does not receive a synthetic quality score; its constituent models do.
