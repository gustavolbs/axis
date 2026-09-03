import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentProviderProtocolError } from '../src/agent-runtime/index.js';
import {
  CODEX_ACCOUNT_AGENT_BLOCKER,
  CODEX_APP_SERVER_ISOLATION_BASELINE,
  createChatGptAccountAgentAdapter
} from '../src/agent-provider-adapters/index.js';

test('Codex app-server baseline proves dynamic interception without proving an Axis-only tool catalog', () => {
  assert.equal(CODEX_APP_SERVER_ISOLATION_BASELINE.upstreamRelease, '0.153.0');
  assert.equal(CODEX_APP_SERVER_ISOLATION_BASELINE.protocol, 'app-server-v2');
  assert.equal(CODEX_APP_SERVER_ISOLATION_BASELINE.clientDynamicTools, true);
  assert.equal(CODEX_APP_SERVER_ISOLATION_BASELINE.clientToolRequestMethod, 'item/tool/call');
  assert.equal(CODEX_APP_SERVER_ISOLATION_BASELINE.exactModelVisibleToolAllowlist, false);
  assert.equal(CODEX_APP_SERVER_ISOLATION_BASELINE.dynamicToolsOnlyMode, false);
  assert.deepEqual(CODEX_APP_SERVER_ISOLATION_BASELINE.providerManagedServerRequests, [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request'
  ]);
});

test('ChatGPT/Codex Account stays fail-closed instead of treating app-server approvals as Axis ToolCalls', () => {
  assert.throws(
    () => createChatGptAccountAgentAdapter(),
    (error) => error instanceof AgentProviderProtocolError && error.message === CODEX_ACCOUNT_AGENT_BLOCKER
  );
  assert.match(CODEX_ACCOUNT_AGENT_BLOCKER, /app-server v2/);
  assert.match(CODEX_ACCOUNT_AGENT_BLOCKER, /item\/tool\/call/);
  assert.match(CODEX_ACCOUNT_AGENT_BLOCKER, /no proven all-tools-disabled mode/);
  assert.match(CODEX_ACCOUNT_AGENT_BLOCKER, /exact model-visible tool allowlist/);
  assert.match(CODEX_ACCOUNT_AGENT_BLOCKER, /apply_patch/);
  assert.match(CODEX_ACCOUNT_AGENT_BLOCKER, /MCP/);
  assert.match(CODEX_ACCOUNT_AGENT_BLOCKER, /experimental environments=\[\]/);
  assert.match(CODEX_ACCOUNT_AGENT_BLOCKER, /intercept tool calls before execution/);
});
