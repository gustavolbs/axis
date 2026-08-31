import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const script = fs.readFileSync('scripts/smoke-cloud-providers.mjs', 'utf8');
const workflow = fs.readFileSync('.github/workflows/cloud-smoke.yml', 'utf8');

test('live smoke requires explicit paid model ids instead of auto-selecting discovered models', () => {
  assert.match(script, /LOCAL_CODER_SMOKE_ANTHROPIC_MODEL/);
  assert.match(script, /LOCAL_CODER_SMOKE_OPENAI_MODEL/);
  assert.match(script, /was not returned by live model discovery/);
  assert.doesNotMatch(script, /models\[0\]/);
});

test('live smoke proves direct cloud routing without registering Ollama', () => {
  assert.match(script, /new ProviderRegistry\(\[provider\]\)/);
  assert.match(script, /providerKind: 'cloud'/);
  assert.match(script, /fallbackUsed === false/);
  assert.doesNotMatch(script, /OllamaInferenceProvider/);
});

test('normal pull request CI does not invoke paid cloud smoke', () => {
  const normalCi = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.doesNotMatch(normalCi, /smoke-cloud-providers/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /secrets\.ANTHROPIC_API_KEY/);
  assert.match(workflow, /secrets\.OPENAI_API_KEY/);
});

test('smoke output contains usage metadata and never prints key variables', () => {
  assert.match(script, /usageSummary/);
  assert.doesNotMatch(script, /console\.log\([^\n]*(?:apiKey|API_KEY)/);
});
