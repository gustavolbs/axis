import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withCancellationSignal } from '../src/cancellation.js';
import { ClaudeAccountProfileStore } from '../src/claude-account-profiles.js';
import { CodexAccountProfileStore, type CodexAccountRuntime } from '../src/codex-account-profiles.js';
import {
  ProviderConnectionRuntime,
  chatGptAccountConnectionId
} from '../src/provider-connections.js';

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('ChatGPT Account inference forwards the current cancellation signal to Codex', async () => {
  const codexProfiles = new CodexAccountProfileStore(temp('axis-chatgpt-cancel-codex-'));
  codexProfiles.create({ id: 'personal', name: 'ChatGPT Personal' });
  const seenSignals: Array<AbortSignal | undefined> = [];
  const codexRuntime = {
    async status(profileId: string) {
      return {
        installed: true,
        usable: true,
        version: 'test',
        profileId,
        authenticated: true,
        authMethod: 'chatgpt' as const
      };
    },
    async invoke(
      _profileId: string,
      _prompt: string,
      options: { signal?: AbortSignal } = {}
    ) {
      seenSignals.push(options.signal);
      return {
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        signal: null,
        durationMs: 1,
        timedOut: false,
        cancelled: false
      };
    }
  } as unknown as CodexAccountRuntime;
  const connections = new ProviderConnectionRuntime({
    claudeProfiles: new ClaudeAccountProfileStore(temp('axis-chatgpt-cancel-claude-')),
    codexProfiles,
    codexRuntime
  });
  const resolved = await connections.resolve(chatGptAccountConnectionId('personal'), 'default');
  const controller = new AbortController();

  const result = await withCancellationSignal(controller.signal, () => resolved.provider.invoke({
    model: 'default',
    systemPrompt: 'System',
    userPrompt: 'Hello',
    output: { type: 'text' }
  }));

  assert.equal(result.content, 'ok');
  assert.equal(seenSignals.length, 1);
  assert.equal(seenSignals[0], controller.signal);
});
