import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { classifyTask } from '../dist/classifier.js';
import { loadConfig } from '../dist/config.js';
import { executeAgenticCodeTask } from '../dist/executor.js';
import { OllamaClient } from '../dist/ollama.js';
import { readWorkspaceFile, resolveWorkspace, restoreWorkspaceFile } from '../dist/workspace.js';

const manifestPathArg = process.argv[2];

if (!manifestPathArg) {
  console.error('Usage: npm run benchmark -- /absolute/or/relative/benchmark-manifest.json');
  process.exit(1);
}

const manifestPath = path.resolve(manifestPathArg);
const raw = await fs.readFile(manifestPath, 'utf8');
const manifest = JSON.parse(raw);

if (!manifest || !Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
  throw new Error('Benchmark manifest must contain a non-empty tasks array.');
}

const config = loadConfig();
const ollama = new OllamaClient(config);
const health = await ollama.health();

if (!health.modelAvailable) {
  throw new Error(`Configured model is not installed in Ollama: ${config.model}`);
}

const results = [];

for (const [index, task] of manifest.tasks.entries()) {
  if (!task.id || !task.workspace || !task.task || !Array.isArray(task.editableFiles)) {
    throw new Error(`Benchmark task at index ${index} is missing id/workspace/task/editableFiles.`);
  }

  const workspace = await resolveWorkspace(path.resolve(task.workspace));
  const snapshots = [];
  for (const file of task.editableFiles) {
    snapshots.push(await readWorkspaceFile(workspace, file, config.maxFileBytes));
  }

  const classification = classifyTask({
    task: task.task,
    solutionKnown: task.solutionKnown ?? true,
    requiresDiscovery: task.requiresDiscovery ?? false,
    requiresArchitecture: task.requiresArchitecture ?? false,
    estimatedFiles: task.editableFiles.length,
    validationKnown: Array.isArray(task.validation) && task.validation.length > 0,
    riskTags: task.riskTags
  });

  const startedAt = Date.now();
  let execution;
  let error;

  try {
    execution = await executeAgenticCodeTask(ollama, config, {
      workspace,
      task: task.task,
      editableFiles: task.editableFiles,
      contextFiles: task.contextFiles,
      context: task.context,
      constraints: task.constraints,
      language: task.language,
      validation: task.validation,
      maxAttempts: task.maxAttempts ?? 2,
      rollbackOnFailure: true
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    for (const snapshot of snapshots) {
      await restoreWorkspaceFile(workspace, snapshot);
    }
  }

  const generations = execution?.generations ?? [];
  const promptTokens = generations.reduce((sum, generation) => sum + (generation.promptTokens ?? 0), 0);
  const completionTokens = generations.reduce((sum, generation) => sum + (generation.completionTokens ?? 0), 0);
  const generationDurationMs = generations.reduce(
    (sum, generation) => sum + (generation.totalDurationNs ? generation.totalDurationNs / 1_000_000 : 0),
    0
  );
  const validationDurationMs = (execution?.validation ?? []).reduce(
    (sum, validation) => sum + validation.durationMs,
    0
  );

  const result = {
    id: task.id,
    classification,
    status: execution?.status ?? 'error',
    attempts: execution?.attempts ?? 0,
    changedFiles: execution?.changedFiles ?? [],
    validationPassed: execution ? execution.validation.every((validation) => validation.ok) : false,
    wallDurationMs: Date.now() - startedAt,
    generationDurationMs,
    validationDurationMs,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    error
  };
  results.push(result);
  console.log(`${result.status === 'success' ? 'PASS' : 'FAIL'} ${task.id} (${result.wallDurationMs}ms, ${result.totalTokens} tokens)`);
}

const successful = results.filter((result) => result.status === 'success').length;
const promptTokens = results.reduce((sum, result) => sum + result.promptTokens, 0);
const completionTokens = results.reduce((sum, result) => sum + result.completionTokens, 0);
const report = {
  name: manifest.name ?? path.basename(manifestPath),
  model: config.model,
  createdAt: new Date().toISOString(),
  tasks: results.length,
  successful,
  successRate: successful / results.length,
  totalPromptTokens: promptTokens,
  totalCompletionTokens: completionTokens,
  totalTokens: promptTokens + completionTokens,
  averageWallDurationMs:
    results.reduce((sum, result) => sum + result.wallDurationMs, 0) / results.length,
  averageAttempts: results.reduce((sum, result) => sum + result.attempts, 0) / results.length,
  results
};

const resultsDirectory = path.resolve('benchmarks', 'results');
await fs.mkdir(resultsDirectory, { recursive: true });
const safeModel = config.model.replace(/[^a-zA-Z0-9_.-]+/g, '-');
const timestamp = new Date().toISOString().replaceAll(':', '-');
const reportPath = path.join(resultsDirectory, `${timestamp}-${safeModel}.json`);
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`\nSuccess rate: ${(report.successRate * 100).toFixed(1)}% (${successful}/${results.length})`);
console.log(`Total local tokens: ${report.totalTokens}`);
console.log(`Average wall duration: ${report.averageWallDurationMs.toFixed(0)}ms`);
console.log(`Report: ${reportPath}`);
