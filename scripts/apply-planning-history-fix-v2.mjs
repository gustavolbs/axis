import fs from 'node:fs/promises';

const nl = (items) => items.join('\n');
const read = (path) => fs.readFile(path, 'utf8');
const write = (path, content) => fs.writeFile(path, content, 'utf8');

function replaceOnce(content, before, after, label) {
  const index = content.indexOf(before);
  if (index < 0) throw new Error('Patch target not found: ' + label);
  if (content.indexOf(before, index + before.length) >= 0) throw new Error('Patch target ambiguous: ' + label);
  return content.slice(0, index) + after + content.slice(index + before.length);
}

// local-engineer: bound evidence, medium planning, retry only schema-invalid model output.
{
  const path = 'src/local-engineer.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
    nl([
      '    try {',
      '      const generation = await model.chat(systemPrompt, prompt, format, {',
      '        model: config.model,',
      '        numCtx: config.ollamaNumCtx ?? 16_384,',
      "        keepAlive: config.fastModelKeepAlive ?? '90s',",
      '        think',
      '      });',
      '      return { parsed: schema.parse(JSON.parse(generation.content) as unknown), generation };',
      '    } catch (error) {',
      '      lastError = error;',
      '    }'
    ]),
    nl([
      '    // Transport/model failures are not schema failures. Retrying them can double a',
      '    // multi-minute timeout. Retry only after the model returned invalid structured content.',
      '    const generation = await model.chat(systemPrompt, prompt, format, {',
      '      model: config.model,',
      '      numCtx: config.ollamaNumCtx ?? 16_384,',
      "      keepAlive: config.fastModelKeepAlive ?? '90s',",
      '      think',
      '    });',
      '    try {',
      '      return { parsed: schema.parse(JSON.parse(generation.content) as unknown), generation };',
      '    } catch (error) {',
      '      lastError = error;',
      '    }'
    ]),
    'structured retry policy'
  );
  content = replaceOnce(content, '  const budget = Math.min(config.maxContextBytes, 72_000);', '  const budget = Math.min(config.maxContextBytes, 28_000);', 'evidence budget');
  content = replaceOnce(content, '  for (const file of dedupe(files).slice(0, 12)) {', '  for (const file of dedupe(files).slice(0, 8)) {', 'evidence file count');
  content = replaceOnce(content, '      const content = snapshot.content.slice(0, Math.min(12_000, remaining));', '      const content = snapshot.content.slice(0, Math.min(6_000, remaining));', 'per-file evidence budget');
  content = replaceOnce(
    content,
    nl([
      '  const focusedCapsule = await prepareContextCapsule(index, config, {',
      '    workspace,',
      '    task: input.goal,',
      '    hints: investigation.searchQueries,',
      '    maxFiles: 12,',
      '    maxCharsPerFile: 2_000',
      '  });'
    ]),
    nl([
      '  const focusedCapsule = await prepareContextCapsule(index, config, {',
      '    workspace,',
      '    task: input.goal,',
      '    hints: investigation.searchQueries,',
      '    maxFiles: 8,',
      '    maxCharsPerFile: 1_200',
      '  });'
    ]),
    'focused capsule budget'
  );
  content = replaceOnce(
    content,
    nl(['    planningFormat,', '    planningSchema,', "    'high'", '  );']),
    nl(['    planningFormat,', '    planningSchema,', "    'medium'", '  );']),
    'planning effort'
  );
  await write(path, content);
}

// ollama: actual stream response + deterministic planning prompt bound.
{
  const path = 'src/ollama.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
    "import path from 'node:path';",
    nl(["import path from 'node:path';", '', "import { readOllamaChatStream } from './ollama-stream.js';", "import { preparePromptForInference } from './planning-policy.js';"]),
    'ollama helper imports'
  );
  content = replaceOnce(
    content,
    nl([
      '        const think = normalizeThinkingForModel(model, runtime.think);',
      '',
      '        // The lock is shared'
    ]),
    nl([
      '        const think = normalizeThinkingForModel(model, runtime.think);',
      '        const preparedPrompt = preparePromptForInference(',
      '          systemPrompt,',
      '          userPrompt,',
      '          runtime.numCtx ?? this.config.ollamaNumCtx ?? 16_384',
      '        );',
      '',
      '        // The lock is shared'
    ]),
    'prepare bounded prompt'
  );
  content = replaceOnce(content, '            stream: false,', '            stream: true,', 'stream true');
  content = replaceOnce(content, "              { role: 'user', content: userPrompt }", "              { role: 'user', content: preparedPrompt.userPrompt }", 'bounded prompt body');
  content = replaceOnce(
    content,
    nl([
      '        const payload = (await response.json()) as OllamaChatResponse;',
      '        const content = payload.message?.content?.trim();',
      '',
      '        if (!content) {',
      "          throw new Error('Ollama returned an empty assistant message.');",
      '        }',
      '',
      '        const generation: OllamaGeneration = {',
      '          content,',
      '          model: payload.model ?? model,',
      '          doneReason: payload.done_reason,',
      '          totalDurationNs: payload.total_duration,',
      '          promptTokens: payload.prompt_eval_count,',
      '          completionTokens: payload.eval_count',
      '        };',
      '',
      '        await this.recordInference(generation);',
      '        return generation;'
    ]),
    nl([
      '        // stream:true makes Ollama send HTTP headers immediately, avoiding the ~300s',
      '        // headers timeout that can occur when a long non-streaming inference holds them.',
      '        const generation = await readOllamaChatStream(response, model);',
      '        await this.recordInference(generation);',
      '        return generation;'
    ]),
    'stream response parser'
  );
  await write(path, content);
}

// progress context carries the worker job id so inference history can be correlated.
{
  await write('src/progress-context.ts', nl([
    "import { AsyncLocalStorage } from 'node:async_hooks';",
    '',
    "import type { EngineeringProgress, ProgressReporter } from './engineering-progress.js';",
    '',
    'interface ProgressContext {',
    '  reporter: ProgressReporter;',
    '  jobId?: string;',
    '}',
    '',
    'const storage = new AsyncLocalStorage<ProgressContext>();',
    '',
    'export async function withProgressReporter<T>(',
    '  reporter: ProgressReporter,',
    '  run: () => Promise<T>,',
    '  jobId?: string',
    '): Promise<T> {',
    '  return await storage.run({ reporter, jobId }, run);',
    '}',
    '',
    'export function reportProgress(progress: Partial<EngineeringProgress>): void {',
    '  storage.getStore()?.reporter(progress);',
    '}',
    '',
    'export function currentProgressJobId(): string | undefined {',
    '  return storage.getStore()?.jobId;',
    '}',
    ''
  ]));
}

{
  const path = 'src/worker-scheduler.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
    '      void withProgressReporter(context.update, () => job.run(context))',
    '      void withProgressReporter(context.update, () => job.run(context), job.id)',
    'scheduler job id context'
  );
  await write(path, content);
}

// Worker persistent read-only history.
{
  const path = 'src/worker-server.ts';
  let content = await read(path);
  content = replaceOnce(content, "import os from 'node:os';", nl(["import os from 'node:os';", "import path from 'node:path';"]), 'worker path import');
  content = replaceOnce(
    content,
    "import { getMachineStatus } from './machine-status.js';\nimport { OllamaClient } from './ollama.js';",
    nl([
      "import { getMachineStatus } from './machine-status.js';",
      "import { OllamaClient } from './ollama.js';",
      "import { preparePromptForInference } from './planning-policy.js';",
      "import { currentProgressJobId } from './progress-context.js';"
    ]),
    'worker planning/history imports'
  );
  content = replaceOnce(
    content,
    "import { WorkerScheduler } from './worker-scheduler.js';\nimport { withWorkerWorkspace } from './worker-workspace.js';",
    nl(["import { WorkerScheduler } from './worker-scheduler.js';", "import { WorkerHistoryStore } from './worker-history.js';", "import { withWorkerWorkspace } from './worker-workspace.js';"]),
    'worker history import'
  );
  content = replaceOnce(
    content,
    nl([
      "const WORKER_VERSION = '0.12.1';",
      'const config = loadConfig();',
      'const ollama = new OllamaClient(config);',
      'const scheduler = new WorkerScheduler(config.workerMaxConcurrentJobs ?? 1);',
      'const inferenceTracker = new WorkerInferenceTracker();'
    ]),
    nl([
      "const WORKER_VERSION = '0.13.0';",
      'const config = loadConfig();',
      'const ollama = new OllamaClient(config);',
      'const scheduler = new WorkerScheduler(config.workerMaxConcurrentJobs ?? 1);',
      "const history = new WorkerHistoryStore(path.join(config.workerStatePath, 'history'), 200);",
      'const inferenceTracker = new WorkerInferenceTracker();',
      'const historyFailure = (error: unknown): void => {',
      "  console.error('local-coder history write failed: ' + (error instanceof Error ? error.message : String(error)));",
      '};'
    ]),
    'worker history initialization'
  );

  const wrapperStart = content.indexOf("const baseChat = ollama.chat.bind(ollama);");
  const wrapperEndMarker = ") as OllamaClient['chat'];";
  const wrapperEnd = content.indexOf(wrapperEndMarker, wrapperStart);
  if (wrapperStart < 0 || wrapperEnd < 0) throw new Error('Patch target not found: ollama wrapper');
  const wrapper = nl([
    'const baseChat = ollama.chat.bind(ollama);',
    "ollama.chat = (async (...args: Parameters<OllamaClient['chat']>) => {",
    '  const [systemPrompt, userPrompt, format, runtime] = args;',
    '  const stage = classifyInferenceStage(systemPrompt);',
    '  const model = runtime?.model ?? config.model;',
    '  const preparedPrompt = preparePromptForInference(',
    '    systemPrompt,',
    '    userPrompt,',
    '    runtime?.numCtx ?? config.ollamaNumCtx ?? 16_384',
    '  );',
    '  const jobId = currentProgressJobId();',
    '  const inferenceId = inferenceTracker.begin(stage, model);',
    '  reportProgress(progressAtInferenceStart(stage, preparedPrompt.userPrompt));',
    '  if (jobId) {',
    '    await history.appendEvent(jobId, {',
    "      type: 'model-input',",
    "      title: stage + ' prompt sent to Qwen',",
    '      stage,',
    '      model,',
    '      systemPrompt,',
    '      userPrompt: preparedPrompt.userPrompt,',
    '      promptTruncated: preparedPrompt.truncated,',
    '      originalUserPromptChars: preparedPrompt.originalUserPromptChars,',
    '      data: { format: format ?? null, thinking: runtime?.think ?? null }',
    '    }).catch(historyFailure);',
    '  }',
    '  try {',
    '    const generation = await baseChat(...args);',
    "    inferenceTracker.complete(inferenceId, 'success', {",
    '      promptTokens: generation.promptTokens,',
    '      completionTokens: generation.completionTokens',
    '    });',
    '    if (jobId) {',
    '      await history.appendEvent(jobId, {',
    "        type: 'model-output',",
    "        title: stage + ' output',",
    '        stage,',
    '        model: generation.model,',
    '        output: generation.content,',
    '        promptTokens: generation.promptTokens,',
    '        completionTokens: generation.completionTokens,',
    '        durationMs: generation.totalDurationNs ? generation.totalDurationNs / 1_000_000 : undefined',
    '      }).catch(historyFailure);',
    '    }',
    '    reportProgress(progressFromInferenceResult(stage, generation.content));',
    '    return generation;',
    '  } catch (error) {',
    '    const message = error instanceof Error ? error.message : String(error);',
    "    inferenceTracker.complete(inferenceId, 'error', { error: message });",
    '    if (jobId) {',
    '      await history.appendEvent(jobId, {',
    "        type: 'error',",
    "        title: stage + ' inference failed',",
    '        stage,',
    '        model,',
    '        error: message',
    '      }).catch(historyFailure);',
    '    }',
    '    reportProgress({',
    '      phase: stage,',
    "      action: 'Qwen ' + stage + ' call failed',",
    '      detail: message,',
    "      reasoningSummary: 'The current local inference failed before a usable structured result was produced.'",
    '    });',
    '    throw error;',
    '  }',
    "}) as OllamaClient['chat'];"
  ]);
  content = content.slice(0, wrapperStart) + wrapper + content.slice(wrapperEnd + wrapperEndMarker.length);

  const engineerStart = content.indexOf('async function handleEngineer(');
  const engineerEnd = content.indexOf('\nasync function route(', engineerStart);
  if (engineerStart < 0 || engineerEnd < 0) throw new Error('Patch target not found: handleEngineer');
  const engineer = nl([
    'async function handleEngineer(body: unknown, response: ServerResponse): Promise<void> {',
    "  assertObject(body, 'request');",
    '  assertProtocolVersion(body.protocolVersion);',
    '  assertWorkspace(body.workspace);',
    "  assertObject(body.input, 'input');",
    '',
    '  const request = body as unknown as RemoteEngineerRequest;',
    "  if (typeof request.input.goal !== 'string' || !request.input.goal.trim()) {",
    "    throw new Error('input.goal is required.');",
    '  }',
    '',
    '  let historyJobId: string | undefined;',
    '  try {',
    "    const output = await scheduler.enqueue('engineer', isolationKey(request.workspace), async (job) => {",
    '      historyJobId = job.id;',
    '      await history.startRun({',
    '        id: job.id,',
    "        kind: 'engineer',",
    '        isolationKey: isolationKey(request.workspace),',
    '        startedAt: new Date().toISOString()',
    '      });',
    '      await history.annotateRun(job.id, {',
    '        goal: request.input.goal,',
    '        repositoryUrl: request.workspace.repositoryUrl',
    '      });',
    '      await history.appendEvent(job.id, {',
    "        type: 'request',",
    "        title: 'local_engineer request',",
    '        data: {',
    '          goal: request.input.goal,',
    '          context: request.input.context ?? null,',
    '          constraints: request.input.constraints ?? [],',
    '          language: request.input.language ?? null,',
    '          claudeGuidance: request.input.claudeGuidance ?? null,',
    '          maxRepairRounds: request.input.maxRepairRounds ?? null,',
    '          repositoryUrl: request.workspace.repositoryUrl,',
    '          baseSha: request.workspace.baseSha',
    '        }',
    '      });',
    '      job.update({',
    "        phase: 'workspace',",
    "        action: 'Reconstructing repository worktree',",
    '        detail: request.workspace.repositoryUrl,',
    '        completedSteps: []',
    '      });',
    '      return await withWorkerWorkspace(request.workspace, config, async (workspace) => {',
    '        job.update({',
    "          phase: 'investigation',",
    "          action: 'Workspace reconstructed; starting local engineer',",
    '          detail: request.input.goal,',
    "          completedSteps: ['workspace']",
    '        });',
    '        return await executeLocalEngineerWithRepoIntelligence(ollama, config, {',
    '          ...request.input,',
    '          workspace,',
    '          repoMemoryScopeKey: request.workspace.memoryScopeKey',
    '        });',
    '      });',
    '    });',
    '',
    '    if (historyJobId) {',
    '      await history.appendEvent(historyJobId, {',
    "        type: 'result',",
    "        title: 'local_engineer result',",
    '        data: {',
    '          status: output.result.result.status,',
    '          phase: output.result.result.phase,',
    '          summary: output.result.result.summary,',
    '          changedFiles: output.result.result.changedFiles,',
    '          validation: output.result.result.validation,',
    '          review: output.result.result.review ?? null,',
    '          repairRounds: output.result.result.repairRounds,',
    '          modelCalls: output.result.result.modelCalls,',
    '          escalation: output.result.result.escalation ?? null',
    '        }',
    '      });',
    "      await history.finishRun(historyJobId, 'success');",
    '    }',
    '',
    '    json(response, 200, {',
    '      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,',
    '      result: output.result.result,',
    '      changes: output.result.changes',
    '    });',
    '  } catch (error) {',
    '    if (historyJobId) {',
    '      const message = error instanceof Error ? error.message : String(error);',
    '      await history.appendEvent(historyJobId, {',
    "        type: 'error',",
    "        title: 'local_engineer failed',",
    '        error: message',
    '      }).catch(historyFailure);',
    "      await history.finishRun(historyJobId, 'error', message).catch(historyFailure);",
    '    }',
    '    throw error;',
    '  }',
    '}',
    ''
  ]);
  content = content.slice(0, engineerStart) + engineer + content.slice(engineerEnd + 1);

  content = replaceOnce(
    content,
    nl([
      "  if (request.method === 'GET' && request.url === '/v1/status') {",
      '    await status(response);',
      '    return;',
      '  }',
      '',
      "  if (request.method !== 'POST') {"
    ]),
    nl([
      "  if (request.method === 'GET' && request.url === '/v1/status') {",
      '    await status(response);',
      '    return;',
      '  }',
      "  if (request.method === 'GET' && request.url?.startsWith('/v1/history')) {",
      "    const url = new URL(request.url, 'http://local-coder-worker');",
      "    if (url.pathname === '/v1/history') {",
      "      const parsedLimit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);",
      '      json(response, 200, {',
      '        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,',
      '        runs: await history.listRuns(Number.isFinite(parsedLimit) ? parsedLimit : 50)',
      '      });',
      '      return;',
      '    }',
      "    const match = /^\\/v1\\/history\\/([A-Za-z0-9-]{1,100})$/.exec(url.pathname);",
      '    if (match) {',
      '      const run = await history.readRun(match[1]);',
      '      if (!run) {',
      "        json(response, 404, { protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, error: 'History run not found.' });",
      '        return;',
      '      }',
      '      json(response, 200, { protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, run });',
      '      return;',
      '    }',
      '  }',
      '',
      "  if (request.method !== 'POST') {"
    ]),
    'history routes'
  );
  await write(path, content);
}

// Dashboard proxy and UI mount.
{
  const path = 'scripts/dashboard.mjs';
  let content = await read(path);
  content = replaceOnce(
    content,
    'async function statusPayload() {',
    nl([
      'async function workerGet(pathname) {',
      '  const { workerUrl, token } = await loadConnection();',
      '  const response = await fetch(workerUrl + pathname, {',
      '    headers: { authorization: `Bearer ${token}` },',
      '    signal: AbortSignal.timeout(5000)',
      '  });',
      '  const body = await response.json();',
      "  if (!response.ok) throw new Error(body?.error ?? ('Worker returned HTTP ' + response.status));",
      '  return body;',
      '}',
      '',
      'async function statusPayload() {'
    ]),
    'dashboard workerGet'
  );
  content = replaceOnce(
    content,
    nl([
      "    if (request.method === 'GET') {",
      '      await sendStatic(request, response);',
      '      return;',
      '    }'
    ]),
    nl([
      "    if (request.method === 'GET' && request.url?.startsWith('/api/history')) {",
      '      try {',
      '        const url = new URL(request.url, `http://${host}:${port}`);',
      "        const suffix = url.pathname.slice('/api/history'.length);",
      "        if (suffix && !/^\\/[A-Za-z0-9-]{1,100}$/.test(suffix)) {",
      "          sendJson(response, 400, { error: 'Invalid history id.' });",
      '          return;',
      '        }',
      "        sendJson(response, 200, await workerGet('/v1/history' + suffix + url.search));",
      '      } catch (error) {',
      '        sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });',
      '      }',
      '      return;',
      '    }',
      "    if (request.method === 'GET') {",
      '      await sendStatic(request, response);',
      '      return;',
      '    }'
    ]),
    'dashboard history route'
  );
  await write(path, content);
}

{
  const path = 'dashboard/src/App.tsx';
  let content = await read(path);
  content = replaceOnce(content, "import { Progress } from '@/components/ui/progress';\nimport { cn } from '@/lib/utils';", "import { Progress } from '@/components/ui/progress';\nimport { HistoryPanel } from '@/HistoryPanel';\nimport { cn } from '@/lib/utils';", 'HistoryPanel import');
  content = replaceOnce(
    content,
    nl(['        </section>', '      </main>', '    </div>', '  );', '}']),
    nl(['        </section>', '', '        <HistoryPanel />', '      </main>', '    </div>', '  );', '}']),
    'HistoryPanel mount'
  );
  await write(path, content);
}

// Extend history event type for final local_engineer results.
{
  const path = 'src/worker-history.ts';
  let content = await read(path);
  content = replaceOnce(content, "  | 'model-output'\n  | 'error'", "  | 'model-output'\n  | 'result'\n  | 'error'", 'history result event type');
  await write(path, content);
}

{
  const path = 'dashboard/src/HistoryPanel.tsx';
  let content = await read(path);
  content = replaceOnce(content, "'model-input' | 'model-output' | 'error'", "'model-input' | 'model-output' | 'result' | 'error'", 'dashboard result event type');
  await write(path, content);
}

// Tests + version.
{
  const path = 'test/local-engineer.test.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
    nl(['    assert.equal(reasoningCalls.length, 3);', "    assert.ok(reasoningCalls.every((call) => call.runtime.think === 'high'));" ]),
    nl(['    assert.equal(reasoningCalls.length, 3);', "    assert.equal(reasoningCalls[0]?.runtime.think, 'high');", "    assert.equal(reasoningCalls[1]?.runtime.think, 'medium');", "    assert.equal(reasoningCalls[2]?.runtime.think, 'high');"]),
    'planning effort test'
  );
  content += nl([
    '',
    '',
    "test('does not retry a transport failure as invalid structured output', async () => {",
    '  await withWorkspace(async (workspace, stateRoot) => {',
    '    let calls = 0;',
    '    const model = {',
    '      async chat(): Promise<OllamaGeneration> {',
    '        calls += 1;',
    '        if (calls === 1) return generation(investigation());',
    "        throw new Error('transport timeout');",
    '      }',
    '    };',
    '',
    '    await assert.rejects(',
    "      () => executeLocalEngineer(model as never, config(stateRoot), { workspace, goal: 'Make one safe improvement.' }),",
    '      /transport timeout/',
    '    );',
    "    assert.equal(calls, 2, 'investigation plus exactly one planning attempt');",
    '  });',
    '});',
    ''
  ]);
  await write(path, content);
}

{
  const path = 'test/ollama-streaming.test.ts';
  let content = await read(path);
  content = replaceOnce(content, "import { OllamaClient, preparePromptForInference } from '../src/ollama.js';", "import { OllamaClient } from '../src/ollama.js';\nimport { preparePromptForInference } from '../src/planning-policy.js';", 'stream test helper import');
  await write(path, content);
}

{
  const path = 'package.json';
  let content = await read(path);
  content = replaceOnce(content, '"version": "0.12.1"', '"version": "0.13.0"', 'version');
  await write(path, content);
}

console.log('Applied Local Coder planning resilience and persistent history changes.');
