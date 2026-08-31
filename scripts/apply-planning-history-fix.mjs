import fs from 'node:fs/promises';

async function read(path) {
  return await fs.readFile(path, 'utf8');
}

async function write(path, content) {
  await fs.writeFile(path, content, 'utf8');
}

function replaceOnce(content, before, after, label) {
  const index = content.indexOf(before);
  if (index < 0) throw new Error(`Patch target not found: ${label}`);
  if (content.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Patch target is ambiguous: ${label}`);
  }
  return `${content.slice(0, index)}${after}${content.slice(index + before.length)}`;
}

// 1) structured-call resilience + smaller planning evidence + medium planning effort.
{
  const path = 'src/local-engineer.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
`    try {
      const generation = await model.chat(systemPrompt, prompt, format, {
        model: config.model,
        numCtx: config.ollamaNumCtx ?? 16_384,
        keepAlive: config.fastModelKeepAlive ?? '90s',
        think
      });
      return { parsed: schema.parse(JSON.parse(generation.content) as unknown), generation };
    } catch (error) {
      lastError = error;
    }`,
`    // Transport/model failures are not schema failures. Retrying a timeout can turn one
    // expensive failed inference into two identical multi-minute failures. Only retry
    // after the model returned content that could not be parsed/validated.
    const generation = await model.chat(systemPrompt, prompt, format, {
      model: config.model,
      numCtx: config.ollamaNumCtx ?? 16_384,
      keepAlive: config.fastModelKeepAlive ?? '90s',
      think
    });
    try {
      return { parsed: schema.parse(JSON.parse(generation.content) as unknown), generation };
    } catch (error) {
      lastError = error;
    }`,
    'structuredCall retry policy'
  );
  content = replaceOnce(
    content,
    '  const budget = Math.min(config.maxContextBytes, 72_000);',
    '  const budget = Math.min(config.maxContextBytes, 28_000);',
    'full evidence budget'
  );
  content = replaceOnce(
    content,
    '  for (const file of dedupe(files).slice(0, 12)) {',
    '  for (const file of dedupe(files).slice(0, 8)) {',
    'full evidence file count'
  );
  content = replaceOnce(
    content,
    '      const content = snapshot.content.slice(0, Math.min(12_000, remaining));',
    '      const content = snapshot.content.slice(0, Math.min(6_000, remaining));',
    'full evidence per-file budget'
  );
  content = replaceOnce(
    content,
`  const focusedCapsule = await prepareContextCapsule(index, config, {
    workspace,
    task: input.goal,
    hints: investigation.searchQueries,
    maxFiles: 12,
    maxCharsPerFile: 2_000
  });`,
`  const focusedCapsule = await prepareContextCapsule(index, config, {
    workspace,
    task: input.goal,
    hints: investigation.searchQueries,
    maxFiles: 8,
    maxCharsPerFile: 1_200
  });`,
    'focused planning capsule budget'
  );
  content = replaceOnce(
    content,
`    planningFormat,
    planningSchema,
    'high'
  );`,
`    planningFormat,
    planningSchema,
    'medium'
  );`,
    'planning reasoning effort'
  );
  await write(path, content);
}

// 2) Stream Ollama responses and hard-bound the actual planning prompt sent to the model.
{
  const path = 'src/ollama.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
`interface OllamaChatResponse {
  model?: string;`,
`interface OllamaChatResponse {
  error?: string;
  model?: string;`,
    'Ollama stream error shape'
  );
  content = replaceOnce(
    content,
`export interface OllamaChatOptions {
  model?: string;
  numCtx?: number;
  keepAlive?: string | number;
  /** Model-agnostic thinking intent. The client adapts it to model-specific templates. */
  think?: OllamaThinkingLevel;
}
`,
`export interface OllamaChatOptions {
  model?: string;
  numCtx?: number;
  keepAlive?: string | number;
  /** Model-agnostic thinking intent. The client adapts it to model-specific templates. */
  think?: OllamaThinkingLevel;
}

export interface PreparedInferencePrompt {
  userPrompt: string;
  originalUserPromptChars: number;
  truncated: boolean;
}

export function preparePromptForInference(
  systemPrompt: string,
  userPrompt: string,
  numCtx = 16_384
): PreparedInferencePrompt {
  const isPlanning = systemPrompt
    .toLowerCase()
    .includes('reasoning/planning stage of a local software-engineering agent');
  if (!isPlanning) {
    return { userPrompt, originalUserPromptChars: userPrompt.length, truncated: false };
  }

  // Keep the planning request comfortably below a 16k-token context. Preserve the
  // beginning (goal/constraints) and the tail (validation candidates) while trimming
  // the large evidence middle. 48k chars is intentionally conservative for mixed code/text.
  const budget = Math.min(48_000, Math.max(24_000, numCtx * 3));
  if (userPrompt.length <= budget) {
    return { userPrompt, originalUserPromptChars: userPrompt.length, truncated: false };
  }

  const marker = '\n\n...[planning evidence truncated to stay within local context budget]...\n\n';
  const tailChars = Math.min(8_000, Math.floor(budget * 0.18));
  const headChars = Math.max(1, budget - tailChars - marker.length);
  return {
    userPrompt: `${userPrompt.slice(0, headChars)}${marker}${userPrompt.slice(-tailChars)}`,
    originalUserPromptChars: userPrompt.length,
    truncated: true
  };
}
`,
    'prepared inference prompt helper'
  );
  content = replaceOnce(
    content,
`        const think = normalizeThinkingForModel(model, runtime.think);

        // The lock is shared`,
`        const think = normalizeThinkingForModel(model, runtime.think);
        const preparedPrompt = preparePromptForInference(
          systemPrompt,
          userPrompt,
          runtime.numCtx ?? this.config.ollamaNumCtx ?? 16_384
        );

        // The lock is shared`,
    'prepare prompt before Ollama call'
  );
  content = replaceOnce(content, '            stream: false,', '            stream: true,', 'enable Ollama streaming');
  content = replaceOnce(
    content,
    "              { role: 'user', content: userPrompt }",
    "              { role: 'user', content: preparedPrompt.userPrompt }",
    'send bounded prompt'
  );
  content = replaceOnce(
    content,
`        const payload = (await response.json()) as OllamaChatResponse;
        const content = payload.message?.content?.trim();

        if (!content) {
          throw new Error('Ollama returned an empty assistant message.');
        }

        const generation: OllamaGeneration = {
          content,
          model: payload.model ?? model,
          doneReason: payload.done_reason,
          totalDurationNs: payload.total_duration,
          promptTokens: payload.prompt_eval_count,
          completionTokens: payload.eval_count
        };

        await this.recordInference(generation);
        return generation;`,
`        const generation = await this.readStreamingChat(response, model);
        await this.recordInference(generation);
        return generation;`,
    'streaming response reader call'
  );
  content = replaceOnce(
    content,
`  private async enqueue<T>(run: () => Promise<T>): Promise<T> {`,
`  private async readStreamingChat(response: Response, fallbackModel: string): Promise<OllamaGeneration> {
    if (!response.body) throw new Error('Ollama returned a response without a body.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finalChunk: OllamaChatResponse | undefined;

    const consume = (line: string): void => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line) as OllamaChatResponse;
      if (chunk.error) throw new Error(`Ollama stream error: ${chunk.error}`);
      content += chunk.message?.content ?? '';
      finalChunk = chunk;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);

    const normalized = content.trim();
    if (!normalized) throw new Error('Ollama returned an empty assistant message.');

    return {
      content: normalized,
      model: finalChunk?.model ?? fallbackModel,
      doneReason: finalChunk?.done_reason,
      totalDurationNs: finalChunk?.total_duration,
      promptTokens: finalChunk?.prompt_eval_count,
      completionTokens: finalChunk?.eval_count
    };
  }

  private async enqueue<T>(run: () => Promise<T>): Promise<T> {`,
    'streaming response reader implementation'
  );
  await write(path, content);
}

// 3) Associate progress/inference with the current worker job.
{
  const path = 'src/progress-context.ts';
  await write(
    path,
`import { AsyncLocalStorage } from 'node:async_hooks';

import type { EngineeringProgress, ProgressReporter } from './engineering-progress.js';

interface ProgressContext {
  reporter: ProgressReporter;
  jobId?: string;
}

const storage = new AsyncLocalStorage<ProgressContext>();

export async function withProgressReporter<T>(
  reporter: ProgressReporter,
  run: () => Promise<T>,
  jobId?: string
): Promise<T> {
  return await storage.run({ reporter, jobId }, run);
}

export function reportProgress(progress: Partial<EngineeringProgress>): void {
  storage.getStore()?.reporter(progress);
}

export function currentProgressJobId(): string | undefined {
  return storage.getStore()?.jobId;
}
`
  );
}

// 4) Scheduler history hooks persist every operational transition without changing scheduling semantics.
{
  const path = 'src/worker-scheduler.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
`export interface WorkerJobContext {
  id: string;
  update(progress: Partial<WorkerJobProgress>): void;
}
`,
`export interface WorkerJobContext {
  id: string;
  update(progress: Partial<WorkerJobProgress>): void;
}

export interface WorkerSchedulerHooks {
  onJobStarted?: (job: { id: string; kind: WorkerJobKind; isolationKey: string; startedAt: string }) => void;
  onJobProgress?: (job: { id: string; kind: WorkerJobKind; isolationKey: string; progress: WorkerJobProgress }) => void;
  onJobFinished?: (job: { id: string; kind: WorkerJobKind; isolationKey: string; status: 'success' | 'error'; error?: string }) => void;
}
`,
    'scheduler hooks interface'
  );
  content = replaceOnce(
    content,
`  constructor(private readonly maxConcurrentJobs = 1) {
    if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1) {`,
`  constructor(
    private readonly maxConcurrentJobs = 1,
    private readonly hooks: WorkerSchedulerHooks = {}
  ) {
    if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1) {`,
    'scheduler hooks constructor'
  );
  content = replaceOnce(
    content,
`    job.progress = {
      ...job.progress,
      ...patch,
      files: patch.files ? [...patch.files] : job.progress.files,
      completedSteps: patch.completedSteps ? [...patch.completedSteps] : job.progress.completedSteps,
      updatedAt: new Date().toISOString()
    };
  }`,
`    job.progress = {
      ...job.progress,
      ...patch,
      files: patch.files ? [...patch.files] : job.progress.files,
      completedSteps: patch.completedSteps ? [...patch.completedSteps] : job.progress.completedSteps,
      updatedAt: new Date().toISOString()
    };
    this.hooks.onJobProgress?.({
      id: job.id,
      kind: job.kind,
      isolationKey: job.isolationKey,
      progress: cloneProgress(job.progress)
    });
  }`,
    'scheduler progress hook'
  );
  content = replaceOnce(
    content,
`      this.activeIsolationKeys.add(job.isolationKey);

      const context: WorkerJobContext = {`,
`      this.activeIsolationKeys.add(job.isolationKey);
      this.hooks.onJobStarted?.({
        id: job.id,
        kind: job.kind,
        isolationKey: job.isolationKey,
        startedAt: new Date(this.active.get(job.id)?.startedAt ?? Date.now()).toISOString()
      });

      const context: WorkerJobContext = {`,
    'scheduler start hook'
  );
  content = replaceOnce(
    content,
`      void withProgressReporter(context.update, () => job.run(context))
        .then(job.resolve, job.reject)
        .finally(() => {`,
`      void withProgressReporter(context.update, () => job.run(context), job.id)
        .then(
          (value) => {
            this.hooks.onJobFinished?.({
              id: job.id,
              kind: job.kind,
              isolationKey: job.isolationKey,
              status: 'success'
            });
            job.resolve(value);
          },
          (error: unknown) => {
            this.hooks.onJobFinished?.({
              id: job.id,
              kind: job.kind,
              isolationKey: job.isolationKey,
              status: 'error',
              error: error instanceof Error ? error.message : String(error)
            });
            job.reject(error);
          }
        )
        .finally(() => {`,
    'scheduler completion hook and job context'
  );
  await write(path, content);
}

// 5) Worker: persistent history hooks, exact sent prompts/outputs, and history API.
{
  const path = 'src/worker-server.ts';
  let content = await read(path);
  content = replaceOnce(content, "import os from 'node:os';", "import os from 'node:os';\nimport path from 'node:path';", 'worker path import');
  content = replaceOnce(
    content,
`import { getMachineStatus } from './machine-status.js';
import { OllamaClient } from './ollama.js';`,
`import { getMachineStatus } from './machine-status.js';
import { OllamaClient, preparePromptForInference } from './ollama.js';
import { currentProgressJobId } from './progress-context.js';`,
    'worker inference imports'
  );
  content = replaceOnce(
    content,
`import { WorkerScheduler } from './worker-scheduler.js';
import { withWorkerWorkspace } from './worker-workspace.js';

const WORKER_VERSION = '0.12.1';
const config = loadConfig();
const ollama = new OllamaClient(config);
const scheduler = new WorkerScheduler(config.workerMaxConcurrentJobs ?? 1);
const inferenceTracker = new WorkerInferenceTracker();`,
`import { WorkerScheduler } from './worker-scheduler.js';
import { WorkerHistoryStore } from './worker-history.js';
import { withWorkerWorkspace } from './worker-workspace.js';

const WORKER_VERSION = '0.13.0';
const config = loadConfig();
const ollama = new OllamaClient(config);
const history = new WorkerHistoryStore(path.join(config.workerStatePath, 'history'), 200);
const historyFailure = (error: unknown): void => {
  console.error(`local-coder history write failed: ${error instanceof Error ? error.message : String(error)}`);
};
const scheduler = new WorkerScheduler(config.workerMaxConcurrentJobs ?? 1, {
  onJobStarted: (job) => void history.startRun(job).catch(historyFailure),
  onJobProgress: (job) => void history.recordProgress(job.id, job.progress).catch(historyFailure),
  onJobFinished: (job) => void history.finishRun(job.id, job.status, job.error).catch(historyFailure)
});
const inferenceTracker = new WorkerInferenceTracker();`,
    'worker history initialization'
  );
  content = replaceOnce(
    content,
`  const [systemPrompt, userPrompt, , runtime] = args;
  const stage = classifyInferenceStage(systemPrompt);
  const inferenceId = inferenceTracker.begin(stage, runtime?.model ?? config.model);
  reportProgress(progressAtInferenceStart(stage, userPrompt));
  try {
    const generation = await baseChat(...args);`,
`  const [systemPrompt, userPrompt, format, runtime] = args;
  const stage = classifyInferenceStage(systemPrompt);
  const model = runtime?.model ?? config.model;
  const preparedPrompt = preparePromptForInference(
    systemPrompt,
    userPrompt,
    runtime?.numCtx ?? config.ollamaNumCtx ?? 16_384
  );
  const jobId = currentProgressJobId();
  const inferenceId = inferenceTracker.begin(stage, model);
  reportProgress(progressAtInferenceStart(stage, preparedPrompt.userPrompt));
  if (jobId) {
    await history.appendEvent(jobId, {
      type: 'model-input',
      title: `${stage} prompt sent to Qwen`,
      stage,
      model,
      systemPrompt,
      userPrompt: preparedPrompt.userPrompt,
      promptTruncated: preparedPrompt.truncated,
      originalUserPromptChars: preparedPrompt.originalUserPromptChars,
      data: { format: format ?? null, thinking: runtime?.think ?? null }
    }).catch(historyFailure);
  }
  try {
    const generation = await baseChat(...args);`,
    'record model input'
  );
  content = replaceOnce(
    content,
`    inferenceTracker.complete(inferenceId, 'success', {
      promptTokens: generation.promptTokens,
      completionTokens: generation.completionTokens
    });
    reportProgress(progressFromInferenceResult(stage, generation.content));
    return generation;`,
`    inferenceTracker.complete(inferenceId, 'success', {
      promptTokens: generation.promptTokens,
      completionTokens: generation.completionTokens
    });
    if (jobId) {
      await history.appendEvent(jobId, {
        type: 'model-output',
        title: `${stage} output`,
        stage,
        model: generation.model,
        output: generation.content,
        promptTokens: generation.promptTokens,
        completionTokens: generation.completionTokens,
        durationMs: generation.totalDurationNs ? generation.totalDurationNs / 1_000_000 : undefined
      }).catch(historyFailure);
    }
    reportProgress(progressFromInferenceResult(stage, generation.content));
    return generation;`,
    'record model output'
  );
  content = replaceOnce(
    content,
`    inferenceTracker.complete(inferenceId, 'error', { error: message });
    reportProgress({`,
`    inferenceTracker.complete(inferenceId, 'error', { error: message });
    if (jobId) {
      await history.appendEvent(jobId, {
        type: 'error',
        title: `${stage} inference failed`,
        stage,
        model,
        error: message
      }).catch(historyFailure);
    }
    reportProgress({`,
    'record model error'
  );
  content = replaceOnce(
    content,
`  const output = await scheduler.enqueue('engineer', isolationKey(request.workspace), (job) => {
    job.update({`,
`  const output = await scheduler.enqueue('engineer', isolationKey(request.workspace), async (job) => {
    await history.annotateRun(job.id, {
      goal: request.input.goal,
      repositoryUrl: request.workspace.repositoryUrl
    }).catch(historyFailure);
    await history.appendEvent(job.id, {
      type: 'request',
      title: 'local_engineer request',
      data: {
        goal: request.input.goal,
        context: request.input.context ?? null,
        constraints: request.input.constraints ?? [],
        language: request.input.language ?? null,
        claudeGuidance: request.input.claudeGuidance ?? null,
        maxRepairRounds: request.input.maxRepairRounds ?? null,
        repositoryUrl: request.workspace.repositoryUrl,
        baseSha: request.workspace.baseSha
      }
    }).catch(historyFailure);
    job.update({`,
    'annotate engineer history'
  );
  content = replaceOnce(
    content,
`      return executeLocalEngineerWithRepoIntelligence(ollama, config, {
        ...request.input,
        workspace,
        repoMemoryScopeKey: request.workspace.memoryScopeKey
      });
    });
  });`,
`      return await executeLocalEngineerWithRepoIntelligence(ollama, config, {
        ...request.input,
        workspace,
        repoMemoryScopeKey: request.workspace.memoryScopeKey
      });
    });
  });`,
    'await engineer execution'
  );
  content = replaceOnce(
    content,
`  if (request.method === 'GET' && request.url === '/v1/status') {
    await status(response);
    return;
  }

  if (request.method !== 'POST') {`,
`  if (request.method === 'GET' && request.url === '/v1/status') {
    await status(response);
    return;
  }
  if (request.method === 'GET' && request.url?.startsWith('/v1/history')) {
    const url = new URL(request.url, 'http://local-coder-worker');
    if (url.pathname === '/v1/history') {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      json(response, 200, {
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        runs: await history.listRuns(Number.isFinite(limit) ? limit : 50)
      });
      return;
    }
    const match = /^\\/v1\\/history\\/([A-Za-z0-9-]{1,100})$/.exec(url.pathname);
    if (match) {
      const run = await history.readRun(match[1]);
      if (!run) {
        json(response, 404, { protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, error: 'History run not found.' });
        return;
      }
      json(response, 200, { protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION, run });
      return;
    }
  }

  if (request.method !== 'POST') {`,
    'history GET routes'
  );
  await write(path, content);
}

// 6) Dashboard server proxies history without exposing the bearer token to browser JS.
{
  const path = 'scripts/dashboard.mjs';
  let content = await read(path);
  content = replaceOnce(
    content,
`async function statusPayload() {`,
`async function workerGet(pathname) {
  const { workerUrl, token } = await loadConnection();
  const response = await fetch(`${workerUrl}${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? `Worker returned HTTP ${response.status}`);
  return body;
}

async function statusPayload() {`,
    'dashboard worker GET helper'
  );
  content = replaceOnce(
    content,
`    if (request.method === 'GET' && request.url === '/api/status') {
      try {
        sendJson(response, 200, await statusPayload());
      } catch (error) {
        sendJson(response, 503, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
    if (request.method === 'GET') {`,
`    if (request.method === 'GET' && request.url === '/api/status') {
      try {
        sendJson(response, 200, await statusPayload());
      } catch (error) {
        sendJson(response, 503, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/history')) {
      try {
        const url = new URL(request.url, `http://${host}:${port}`);
        const suffix = url.pathname.slice('/api/history'.length);
        if (suffix && !/^\\/[A-Za-z0-9-]{1,100}$/.test(suffix)) {
          sendJson(response, 400, { error: 'Invalid history id.' });
          return;
        }
        sendJson(response, 200, await workerGet(`/v1/history${suffix}${url.search}`));
      } catch (error) {
        sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'GET') {`,
    'dashboard history proxy routes'
  );
  await write(path, content);
}

// 7) Mount the read-only history UI into the existing React control plane.
{
  const path = 'dashboard/src/App.tsx';
  let content = await read(path);
  content = replaceOnce(
    content,
`import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';`,
`import { Progress } from '@/components/ui/progress';
import { HistoryPanel } from '@/HistoryPanel';
import { cn } from '@/lib/utils';`,
    'HistoryPanel import'
  );
  content = replaceOnce(
    content,
`        </section>
      </main>
    </div>
  );
}`,
`        </section>

        <HistoryPanel />
      </main>
    </div>
  );
}`,
    'HistoryPanel mount'
  );
  await write(path, content);
}

// 8) Update tests for medium planning and ensure transport failures are not retried.
{
  const path = 'test/local-engineer.test.ts';
  let content = await read(path);
  content = replaceOnce(
    content,
`    assert.equal(reasoningCalls.length, 3);
    assert.ok(reasoningCalls.every((call) => call.runtime.think === 'high'));`,
`    assert.equal(reasoningCalls.length, 3);
    assert.equal(reasoningCalls[0]?.runtime.think, 'high');
    assert.equal(reasoningCalls[1]?.runtime.think, 'medium');
    assert.equal(reasoningCalls[2]?.runtime.think, 'high');`,
    'planning effort expectation'
  );
  content += `\n\ntest('does not retry a transport failure as if it were invalid structured output', async () => {\n  await withWorkspace(async (workspace, stateRoot) => {\n    let calls = 0;\n    const model = {\n      async chat(): Promise<OllamaGeneration> {\n        calls += 1;\n        if (calls === 1) return generation(investigation());\n        throw new Error('transport timeout');\n      }\n    };\n\n    await assert.rejects(\n      () => executeLocalEngineer(model as never, config(stateRoot), { workspace, goal: 'Make one safe improvement.' }),\n      /transport timeout/\n    );\n    assert.equal(calls, 2, 'investigation plus exactly one planning attempt');\n  });\n});\n`;
  await write(path, content);
}

// 9) Version bump.
{
  const path = 'package.json';
  let content = await read(path);
  content = replaceOnce(content, '"version": "0.12.1"', '"version": "0.13.0"', 'package version');
  await write(path, content);
}

console.log('Applied Local Coder planning resilience + persistent history changes.');
