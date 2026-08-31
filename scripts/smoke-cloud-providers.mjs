#!/usr/bin/env node

import { AnthropicInferenceProvider } from '../dist/providers/anthropic-provider.js';
import { OpenAIInferenceProvider } from '../dist/providers/openai-provider.js';
import { ProviderRegistry } from '../dist/providers/registry.js';
import { RoutedInferenceRuntime } from '../dist/routed-inference.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'provider'],
  properties: {
    ok: { type: 'boolean' },
    provider: { type: 'string' }
  }
};

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function providersRequested() {
  const raw = arg('provider') ?? process.env.LOCAL_CODER_SMOKE_PROVIDER ?? 'all';
  if (!['all', 'anthropic', 'openai'].includes(raw)) {
    throw new Error('--provider must be all, anthropic, or openai.');
  }
  return raw === 'all' ? ['anthropic', 'openai'] : [raw];
}

function usageSummary(usage) {
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? null,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    totalTokens: usage.totalTokens ?? null
  };
}

function assertUsage(result) {
  const numeric = Object.values(usageSummary(result.usage)).filter((value) => value !== null);
  if (numeric.length === 0 || numeric.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`${result.providerId}/${result.model} returned invalid or empty usage counters.`);
  }
}

async function smoke({ id, provider, modelId }) {
  const models = await provider.listModels();
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`${id} smoke model ${modelId} was not returned by live model discovery.`);
  }
  if (model.capabilities?.structuredOutput !== true) {
    throw new Error(`${id} smoke model ${modelId} does not advertise structured-output support.`);
  }

  const health = await provider.health();
  if (!health.ok) throw new Error(`${id} provider health failed: ${health.message ?? 'unknown error'}`);

  // The routed call intentionally registers only this cloud provider. If it succeeds,
  // direct cloud execution has been proven without Ollama/Qwen availability or pre-pass.
  const runtime = new RoutedInferenceRuntime(new ProviderRegistry([provider]));
  const result = await runtime.invoke({
    inference: {
      systemPrompt: 'You are a connectivity smoke test. Return only the requested JSON object.',
      userPrompt: `Return {"ok":true,"provider":"${id}"}.`,
      stage: 'planning',
      output: { type: 'json_schema', schema, name: 'local_coder_smoke', strict: true },
      maxOutputTokens: 80,
      timeoutMs: 90_000
    },
    routing: {
      project: {
        id: `smoke-${id}`,
        defaultRoutingPolicy: 'speed-first',
        defaultModel: { mode: 'explicit', providerId: id, modelId },
        privacy: { cloudAllowed: true, allowedProviderIds: [id] }
      },
      stage: 'planning',
      modelSelection: { mode: 'explicit', providerId: id, modelId },
      requireStructuredOutput: true,
      candidates: [{
        providerId: id,
        modelId,
        providerKind: 'cloud',
        available: true,
        capabilities: model.capabilities,
        queueDelayMs: 0
      }]
    }
  });

  const parsed = JSON.parse(result.result.content);
  if (parsed?.ok !== true || parsed?.provider !== id) {
    throw new Error(`${id} structured smoke response did not match the requested schema/value.`);
  }
  assertUsage(result.result);
  if (result.attempts.length !== 1 || result.attempts[0]?.status !== 'success') {
    throw new Error(`${id} direct routed smoke unexpectedly used fallback/multiple attempts.`);
  }

  return {
    provider: id,
    model: result.result.model,
    discoveredModels: models.length,
    latencyMs: result.result.latencyMs,
    usage: usageSummary(result.result.usage),
    directCloud: result.routing.selected.providerKind === 'cloud' && result.fallbackUsed === false
  };
}

const configs = {
  anthropic: () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const modelId = arg('anthropic-model') ?? process.env.LOCAL_CODER_SMOKE_ANTHROPIC_MODEL;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for Anthropic smoke.');
    if (!modelId) throw new Error('LOCAL_CODER_SMOKE_ANTHROPIC_MODEL or --anthropic-model is required for paid Anthropic smoke.');
    return { id: 'anthropic', modelId, provider: new AnthropicInferenceProvider({ apiKey }) };
  },
  openai: () => {
    const apiKey = process.env.OPENAI_API_KEY;
    const modelId = arg('openai-model') ?? process.env.LOCAL_CODER_SMOKE_OPENAI_MODEL;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for OpenAI smoke.');
    if (!modelId) throw new Error('LOCAL_CODER_SMOKE_OPENAI_MODEL or --openai-model is required for paid OpenAI smoke.');
    return { id: 'openai', modelId, provider: new OpenAIInferenceProvider({ apiKey }) };
  }
};

const output = [];
for (const id of providersRequested()) {
  output.push(await smoke(configs[id]()));
}

console.log(JSON.stringify({ ok: true, providers: output }, null, 2));
