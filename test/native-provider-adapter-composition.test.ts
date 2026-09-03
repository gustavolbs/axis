import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ClaudeAccountAgentAdapter,
  createAgentProviderAdapterForConnection
} from '../src/agent-provider-adapters/index.js';
import { ClaudeAccountProfileStore } from '../src/claude-account-profiles.js';
import type { ProviderConnectionView } from '../src/provider-connections.js';
import type { InferenceProvider, ProviderCapabilities } from '../src/providers/types.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: true,
  toolUse: true
};

function connection(input: Partial<ProviderConnectionView> = {}): ProviderConnectionView {
  return {
    id: input.id ?? 'anthropic-api-team',
    providerFamily: input.providerFamily ?? 'anthropic',
    label: input.label ?? 'Anthropic Team',
    auth: input.auth ?? 'api-key',
    billing: input.billing ?? 'api',
    organizationId: input.organizationId ?? 'company-acme',
    organizationLabel: input.organizationLabel,
    credentialId: input.credentialId,
    accountProfileId: input.accountProfileId,
    available: input.available ?? true,
    reason: input.reason,
    supportsMcpSources: input.supportsMcpSources ?? false
  };
}

function aliasedProvider(id: string): InferenceProvider {
  return {
    id,
    kind: 'cloud',
    capabilities,
    async listModels() {
      return [{ providerId: id, id: 'model-test', displayName: 'Test' }];
    },
    async health() {
      return { providerId: id, ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 0 };
    },
    async invoke(request) {
      return {
        providerId: id,
        model: request.model,
        content: JSON.stringify({ complete: true, text: 'done', toolCalls: [] }),
        stopReason: 'complete',
        latencyMs: 0,
        usage: {}
      };
    }
  };
}

test('resolved API-key connection aliases compose through the same AgentProviderAdapter contract', () => {
  const anthropic = connection();
  const adapter = createAgentProviderAdapterForConnection({
    connection: anthropic,
    modelId: 'model-test',
    companyId: 'acme',
    provider: aliasedProvider(anthropic.id)
  });

  assert.equal(adapter.connectionId, anthropic.id);
  assert.equal(adapter.providerFamily, 'anthropic');
  assert.equal(adapter.modelId, 'model-test');
  assert.equal(adapter.capabilities.toolProtocol, 'structured-fallback');
});

test('resolved Claude Account reuses its exact account profile but not the unsafe inference wrapper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-adapter-composition-'));
  const profiles = new ClaudeAccountProfileStore(root);
  profiles.create({ id: 'team', name: 'Team Claude' });
  const claude = connection({
    id: 'claude-account-team',
    providerFamily: 'anthropic',
    auth: 'claude-account',
    billing: 'subscription',
    accountProfileId: 'team'
  });

  try {
    const adapter = createAgentProviderAdapterForConnection({
      connection: claude,
      modelId: 'sonnet',
      companyId: 'acme',
      claudeProfiles: profiles
    });
    assert.ok(adapter instanceof ClaudeAccountAgentAdapter);
    assert.equal(adapter.connectionId, 'claude-account-team');
    assert.equal(adapter.modelId, 'sonnet');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolved connection composition fails closed for missing providers and ChatGPT Account', () => {
  assert.throws(
    () => createAgentProviderAdapterForConnection({
      connection: connection(),
      modelId: 'model-test',
      companyId: 'acme'
    }),
    /requires its exact resolved inference provider/
  );

  assert.throws(
    () => createAgentProviderAdapterForConnection({
      connection: connection({
        id: 'chatgpt-team',
        providerFamily: 'openai',
        auth: 'chatgpt-account',
        billing: 'subscription',
        accountProfileId: 'team'
      }),
      modelId: 'default',
      companyId: 'acme'
    }),
    /no proven all-tools-disabled mode/
  );
});
