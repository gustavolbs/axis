import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalCoderConfig } from '../src/config.js';
import type { LocalEngineerResult } from '../src/local-engineer.js';
import type { OllamaClient, OllamaGeneration } from '../src/ollama.js';
import { executePremiumLocalAgent } from '../src/premium-agent.js';
import type { ProjectEngineerInput } from '../src/project-engineer-backend.js';
import { StandaloneJobManager } from '../src/standalone-job-manager.js';

const lf = (source: string) => source.replace(/\r\n/g, '\n');

function success(goal: string, summary: string): LocalEngineerResult {
  return {
    status: 'success',
    phase: 'complete',
    workspace: '',
    goal,
    summary,
    investigation: { searchQueries: [], evidenceFiles: [], researchRequests: [] },
    repairRounds: 0,
    changedFiles: [],
    diff: '',
    validation: [],
    modelCalls: []
  };
}

async function waitForTerminal(manager: StandaloneJobManager, id: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = manager.get(id);
    if (!job) throw new Error('Job disappeared while waiting.');
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for chat job.');
}

async function waitForStatus(manager: StandaloneJobManager, id: string, status: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = manager.get(id);
    if (!job) throw new Error('Job disappeared while waiting.');
    if (job.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for status ${status}.`);
}

test('a follow-up appends turns to the same chat job and creates no second job', async () => {
  const calls: ProjectEngineerInput[] = [];
  const manager = new StandaloneJobManager({
    executeEngineer: async (input) => {
      calls.push(input);
      if (input.goal === 'Meu nome é Gustavo.') return success(input.goal, 'Prazer, Gustavo.');
      return success(input.goal, 'Seu nome é Gustavo.');
    }
  });

  const created = manager.create({
    workspace: '',
    goal: 'Meu nome é Gustavo.',
    interactionMode: 'chat'
  });
  const first = await waitForTerminal(manager, created.id);
  assert.equal(first.status, 'success');
  assert.deepEqual(first.turns.map((turn) => [turn.role, turn.content]), [
    ['user', 'Meu nome é Gustavo.'],
    ['assistant', 'Prazer, Gustavo.']
  ]);

  const followUp = await manager.followUp(created.id, 'Qual é meu nome?');
  assert.equal(followUp.id, created.id);
  const finished = await waitForTerminal(manager, created.id);

  assert.equal(manager.list().length, 1);
  assert.equal(finished.id, created.id);
  assert.equal(finished.rounds, 1, 'chat turns must not accumulate Cowork resume rounds');
  assert.deepEqual(finished.turns.map((turn) => [turn.role, turn.content]), [
    ['user', 'Meu nome é Gustavo.'],
    ['assistant', 'Prazer, Gustavo.'],
    ['user', 'Qual é meu nome?'],
    ['assistant', 'Seu nome é Gustavo.']
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].chatHistory, [
    { role: 'user', content: 'Meu nome é Gustavo.' },
    { role: 'assistant', content: 'Prazer, Gustavo.' }
  ]);
  assert.equal(calls[1].goal, 'Qual é meu nome?');
});

test('edit and resend replay a prior user turn in the same linear chat job', async () => {
  const calls: ProjectEngineerInput[] = [];
  const manager = new StandaloneJobManager({
    executeEngineer: async (input) => {
      calls.push(input);
      return success(input.goal, `answer:${input.goal}`);
    }
  });

  const created = manager.create({ workspace: '', goal: 'first', interactionMode: 'chat' });
  let job = await waitForTerminal(manager, created.id);
  await manager.followUp(created.id, 'second');
  job = await waitForTerminal(manager, created.id);
  assert.equal(job.turns.length, 4);

  const firstTurn = job.turns[0]!;
  const edited = await manager.retryTurn(created.id, firstTurn.id, 'first edited');
  assert.equal(edited.id, created.id);
  assert.deepEqual(edited.turns.map((turn) => [turn.role, turn.content]), [
    ['user', 'first edited']
  ], 'editing discards all later turns before replay');
  job = await waitForTerminal(manager, created.id);
  assert.deepEqual(job.turns.map((turn) => [turn.role, turn.content]), [
    ['user', 'first edited'],
    ['assistant', 'answer:first edited']
  ]);
  assert.equal(calls.at(-1)?.goal, 'first edited');
  assert.deepEqual(calls.at(-1)?.chatHistory, []);

  const replayTurn = job.turns[0]!;
  const resent = await manager.retryTurn(created.id, replayTurn.id);
  assert.equal(resent.id, created.id);
  assert.deepEqual(resent.turns.map((turn) => [turn.role, turn.content]), [['user', 'first edited']]);
  job = await waitForTerminal(manager, created.id);
  assert.equal(manager.list().length, 1);
  assert.deepEqual(job.turns.map((turn) => [turn.role, turn.content]), [
    ['user', 'first edited'],
    ['assistant', 'answer:first edited']
  ]);
});

test('follow-up rejects Cowork and rejects Chat while it is running or waiting', async () => {
  const manager = new StandaloneJobManager({
    executeEngineer: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return success(input.goal, 'ok');
    }
  });

  const cowork = manager.create({
    workspace: '/tmp',
    goal: 'Do work',
    interactionMode: 'cowork'
  });
  await assert.rejects(manager.followUp(cowork.id, 'continue'), /only for Chat conversations/);

  const chat = manager.create({ workspace: '', goal: 'hello', interactionMode: 'chat' });
  await waitForStatus(manager, chat.id, 'running');
  await assert.rejects(manager.followUp(chat.id, 'too soon'), /status is running/);
  await waitForTerminal(manager, chat.id);

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-chat-waiting-'));
  try {
    const now = new Date().toISOString();
    await fs.writeFile(path.join(stateDir, 'jobs.json'), JSON.stringify([{
      id: 'waiting-chat',
      status: 'waiting-guidance',
      createdAt: now,
      updatedAt: now,
      input: { workspace: '', goal: 'hello', interactionMode: 'chat' },
      turns: [{ id: 'u1', role: 'user', content: 'hello', createdAt: now }],
      rounds: 1,
      events: []
    }]), 'utf8');
    const restored = new StandaloneJobManager({ executeEngineer: async () => success('x', 'y') }, stateDir);
    await restored.restore();
    await assert.rejects(restored.followUp('waiting-chat', 'continue'), /status is waiting-guidance/);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('direct chat receives the earlier conversation turns in its bounded prompt', async () => {
  let prompt = '';
  const model: Pick<OllamaClient, 'chat'> = {
    async chat(_systemPrompt, userPrompt, _format, runtime): Promise<OllamaGeneration> {
      prompt = userPrompt;
      assert.equal(runtime?.think, 'low');
      return { model: 'qwen3.8:27b', content: 'Seu nome é Gustavo.' } as OllamaGeneration;
    }
  };
  const config = {
    model: 'qwen3.8:27b',
    ollamaNumCtx: 16_384,
    fastModelKeepAlive: '90s',
    reportMaxTokens: 3_072
  } as LocalCoderConfig;

  const result = await executePremiumLocalAgent(model, config, {
    interactionMode: 'chat',
    workspace: '',
    goal: 'Qual é meu nome?',
    chatHistory: [
      { role: 'user', content: 'Meu nome é Gustavo.' },
      { role: 'assistant', content: 'Prazer, Gustavo.' }
    ]
  });

  assert.equal(result.result.summary, 'Seu nome é Gustavo.');
  assert.match(prompt, /# CONVERSATION HISTORY/);
  assert.match(prompt, /USER:\nMeu nome é Gustavo\./);
  assert.match(prompt, /ASSISTANT:\nPrazer, Gustavo\./);
  assert.match(prompt, /# CURRENT USER MESSAGE\nQual é meu nome\?/);
});

test('jobs persisted before turns existed migrate Chat without changing Cowork rendering', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-chat-migration-'));
  try {
    const createdAt = '2026-08-31T10:00:00.000Z';
    const updatedAt = '2026-08-31T10:00:03.000Z';
    await fs.writeFile(path.join(stateDir, 'jobs.json'), JSON.stringify([
      {
        id: 'legacy-chat',
        status: 'success',
        createdAt,
        updatedAt,
        input: { workspace: '', goal: 'Oi', interactionMode: 'chat' },
        result: success('Oi', 'Olá!'),
        rounds: 1,
        events: []
      },
      {
        id: 'legacy-cowork',
        status: 'success',
        createdAt,
        updatedAt,
        input: { workspace: '/tmp', goal: 'Faça a tarefa', interactionMode: 'cowork' },
        result: { ...success('Faça a tarefa', 'Tarefa concluída.'), workspace: '/tmp' },
        rounds: 1,
        events: []
      }
    ]), 'utf8');

    const manager = new StandaloneJobManager({ executeEngineer: async () => success('unused', 'unused') }, stateDir);
    await manager.restore();
    const chat = manager.get('legacy-chat');
    assert.ok(chat);
    assert.deepEqual(chat.turns.map((turn) => [turn.role, turn.content]), [
      ['user', 'Oi'],
      ['assistant', 'Olá!']
    ]);

    const cowork = manager.get('legacy-cowork');
    assert.ok(cowork);
    assert.deepEqual(cowork.turns.map((turn) => [turn.role, turn.content]), [
      ['user', 'Faça a tarefa']
    ], 'Cowork keeps rendering result.summary from ResultMessage, not from a synthetic turn');
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('button and Enter share the same send branch while Shift+Enter preserves a newline', async () => {
  const surface = lf(await fs.readFile(path.join(process.cwd(), 'app/src/AgentSurfaceV2.tsx'), 'utf8'));
  const runtime = lf(await fs.readFile(path.join(process.cwd(), 'src/app-runtime.ts'), 'utf8'));

  const send = surface.slice(
    surface.indexOf('async function sendCurrentMessage'),
    surface.indexOf('async function retryRuntime')
  );
  assert.match(send, /active\?\.input\.interactionMode === 'chat'/);
  assert.match(send, /followUpChat\(\)/);
  assert.match(send, /createJob\(\)/);
  assert.match(send, /retryChatTurn\(editingTurnId/);

  const keyboard = surface.slice(
    surface.indexOf('function onComposerKeyDown'),
    surface.indexOf('\n\n  return <div')
  );
  assert.match(keyboard, /event\.key !== 'Enter'/);
  assert.match(keyboard, /event\.shiftKey/);
  assert.match(keyboard, /event\.nativeEvent\.isComposing/);
  assert.match(keyboard, /sendCurrentMessage\(\)/);
  assert.match(surface, /onClick=\{\(\) => void props\.sendMessage\(\)\}/);
  assert.match(surface, /job\.turns\.map/);
  assert.match(surface, /scrollIntoView/);
  assert.match(runtime, /\/jobs\\\/\(\[A-Za-z0-9-\]\+\)\\\/follow-up/);
  assert.match(runtime, /\/turns\\\/\(\[A-Za-z0-9-\]\+\)\\\/retry/);
  assert.match(runtime, /this\.jobs\.followUp/);
  assert.match(runtime, /this\.jobs\.retryTurn/);
});
