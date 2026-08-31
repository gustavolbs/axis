#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    file: path.join(repoRoot, 'eval', 'local-agent-cases.json'),
    out: path.join(repoRoot, 'eval', 'results', `multi-provider-${Date.now()}.json`),
    variants: ['qwen', 'anthropic', 'openai', 'auto'],
    execute: false,
    applyQualityProfiles: false,
    reuseNodeModules: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--execute') args.execute = true;
    else if (value === '--apply-quality-profiles') args.applyQualityProfiles = true;
    else if (value === '--reuse-node-modules') args.reuseNodeModules = true;
    else if (value === '--file') args.file = path.resolve(argv[++index]);
    else if (value === '--out') args.out = path.resolve(argv[++index]);
    else if (value === '--variants') {
      args.variants = argv[++index].split(',').map((item) => item.trim()).filter(Boolean);
    } else if (value === '--help') {
      console.log('Usage: npm run eval:providers -- [--execute] [--variants qwen,anthropic,openai,auto] [--file cases.json] [--out report.json] [--reuse-node-modules] [--apply-quality-profiles]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  const allowed = new Set(['qwen', 'anthropic', 'openai', 'auto']);
  if (args.variants.length === 0 || args.variants.some((variant) => !allowed.has(variant))) {
    throw new Error('Variants must be a non-empty comma-separated subset of qwen,anthropic,openai,auto.');
  }
  if (args.applyQualityProfiles && !args.execute) {
    throw new Error('--apply-quality-profiles requires --execute.');
  }
  return args;
}

function readCases(file, { allowPlaceholders = false } = {}) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Eval case file must contain a non-empty array.');
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Case ${index} must be an object.`);
    if (typeof item.id !== 'string' || !item.id.trim()) throw new Error(`Case ${index} requires id.`);
    if (typeof item.category !== 'string' || !item.category.trim()) throw new Error(`Case ${item.id} requires category.`);
    if (typeof item.workspace !== 'string' || !item.workspace.trim()) throw new Error(`Case ${item.id} requires workspace.`);
    if (!allowPlaceholders && item.workspace.includes('REPLACE_WITH_REAL_WORKSPACE')) {
      throw new Error(`Case ${item.id} still uses REPLACE_WITH_REAL_WORKSPACE.`);
    }
    if (typeof item.goal !== 'string' || !item.goal.trim()) throw new Error(`Case ${item.id} requires goal.`);
    return item;
  });
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function inspectWorkspace(workspace) {
  const resolved = path.resolve(workspace);
  const gitRoot = runGit(resolved, ['rev-parse', '--show-toplevel']);
  const relative = path.relative(gitRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Workspace ${resolved} is outside git root ${gitRoot}.`);
  }
  const dirty = runGit(gitRoot, ['status', '--porcelain', '--untracked-files=normal']);
  if (dirty) {
    throw new Error(
      `Eval workspace ${gitRoot} must be clean. Comparative runs use committed HEAD so every provider starts from identical source.`
    );
  }
  return {
    sourceWorkspace: resolved,
    gitRoot,
    workspaceRelativePath: relative,
    headSha: runGit(gitRoot, ['rev-parse', 'HEAD'])
  };
}

function createDisposableWorktree(info, root, label, { reuseNodeModules = false } = {}) {
  const worktreeRoot = path.join(root, `worktree-${label}-${randomUUID()}`);
  runGit(info.gitRoot, ['worktree', 'add', '--detach', worktreeRoot, info.headSha]);
  if (reuseNodeModules) {
    const sourceNodeModules = path.join(info.gitRoot, 'node_modules');
    const targetNodeModules = path.join(worktreeRoot, 'node_modules');
    if (fs.existsSync(sourceNodeModules) && !fs.existsSync(targetNodeModules)) {
      try {
        fs.symlinkSync(
          sourceNodeModules,
          targetNodeModules,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      } catch {
        // Explicit dependency reuse is only an optimization. Validation can report missing
        // dependencies without the harness installing or mutating the source repository.
      }
    }
  }
  return {
    root: worktreeRoot,
    workspace: path.join(worktreeRoot, info.workspaceRelativePath),
    cleanup: () => {
      runGit(info.gitRoot, ['worktree', 'remove', '--force', worktreeRoot], { allowFailure: true });
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  };
}

function variantConfig(name, baseConfig) {
  const qwenModel = process.env.LOCAL_CODER_EVAL_OLLAMA_MODEL?.trim() || baseConfig.model;
  const config = { ...baseConfig };
  if (name === 'qwen' || name === 'auto') {
    config.model = qwenModel;
    config.strongModel = qwenModel;
    config.adaptiveModelsEnabled = false;
  }
  // Explicit cloud comparisons must prove cloud does not depend on a configured Windows
  // worker or an Ollama pre-pass. The Project allowlist excludes local inference anyway.
  if (name === 'anthropic' || name === 'openai') config.executionMode = 'local';
  return config;
}

function providerEnv() {
  return {
    qwen: {
      providerId: 'ollama',
      modelId: process.env.LOCAL_CODER_EVAL_OLLAMA_MODEL?.trim()
    },
    anthropic: {
      providerId: 'anthropic',
      modelId: process.env.LOCAL_CODER_EVAL_ANTHROPIC_MODEL?.trim(),
      secretEnv: 'ANTHROPIC_API_KEY'
    },
    openai: {
      providerId: 'openai',
      modelId: process.env.LOCAL_CODER_EVAL_OPENAI_MODEL?.trim(),
      secretEnv: 'OPENAI_API_KEY'
    }
  };
}

function readiness(variants, baseConfig) {
  const providers = providerEnv();
  const result = {};
  for (const variant of variants) {
    if (variant === 'qwen') {
      result[variant] = {
        ready: Boolean(providers.qwen.modelId || baseConfig.model),
        provider: 'ollama',
        model: providers.qwen.modelId || baseConfig.model,
        credential: 'local/remote Local Coder topology'
      };
      continue;
    }
    if (variant === 'anthropic' || variant === 'openai') {
      const item = providers[variant];
      result[variant] = {
        ready: Boolean(item.modelId && process.env[item.secretEnv]),
        provider: item.providerId,
        model: item.modelId || null,
        credential: item.secretEnv
      };
      continue;
    }
    const cloudReady = ['anthropic', 'openai'].filter((id) => {
      const item = providers[id];
      return Boolean(item.modelId && process.env[item.secretEnv]);
    });
    result.auto = {
      ready: Boolean(providers.qwen.modelId || baseConfig.model || cloudReady.length > 0),
      provider: 'router',
      model: 'auto',
      configuredCloudProviders: cloudReady
    };
  }
  return result;
}

function requireReady(variants, status) {
  for (const variant of variants) {
    if (!status[variant]?.ready) {
      throw new Error(
        `Variant ${variant} is not ready. Set an explicit LOCAL_CODER_EVAL_*_MODEL and the provider API-key environment variable where applicable.`
      );
    }
  }
}

function scoreCase(item, result) {
  const expected = item.expected || {};
  const quality = result.quality?.score;
  const statusOk = expected.status ? result.status === expected.status : true;
  const validationOk = expected.requireValidation
    ? result.validation.length > 0 && result.validation.every((entry) => entry.ok)
    : true;
  const qualityOk = expected.minQuality === undefined || (typeof quality === 'number' && quality >= expected.minQuality);
  return {
    passed: statusOk && validationOk && qualityOk,
    statusOk,
    validationOk,
    qualityOk
  };
}

function summarizeRouting(result) {
  const projectExecution = result.projectExecution;
  const traces = projectExecution?.routingTrace || [];
  const routes = traces.map((entry) => ({
    stage: entry.stage,
    providerId: entry.providerId,
    modelId: entry.modelId,
    providerKind: entry.providerKind,
    fallbackUsed: entry.fallbackUsed,
    attempts: entry.attempts.map((attempt) => ({
      providerId: attempt.providerId,
      modelId: attempt.modelId,
      status: attempt.status,
      retryable: attempt.retryable,
      rateLimited: attempt.rateLimited,
      admissionDenied: attempt.admissionDenied
    }))
  }));
  if (routes.length === 0) {
    for (const call of result.modelCalls || []) {
      routes.push({
        stage: call.stage,
        providerId: 'ollama',
        modelId: call.model,
        providerKind: 'local',
        fallbackUsed: false,
        attempts: [{ providerId: 'ollama', modelId: call.model, status: 'success' }]
      });
    }
  }
  return routes;
}

function summarizeTokens(result) {
  return (result.modelCalls || []).reduce(
    (totals, call) => ({
      prompt: totals.prompt + (call.promptTokens || 0),
      completion: totals.completion + (call.completionTokens || 0)
    }),
    { prompt: 0, completion: 0 }
  );
}

function aggregate(records) {
  const byVariant = {};
  const categories = {};
  for (const record of records) {
    const bucket = byVariant[record.variant] ||= {
      cases: 0,
      passed: 0,
      successes: 0,
      totalElapsedMs: 0,
      qualityScores: [],
      promptTokens: 0,
      completionTokens: 0,
      knownCostUsd: 0,
      unknownCostEvents: 0,
      fallbackStages: 0
    };
    bucket.cases += 1;
    bucket.passed += record.score.passed ? 1 : 0;
    bucket.successes += record.status === 'success' ? 1 : 0;
    bucket.totalElapsedMs += record.elapsedMs;
    if (typeof record.qualityScore === 'number') bucket.qualityScores.push(record.qualityScore);
    bucket.promptTokens += record.tokens.prompt;
    bucket.completionTokens += record.tokens.completion;
    bucket.knownCostUsd += record.knownCostUsd;
    bucket.unknownCostEvents += record.unknownCostEvents;
    bucket.fallbackStages += record.routes.filter((route) => route.fallbackUsed).length;

    const key = `${record.variant}\0${record.category}`;
    const category = categories[key] ||= { variant: record.variant, category: record.category, cases: 0, passed: 0, quality: [] };
    category.cases += 1;
    category.passed += record.score.passed ? 1 : 0;
    if (typeof record.qualityScore === 'number') category.quality.push(record.qualityScore);
  }
  const variantSummary = Object.fromEntries(Object.entries(byVariant).map(([variant, item]) => [variant, {
    cases: item.cases,
    passRate: item.cases ? item.passed / item.cases : 0,
    successRate: item.cases ? item.successes / item.cases : 0,
    meanElapsedMs: item.cases ? Math.round(item.totalElapsedMs / item.cases) : 0,
    meanQuality: item.qualityScores.length
      ? Math.round((item.qualityScores.reduce((sum, value) => sum + value, 0) / item.qualityScores.length) * 100) / 100
      : null,
    promptTokens: item.promptTokens,
    completionTokens: item.completionTokens,
    knownCostUsd: Math.round(item.knownCostUsd * 1e9) / 1e9,
    unknownCostEvents: item.unknownCostEvents,
    fallbackStages: item.fallbackStages
  }]));
  const categorySummary = Object.values(categories).map((item) => ({
    variant: item.variant,
    category: item.category,
    cases: item.cases,
    passRate: item.cases ? item.passed / item.cases : 0,
    meanQuality: item.quality.length
      ? Math.round((item.quality.reduce((sum, value) => sum + value, 0) / item.quality.length) * 100) / 100
      : null
  }));
  return { variants: variantSummary, categories: categorySummary };
}

function qualityRecommendations(records, providerConfig) {
  const recommendations = [];
  for (const variant of ['qwen', 'anthropic', 'openai']) {
    const provider = providerConfig[variant];
    const modelId = provider?.modelId;
    if (!modelId) continue;
    const scores = records
      .filter((record) => record.variant === variant && record.status === 'success' && typeof record.qualityScore === 'number')
      .map((record) => record.qualityScore);
    if (scores.length < 3) continue;
    recommendations.push({
      variant,
      providerId: provider.providerId,
      modelId,
      samples: scores.length,
      qualityScore: Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 100) / 100
    });
  }
  return recommendations;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = readCases(args.file, { allowPlaceholders: !args.execute });
  const { loadConfig } = await import('../dist/config.js');
  const {
    CredentialManager,
    CredentialProfileStore
  } = await import('../dist/credential-store.js');
  const { OllamaClient } = await import('../dist/ollama.js');
  const { PricingStore } = await import('../dist/pricing-store.js');
  const { ProjectBudgetSession } = await import('../dist/project-budget.js');
  const { ProjectAwareEngineerBackend } = await import('../dist/project-engineer-backend.js');
  const { ProviderSettingsStore } = await import('../dist/provider-settings.js');
  const { executePremiumLocalAgent } = await import('../dist/premium-agent.js');
  const { ProjectStore } = await import('../dist/project-store.js');
  const { RoutingHistoryStore } = await import('../dist/routing-history.js');
  const { UsageLedger } = await import('../dist/usage-ledger.js');

  const baseConfig = loadConfig();
  const status = readiness(args.variants, baseConfig);
  const plan = {
    mode: args.execute ? 'execute' : 'dry-run',
    cases: cases.map((item) => ({ id: item.id, category: item.category, workspace: item.workspace })),
    variants: args.variants,
    readiness: status,
    safety: {
      sourceWorkspacesMustBeClean: true,
      executionUsesDetachedWorktrees: true,
      sourceRepositoriesAreNeverReset: true,
      sourceNodeModulesReuse: args.reuseNodeModules ? 'explicitly enabled' : 'disabled',
      credentialsRemainEnvironmentBacked: true,
      modelIdsAreExplicitForCloud: true
    }
  };
  if (!args.execute) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  requireReady(args.variants, status);

  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-provider-eval-'));
  const providerConfig = providerEnv();
  providerConfig.qwen.modelId ||= baseConfig.model;
  const records = [];
  const pricing = new PricingStore();

  try {
    const workspaceInfo = new Map();
    for (const item of cases) {
      if (!workspaceInfo.has(item.workspace)) workspaceInfo.set(item.workspace, inspectWorkspace(item.workspace));
    }

    for (const variant of args.variants) {
      for (const item of cases) {
        const info = workspaceInfo.get(item.workspace);
        const disposable = createDisposableWorktree(info, runRoot, `${variant}-${item.id}`, {
          reuseNodeModules: args.reuseNodeModules
        });
        const stateRoot = path.join(runRoot, `state-${variant}-${item.id}-${randomUUID()}`);
        try {
          const organizationId = `eval-${variant}`;
          const projectId = `eval-${variant}-${item.id}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
          const credentials = new CredentialManager(
            new CredentialProfileStore(path.join(stateRoot, 'credentials.json'))
          );
          const providerSettings = new ProviderSettingsStore(path.join(stateRoot, 'providers.json'));
          const credentialProfileIds = {};
          const allowedProviderIds = [];

          const evalConfig = variantConfig(variant, baseConfig);
          if (variant === 'qwen' || variant === 'auto') {
            allowedProviderIds.push('ollama');
            providerSettings.update('ollama', {
              enabled: true,
              defaultModelId: providerConfig.qwen.modelId,
              models: { [providerConfig.qwen.modelId]: { enabled: true } }
            });
          }
          for (const cloudId of ['anthropic', 'openai']) {
            if (variant !== cloudId && variant !== 'auto') continue;
            const cloud = providerConfig[cloudId];
            if (!cloud.modelId || !process.env[cloud.secretEnv]) {
              if (variant === 'auto') continue;
              throw new Error(`Missing ${cloudId} eval model or ${cloud.secretEnv}.`);
            }
            allowedProviderIds.push(cloudId);
            const credentialId = `eval-${cloudId}`;
            credentials.addEnvironmentCredential({
              id: credentialId,
              providerId: cloudId,
              label: `Comparative eval ${cloudId}`,
              environmentVariable: cloud.secretEnv,
              organizationId
            });
            credentialProfileIds[cloudId] = credentialId;
            providerSettings.update(cloudId, {
              enabled: true,
              defaultModelId: cloud.modelId,
              models: { [cloud.modelId]: { enabled: true } }
            });
          }

          const projects = new ProjectStore(path.join(stateRoot, 'projects.json'));
          const selected = variant === 'anthropic' || variant === 'openai'
            ? { mode: 'explicit', providerId: variant, modelId: providerConfig[variant].modelId }
            : { mode: 'auto' };
          const project = projects.create({
            id: projectId,
            name: `Eval ${variant} ${item.id}`,
            workspace: disposable.workspace,
            organizationId,
            defaultRoutingPolicy: variant === 'auto' ? 'auto' : 'balanced',
            defaultModel: selected,
            privacy: {
              cloudAllowed: allowedProviderIds.some((id) => id !== 'ollama'),
              allowedProviderIds
            },
            credentialProfileIds,
            budgets: {},
            concurrency: 1
          });
          const ollama = new OllamaClient(evalConfig);
          const legacy = {
            executeEngineer: async (input) => (await executePremiumLocalAgent(ollama, evalConfig, input)).result
          };
          const ledger = new UsageLedger(path.join(stateRoot, 'usage'));
          const backend = new ProjectAwareEngineerBackend(evalConfig, ollama, legacy, {
            projects,
            providerRuntime: { credentials, settings: providerSettings },
            routingHistory: new RoutingHistoryStore(path.join(stateRoot, 'routing-history')),
            budgetSessionFactory: (definition, jobId) => new ProjectBudgetSession(
              definition,
              pricing,
              ledger,
              jobId ? { jobId } : {}
            )
          });

          const startedAt = Date.now();
          let result;
          let thrown;
          try {
            result = await backend.executeEngineer({
              projectId: project.id,
              workspace: disposable.workspace,
              goal: item.goal,
              context: item.context,
              constraints: item.constraints,
              language: item.language,
              maxRepairRounds: item.maxRepairRounds ?? 1,
              budgetJobId: `eval-${variant}-${item.id}`.replace(/[^A-Za-z0-9._:-]/g, '-')
            });
          } catch (error) {
            thrown = error instanceof Error ? error.message : String(error);
          }
          const elapsedMs = Date.now() - startedAt;
          if (!result) {
            records.push({
              variant,
              caseId: item.id,
              category: item.category,
              status: 'threw',
              elapsedMs,
              qualityScore: null,
              score: { passed: false, statusOk: false, validationOk: false, qualityOk: false },
              routes: [],
              tokens: { prompt: 0, completion: 0 },
              knownCostUsd: 0,
              unknownCostEvents: 0,
              error: thrown
            });
            continue;
          }
          const premium = result;
          const score = scoreCase(item, premium);
          const routes = summarizeRouting(premium);
          const tokens = summarizeTokens(premium);
          const budget = premium.projectExecution?.budget;
          records.push({
            variant,
            caseId: item.id,
            category: item.category,
            status: premium.status,
            phase: premium.phase,
            elapsedMs,
            qualityScore: premium.quality?.score ?? null,
            qualityBand: premium.quality?.band ?? null,
            score,
            routes,
            fallbackStages: routes.filter((route) => route.fallbackUsed).length,
            tokens,
            knownCostUsd: budget?.jobKnownCostUsd ?? 0,
            unknownCostEvents: budget?.jobUnknownCostEvents ?? 0,
            changedFiles: premium.changedFiles.length,
            validations: premium.validation.map((entry) => ({
              command: entry.command,
              args: entry.args,
              ok: entry.ok,
              exitCode: entry.exitCode,
              durationMs: entry.durationMs
            })),
            summary: premium.summary
          });
        } finally {
          disposable.cleanup();
        }
      }
    }

    const recommendations = qualityRecommendations(records, providerConfig);
    if (args.applyQualityProfiles) {
      const persistentSettings = new ProviderSettingsStore();
      for (const recommendation of recommendations) {
        const current = persistentSettings.get(recommendation.providerId) || { enabled: true, models: {} };
        const profile = current.models[recommendation.modelId] || {};
        persistentSettings.update(recommendation.providerId, {
          models: {
            [recommendation.modelId]: {
              ...profile,
              qualityScore: recommendation.qualityScore
            }
          }
        });
      }
    }

    const report = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: path.relative(process.cwd(), args.file) || args.file,
      variants: args.variants,
      sourceHeads: Object.fromEntries([...workspaceInfo.entries()].map(([workspace, info]) => [workspace, info.headSha])),
      safety: plan.safety,
      summary: aggregate(records),
      qualityRecommendations: recommendations,
      qualityProfilesApplied: args.applyQualityProfiles,
      records
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      report: args.out,
      summary: report.summary,
      qualityRecommendations: recommendations,
      qualityProfilesApplied: args.applyQualityProfiles
    }, null, 2));
    if (records.some((record) => !record.score.passed)) process.exitCode = 2;
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
