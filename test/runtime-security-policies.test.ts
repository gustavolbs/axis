import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  negotiateEffectiveCapabilities,
  type AgentDecisionRequest,
  type AgentLifecycleEvent,
  type AgentSessionContext,
  type ToolDefinition,
  type ToolPermissionRequest
} from '../src/agent-runtime/index.js';
import { StaticBrowserNavigationPolicy } from '../src/agent-tools/browser/index.js';
import {
  assertMcpServerAuthorized,
  type McpServerConfig
} from '../src/agent-tools/mcp/index.js';
import { sanitizeProcessEnvironment } from '../src/agent-tools/process/environment.js';
import { redactProjectMemoryText } from '../src/project-memory/redaction.js';
import {
  RuntimePolicyEngine,
  RuntimePolicyPermissionGate,
  RuntimePolicyStore,
  assertTrustedPolicyOverride,
  buildEffectiveRuntimeContext,
  redactAgentLifecycleEvent,
  redactRuntimeValue,
  runtimeSecureFetch,
  type RuntimeSessionPolicyOverride
} from '../src/runtime-security/index.js';

function session(input: {
  sessionId?: string;
  companyId?: string;
  projectId?: string;
  sharedLocalConnection?: boolean;
} = {}): AgentSessionContext {
  const companyId = input.companyId ?? 'company-a';
  const projectId = input.projectId ?? 'project-a';
  return {
    sessionId: input.sessionId ?? 'session-a',
    companyId,
    project: { id: projectId, companyId },
    connection: {
      id: 'ollama',
      providerFamily: 'ollama',
      authKind: 'local',
      companyId: input.sharedLocalConnection === false ? companyId : null
    },
    modelId: 'qwen-test',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [{
      id: `root:${projectId}`,
      path: `/workspace/${projectId}`,
      access: 'write',
      companyId,
      projectId
    }],
    permissions: { default: 'granted', entries: {} },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{ source: 'runtime-security-test', ids: ['axis.process.exec', 'axis.filesystem.read', 'axis.browser.navigate'] }]
    }),
    resources: []
  };
}

const processTool: ToolDefinition = {
  name: 'process_exec',
  description: 'Execute a process for policy testing.',
  inputSchema: { type: 'object', additionalProperties: true },
  requiredCapabilities: ['axis.process.exec'],
  requiredPermissions: [],
  effect: 'command',
  mutationRisk: 'possible',
  retryOnFailure: 'never'
};

const destructiveProcessTool: ToolDefinition = {
  ...processTool,
  name: 'process_exec_destructive',
  mutationRisk: 'definite'
};

function request(
  context: AgentSessionContext,
  args: Readonly<Record<string, unknown>>,
  tool: ToolDefinition = processTool,
  callId = 'call-1'
): ToolPermissionRequest {
  return {
    session: context,
    tool,
    call: { id: callId, name: tool.name, arguments: args }
  };
}

function temporaryPolicyStore(label: string): { store: RuntimePolicyStore; cleanup: () => void } {
  const directory = path.join(os.tmpdir(), `axis-runtime-security-${label}-${randomUUID()}`);
  const store = new RuntimePolicyStore(path.join(directory, 'policies.json'));
  return { store, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function approvalRequest(id: string, callId: string): AgentDecisionRequest {
  return {
    id,
    kind: 'permission',
    prompt: 'Approve this operation?',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' }
    ],
    metadata: { callId }
  };
}

test('1. Company policies are isolated from other Companies', () => {
  const { store, cleanup } = temporaryPolicyStore('company-isolation');
  try {
    store.setCompany('company-a', {
      mode: 'full-access',
      rules: [{ id: 'deny-a-test', effect: 'deny', domain: 'process', match: 'npm test' }]
    });
    store.setCompany('company-b', { mode: 'full-access' });
    const engine = new RuntimePolicyEngine(store);

    assert.equal(engine.evaluate(request(session({ companyId: 'company-a' }), { command: 'npm', args: ['test'] })).effect, 'deny');
    assert.equal(engine.evaluate(request(session({ companyId: 'company-b', projectId: 'project-b' }), { command: 'npm', args: ['test'] })).effect, 'allow');
  } finally { cleanup(); }
});

test('2. Project override cannot widen a Company deny', () => {
  const { store, cleanup } = temporaryPolicyStore('project-monotonic');
  try {
    store.setCompany('company-a', {
      mode: 'full-access',
      rules: [{ id: 'company-deny-install', effect: 'deny', domain: 'process', match: 'npm install' }]
    });
    store.setProject('company-a', 'project-a', {
      mode: 'full-access',
      rules: [{ id: 'project-allow-install', effect: 'allow', domain: 'process', match: 'npm install' }]
    });
    const decision = new RuntimePolicyEngine(store).evaluate(request(session(), { command: 'npm', args: ['install'] }));
    assert.equal(decision.effect, 'deny');
    assert.deepEqual(new Set(decision.matchedRuleIds), new Set(['company-deny-install', 'project-allow-install']));
  } finally { cleanup(); }
});

test('3. Session override cannot widen Project or Company authority', () => {
  const { store, cleanup } = temporaryPolicyStore('session-monotonic');
  try {
    store.setCompany('company-a', { mode: 'auto' });
    store.setProject('company-a', 'project-a', {
      mode: 'workspace-write',
      rules: [{ id: 'project-deny-rm', effect: 'deny', domain: 'process', match: 'rm *' }]
    });
    const override: RuntimeSessionPolicyOverride = {
      source: 'trusted-session-config',
      mode: 'full-access',
      rules: [{ id: 'session-allow-rm', effect: 'allow', domain: 'process', match: 'rm *' }]
    };
    const decision = new RuntimePolicyEngine(store).evaluate(
      request(session(), { command: 'rm', args: ['-rf', 'dist'] }, destructiveProcessTool),
      override
    );
    assert.equal(decision.mode, 'workspace-write');
    assert.equal(decision.effect, 'deny');
  } finally { cleanup(); }
});

test('4. Deny wins over allow and ask at the same effective scope', () => {
  const { store, cleanup } = temporaryPolicyStore('deny-wins');
  try {
    store.setCompany('company-a', {
      mode: 'full-access',
      rules: [
        { id: 'allow-lint', effect: 'allow', domain: 'process', match: 'npm run lint' },
        { id: 'ask-lint', effect: 'ask', domain: 'process', match: 'npm run lint' },
        { id: 'deny-lint', effect: 'deny', domain: 'process', match: 'npm run lint' }
      ]
    });
    assert.equal(new RuntimePolicyEngine(store).evaluate(request(session(), { command: 'npm', args: ['run', 'lint'] })).effect, 'deny');
  } finally { cleanup(); }
});

test('5. Approval is one-shot and does not cross session boundaries', async () => {
  const { store, cleanup } = temporaryPolicyStore('approval-session');
  try {
    store.setCompany('company-a', { mode: 'ask-before' });
    const gate = new RuntimePolicyPermissionGate(new RuntimePolicyEngine(store));
    const original = request(session({ sessionId: 'session-a' }), { command: 'npm', args: ['install'] });
    const first = await gate.authorize(original);
    assert.equal(first.requiresApproval, true);
    gate.remember(approvalRequest('approval-a', original.call.id), original.call);
    gate.resolve({ requestId: 'approval-a', optionId: 'approve' });

    const otherSession = request(session({ sessionId: 'session-b' }), { command: 'npm', args: ['install'] });
    const crossed = await gate.authorize(otherSession);
    assert.equal(crossed.allowed, false);
    assert.equal(crossed.requiresApproval, true);

    const approved = await gate.authorize(original);
    assert.equal(approved.allowed, true);
    const replay = await gate.authorize(original);
    assert.equal(replay.allowed, false);
    assert.equal(replay.requiresApproval, true);
  } finally { cleanup(); }
});

test('6. Approval does not cross Company boundaries', async () => {
  const { store, cleanup } = temporaryPolicyStore('approval-company');
  try {
    store.setCompany('company-a', { mode: 'ask-before' });
    store.setCompany('company-b', { mode: 'ask-before' });
    const gate = new RuntimePolicyPermissionGate(new RuntimePolicyEngine(store));
    const companyA = request(session({ sessionId: 'session-a', companyId: 'company-a' }), { command: 'npm', args: ['install'] });
    await gate.authorize(companyA);
    gate.remember(approvalRequest('approval-a', companyA.call.id), companyA.call);
    gate.resolve({ requestId: 'approval-a', optionId: 'approve' });

    const companyB = request(session({ sessionId: 'session-b', companyId: 'company-b', projectId: 'project-b' }), { command: 'npm', args: ['install'] });
    const crossed = await gate.authorize(companyB);
    assert.equal(crossed.allowed, false);
    assert.equal(crossed.requiresApproval, true);
  } finally { cleanup(); }
});

test('7. Redirects cannot bypass the outbound network boundary', async () => {
  let calls = 0;
  const mockFetch = (async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/meta-data' }
    });
  }) as typeof fetch;

  await assert.rejects(
    runtimeSecureFetch(mockFetch, 'https://public.example/start'),
    /Metadata-service targets are blocked/
  );
  assert.equal(calls, 1);
});

test('8. MCP resource owned by another Company is blocked', () => {
  const server: McpServerConfig = {
    id: 'jira-company-b',
    name: 'Jira B',
    companyId: 'company-b',
    source: { id: 'axis-owned', kind: 'axis', companyId: 'company-b' },
    transport: { kind: 'streamable-http', url: 'https://mcp.example/rpc' },
    enabled: true
  };
  const context: AgentSessionContext = {
    ...session({ companyId: 'company-a' }),
    resources: [{ kind: 'mcp', id: server.id, scope: 'project', companyId: 'company-b', projectId: 'project-a' }]
  };
  assert.throws(() => assertMcpServerAuthorized(server, context), /belongs to Company company-b/);
});

test('9. Browser blocks private, metadata and credential-bearing targets', async () => {
  const policy = new StaticBrowserNavigationPolicy();
  const scope = {
    sessionId: 'session-a',
    companyId: 'company-a',
    projectId: 'project-a',
    executionTargetId: 'desktop',
    storagePartitionKey: 'company-a/project-a/desktop',
    contextKey: 'session-a'
  };
  const privateTarget = await policy.authorize({ url: 'http://127.0.0.1:3000', reason: 'explicit', scope });
  const metadataTarget = await policy.authorize({ url: 'https://169.254.169.254/latest/meta-data', reason: 'redirect', scope });
  const credentialTarget = await policy.authorize({ url: 'https://user:password@example.com/', reason: 'explicit', scope });
  assert.equal(privateTarget.allowed, false);
  assert.equal(metadataTarget.allowed, false);
  assert.equal(metadataTarget.classification, 'metadata-service');
  assert.equal(credentialTarget.allowed, false);
  assert.equal(credentialTarget.normalizedUrl.includes('password'), false);
});

test('10. Process environment drops ambient secrets and rejects secret overrides', () => {
  const sanitized = sanitizeProcessEnvironment({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'sk-secret-value',
    GITHUB_TOKEN: 'ghp_secretvalue',
    SAFE_APP_CONFIG: 'ordinary-but-not-inherited'
  });
  assert.equal(sanitized.env.PATH, '/usr/bin');
  assert.equal('OPENAI_API_KEY' in sanitized.env, false);
  assert.equal('GITHUB_TOKEN' in sanitized.env, false);
  assert.equal('SAFE_APP_CONFIG' in sanitized.env, false);
  assert.throws(() => sanitizeProcessEnvironment({ PATH: '/usr/bin' }, { API_KEY: 'secret' }), /blocked/);
});

test('11. Lifecycle, UI-facing values and Project Memory share transversal redaction', () => {
  const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz';
  const rawEvent = {
    type: 'tool.call',
    timestamp: new Date().toISOString(),
    sessionId: 'session-a',
    turnId: 'turn-a',
    call: { id: 'call-a', name: 'probe', arguments: { authorization: `Bearer ${secret}`, password: 'hunter2', nested: { apiKey: secret } } },
    definition: processTool
  } as unknown as AgentLifecycleEvent;
  const safeEvent = redactAgentLifecycleEvent(rawEvent);
  const rendered = JSON.stringify(safeEvent);
  assert.equal(rendered.includes(secret), false);
  assert.equal(rendered.includes('hunter2'), false);
  assert.match(rendered, /REDACTED/);
  assert.equal(redactProjectMemoryText(`token=${secret}`).includes(secret), false);
  assert.equal(JSON.stringify(redactRuntimeValue({ cookie: 'session=abc', secretRef: 'vault://credential' })).includes('vault://credential'), false);
});

test('12. External/tool content cannot elevate runtime authority', () => {
  const untrusted = {
    source: 'tool-output',
    mode: 'full-access',
    rules: [{ id: 'grant-everything', effect: 'allow', domain: 'external', match: '*' }]
  } as unknown as RuntimeSessionPolicyOverride;
  assert.throws(() => assertTrustedPolicyOverride(untrusted), /External\/tool content cannot modify Axis runtime authority/);
});

test('13. Effective Context is derived from the same session and policy authority used for execution', () => {
  const { store, cleanup } = temporaryPolicyStore('effective-context');
  try {
    store.setCompany('company-a', {
      mode: 'auto',
      rules: [{ id: 'deny-rm', effect: 'deny', domain: 'process', match: 'rm *' }]
    });
    store.setProject('company-a', 'project-a', { mode: 'workspace-write' });
    const engine = new RuntimePolicyEngine(store);
    const context = session();
    const effective = buildEffectiveRuntimeContext({ session: context, policyEngine: engine });
    const decision = engine.evaluate(request(context, { command: 'rm', args: ['-rf', 'dist'] }, destructiveProcessTool));

    assert.equal(effective.sessionId, context.sessionId);
    assert.equal(effective.company.id, context.companyId);
    assert.equal(effective.project?.id, context.project?.id);
    assert.equal(effective.connection.id, context.connection.id);
    assert.equal(effective.connection.sharedLocal, true);
    assert.equal(effective.model.id, context.modelId);
    assert.equal(effective.execution.id, context.executionTarget.id);
    assert.equal(effective.authority.mode, 'workspace-write');
    assert.ok(effective.rules.some((rule) => rule.id === 'deny-rm'));
    assert.equal(decision.effect, 'deny');
  } finally { cleanup(); }
});

test('14. Shared local Connection does not become shared Company authority', () => {
  const { store, cleanup } = temporaryPolicyStore('shared-local');
  try {
    store.setCompany('company-a', {
      mode: 'full-access',
      rules: [{ id: 'a-deny-test', effect: 'deny', domain: 'process', match: 'npm test' }]
    });
    store.setCompany('company-b', { mode: 'full-access' });
    const engine = new RuntimePolicyEngine(store);
    const companyA = session({ companyId: 'company-a', sharedLocalConnection: true });
    const companyB = session({ companyId: 'company-b', projectId: 'project-b', sharedLocalConnection: true });
    assert.equal(companyA.connection.id, companyB.connection.id);
    assert.equal(companyA.connection.companyId, null);
    assert.equal(companyB.connection.companyId, null);
    assert.equal(engine.evaluate(request(companyA, { command: 'npm', args: ['test'] })).effect, 'deny');
    assert.equal(engine.evaluate(request(companyB, { command: 'npm', args: ['test'] })).effect, 'allow');
  } finally { cleanup(); }
});

test('15. Destructive operation requires appropriate authority', () => {
  const { store, cleanup } = temporaryPolicyStore('destructive');
  try {
    store.setCompany('company-a', { mode: 'workspace-write' });
    const engine = new RuntimePolicyEngine(store);
    const destructive = request(session(), { command: 'rm', args: ['-rf', 'dist'] }, destructiveProcessTool);
    assert.equal(engine.evaluate(destructive).effect, 'ask');

    store.setCompany('company-a', { mode: 'full-access' });
    assert.equal(engine.evaluate(destructive).effect, 'allow');

    store.setCompany('company-a', {
      mode: 'full-access',
      rules: [{ id: 'hard-deny-rm', effect: 'deny', domain: 'destructive', match: 'rm *' }]
    });
    assert.equal(engine.evaluate(destructive).effect, 'deny');
  } finally { cleanup(); }
});
