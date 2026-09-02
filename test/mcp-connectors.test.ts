import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClaudeMcpList, parseCodexMcpList, validateMcpName, validateRemoteMcpInput } from '../src/mcp-connectors.js';

test('Claude connector discovery normalizes provider-managed health states', () => {
  const connectors = parseClaudeMcpList(`Checking MCP server health…
claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected
claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication
claude.ai Broken: https://mcp.example.test/mcp - ✘ Failed to connect — HTTP 502
custom: connected`);
  assert.deepEqual(connectors.map(({ name, status, managed, removable }) => ({ name, status, managed, removable })), [
    { name: 'Slack', status: 'connected', managed: true, removable: false },
    { name: 'Notion', status: 'needs-auth', managed: true, removable: false },
    { name: 'Broken', status: 'error', managed: true, removable: false },
    { name: 'custom', status: 'connected', managed: false, removable: true }
  ]);
});

test('Codex connector discovery consumes the official JSON listing', () => {
  const connectors = parseCodexMcpList(JSON.stringify([
    { name: 'calendar', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.example.test/mcp' }, auth_status: 'authenticated' },
    { name: 'local', enabled: false, disabled_reason: 'Disabled by user', transport: { type: 'stdio', command: 'node' }, auth_status: 'unsupported' }
  ]));
  assert.deepEqual(connectors.map(({ name, transport, status, target }) => ({ name, transport, status, target })), [
    { name: 'calendar', transport: 'http', status: 'connected', target: 'https://mcp.example.test/mcp' },
    { name: 'local', transport: 'stdio', status: 'disabled', target: 'node' }
  ]);
});

test('remote MCP validation rejects credential-bearing and non-HTTPS URLs', () => {
  assert.deepEqual(validateRemoteMcpInput('trusted-mcp', 'https://mcp.example.test/mcp'), { name: 'trusted-mcp', url: 'https://mcp.example.test/mcp' });
  assert.throws(() => validateRemoteMcpInput('../unsafe', 'https://mcp.example.test/mcp'), /connector name/i);
  assert.throws(() => validateRemoteMcpInput('unsafe', 'http://mcp.example.test/mcp'), /HTTPS/i);
  assert.throws(() => validateRemoteMcpInput('unsafe', 'https://user:pass@mcp.example.test/mcp'), /credentials/i);
  assert.throws(() => validateRemoteMcpInput('unsafe', 'https://mcp.example.test/mcp?token=secret'), /query parameters/i);
});

test('provider-managed connector names may contain spaces but never option or control injection', () => {
  assert.equal(validateMcpName('Google Drive'), 'Google Drive');
  assert.equal(validateMcpName('Salesforce – Sandbox'), 'Salesforce – Sandbox');
  assert.throws(() => validateMcpName('--help'), /invalid connector name/i);
  assert.throws(() => validateMcpName('unsafe\nname'), /invalid connector name/i);
});
