#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const execute = args.includes('--execute');
const file = path.resolve(valueAfter('--file', 'eval/local-agent-cases.json'));
const output = path.resolve(
  valueAfter('--out', `eval/results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
);
const baselinePath = valueAfter('--baseline', '');

async function loadCases() {
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Eval file must contain a JSON array.');
  return parsed;
}

function evaluate(caseDef, result, elapsedMs) {
  const expected = caseDef.expected ?? {};
  const changed = new Set(result.changedFiles ?? []);
  const mustChange = expected.mustChangeFiles ?? [];
  const mustNotChange = expected.mustNotChangeFiles ?? [];
  const validations = result.validation ?? [];
  const quality = result.quality?.score ?? null;
  const checks = {
    status: !expected.status || result.status === expected.status,
    mustChange: mustChange.every((item) => changed.has(item)),
    mustNotChange: mustNotChange.every((item) => !changed.has(item)),
    validation: expected.requireValidation === false || validations.length > 0 && validations.every((item) => item.ok),
    quality: expected.minQuality === undefined || quality !== null && quality >= expected.minQuality
  };
  const passed = Object.values(checks).every(Boolean);
  const modelCalls = result.modelCalls ?? [];
  return {
    id: caseDef.id,
    category: caseDef.category,
    passed,
    checks,
    elapsedMs,
    status: result.status,
    quality,
    changedFiles: result.changedFiles ?? [],
    repairRounds: result.repairRounds ?? 0,
    promptTokens: modelCalls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0),
    completionTokens: modelCalls.reduce((sum, call) => sum + (call.completionTokens ?? 0), 0),
    validationChecks: validations.length,
    decisionRequired: Boolean(result.decisionRequest),
    escalationKind: result.escalation?.kind ?? null
  };
}

function summarize(results) {
  const passed = results.filter((item) => item.passed).length;
  const avg = (key) => results.length
    ? results.reduce((sum, item) => sum + (Number(item[key]) || 0), 0) / results.length
    : 0;
  const byCategory = Object.fromEntries(
    [...new Set(results.map((item) => item.category ?? 'uncategorized'))].map((category) => {
      const items = results.filter((item) => (item.category ?? 'uncategorized') === category);
      return [category, {
        cases: items.length,
        passed: items.filter((item) => item.passed).length,
        successRate: items.length ? items.filter((item) => item.passed).length / items.length : 0
      }];
    })
  );
  return {
    cases: results.length,
    passed,
    successRate: results.length ? passed / results.length : 0,
    avgElapsedMs: avg('elapsedMs'),
    avgQuality: avg('quality'),
    avgPromptTokens: avg('promptTokens'),
    avgCompletionTokens: avg('completionTokens'),
    byCategory
  };
}

function compare(summary, baseline) {
  if (!baseline?.summary) return undefined;
  return {
    successRateDelta: summary.successRate - baseline.summary.successRate,
    avgQualityDelta: summary.avgQuality - baseline.summary.avgQuality,
    avgElapsedMsDelta: summary.avgElapsedMs - baseline.summary.avgElapsedMs,
    avgCompletionTokensDelta: summary.avgCompletionTokens - baseline.summary.avgCompletionTokens
  };
}

const cases = await loadCases();
if (!execute) {
  console.log(`Loaded ${cases.length} Local Coder eval cases from ${file}.`);
  console.log('Dry run only. Add --execute to run them against the configured local/remote worker.');
  for (const item of cases) console.log(`- ${item.id} [${item.category ?? 'uncategorized'}] ${item.goal}`);
  process.exit(0);
}

const [{ loadConfig }, { OllamaClient }, { createExecutionRuntime }] = await Promise.all([
  import('../dist/config.js'),
  import('../dist/ollama.js'),
  import('../dist/execution-runtime.js')
]);
const config = loadConfig();
const runtime = createExecutionRuntime(config, new OllamaClient(config));
const results = [];

for (const caseDef of cases) {
  console.log(`\n[eval] ${caseDef.id}: ${caseDef.goal}`);
  const started = Date.now();
  try {
    const result = await runtime.execution.executeEngineer({
      workspace: caseDef.workspace,
      goal: caseDef.goal,
      context: caseDef.context,
      constraints: caseDef.constraints,
      language: caseDef.language,
      maxRepairRounds: caseDef.maxRepairRounds ?? 1
    });
    const evaluated = evaluate(caseDef, result, Date.now() - started);
    results.push(evaluated);
    console.log(`${evaluated.passed ? 'PASS' : 'FAIL'} quality=${evaluated.quality ?? 'n/a'} time=${Math.round(evaluated.elapsedMs / 1000)}s`);
  } catch (error) {
    results.push({
      id: caseDef.id,
      category: caseDef.category,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started
    });
    console.log(`ERROR ${results.at(-1).error}`);
  }
}

const summary = summarize(results);
let baseline;
if (baselinePath) {
  baseline = JSON.parse(await fs.readFile(path.resolve(baselinePath), 'utf8'));
}
const report = {
  generatedAt: new Date().toISOString(),
  model: config.model,
  strongModel: config.strongModel,
  cognitiveMode: config.cognitiveMode,
  executionMode: config.executionMode,
  source: file,
  summary,
  comparison: compare(summary, baseline),
  results
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2), 'utf8');
console.log(`\nSuccess rate ${(summary.successRate * 100).toFixed(1)}% · avg quality ${summary.avgQuality.toFixed(1)} · report ${output}`);
if (report.comparison) console.log('Baseline delta:', report.comparison);
process.exit(summary.successRate === 1 ? 0 : 2);
