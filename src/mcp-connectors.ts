export type McpConnectorStatus = 'connected' | 'needs-auth' | 'error' | 'disabled' | 'unknown';

export interface McpConnector {
  name: string;
  transport: 'http' | 'sse' | 'stdio' | 'websocket' | 'unknown';
  target?: string;
  status: McpConnectorStatus;
  detail?: string;
  managed: boolean;
  removable: boolean;
}

const SAFE_MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function cleanOutput(value: string): string {
  return value.replace(ANSI_ESCAPE, '').replace(/\r/g, '').trim();
}

function transportFromTarget(target: string | undefined): McpConnector['transport'] {
  if (!target) return 'unknown';
  if (/^https?:\/\//i.test(target)) return 'http';
  return 'stdio';
}

function statusFromText(value: string): McpConnectorStatus {
  if (/needs authentication|not authenticated|logged out|login required/i.test(value)) return 'needs-auth';
  if (/failed|error|unavailable|timed out|disconnected/i.test(value)) return 'error';
  if (/disabled|pending approval|paused/i.test(value)) return 'disabled';
  if (/connected|enabled|authenticated|unsupported/i.test(value)) return 'connected';
  return 'unknown';
}

export function validateRemoteMcpInput(nameValue: string, urlValue: string): { name: string; url: string } {
  const name = nameValue.trim();
  if (!SAFE_MCP_NAME.test(name) || name === '.' || name === '..') {
    throw new Error('Connector name must be 1-64 characters using letters, numbers, dots, dashes or underscores.');
  }
  let parsed: URL;
  try {
    parsed = new URL(urlValue.trim());
  } catch {
    throw new Error('Remote MCP URL must be a valid HTTPS URL.');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error('Remote MCP URL must use HTTPS and cannot contain credentials, query parameters or a fragment.');
  }
  return { name, url: parsed.toString() };
}

export function validateMcpName(nameValue: string): string {
  const name = nameValue.trim();
  if (!name || name.length > 160 || name.startsWith('-') || /[\0\r\n]/.test(name)) throw new Error('Invalid connector name.');
  return name;
}

export function parseClaudeMcpList(output: string): McpConnector[] {
  const connectors: McpConnector[] = [];
  for (const rawLine of cleanOutput(output).split('\n')) {
    const line = rawLine.trim();
    if (!line || /^checking mcp server health/i.test(line) || /^profile=/i.test(line)) continue;
    const remote = line.match(/^(claude\.ai\s+)?(.+?):\s+(https?:\/\/\S+)\s+-\s+(.+)$/i);
    if (remote) {
      const managed = Boolean(remote[1]);
      const detail = remote[4]!.trim();
      connectors.push({
        name: remote[2]!.trim(),
        transport: 'http',
        target: remote[3]!.trim(),
        status: statusFromText(detail),
        detail: detail.replace(/^[✔!✘⏸]\s*/, ''),
        managed,
        removable: !managed
      });
      continue;
    }
    const configured = line.match(/^([^:]{1,160}):\s*(.+)$/);
    if (configured) {
      const detail = configured[2]!.trim();
      const target = detail.match(/https?:\/\/\S+/)?.[0];
      connectors.push({
        name: configured[1]!.trim(),
        transport: transportFromTarget(target),
        target,
        status: statusFromText(detail),
        detail,
        managed: false,
        removable: true
      });
    }
  }
  return connectors;
}

interface CodexMcpJsonEntry {
  name?: unknown;
  enabled?: unknown;
  disabled_reason?: unknown;
  transport?: { type?: unknown; url?: unknown; command?: unknown };
  auth_status?: unknown;
}

function codexTransport(value: unknown): McpConnector['transport'] {
  if (value === 'streamable_http' || value === 'http') return 'http';
  if (value === 'sse') return 'sse';
  if (value === 'stdio') return 'stdio';
  if (value === 'websocket') return 'websocket';
  return 'unknown';
}

export function parseCodexMcpList(output: string): McpConnector[] {
  const clean = cleanOutput(output);
  try {
    const parsed = JSON.parse(clean) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.flatMap((raw): McpConnector[] => {
        const entry = raw as CodexMcpJsonEntry;
        if (typeof entry.name !== 'string' || !entry.name.trim()) return [];
        const auth = typeof entry.auth_status === 'string' ? entry.auth_status : '';
        const disabled = entry.enabled === false;
        const detail = disabled && typeof entry.disabled_reason === 'string'
          ? entry.disabled_reason
          : auth || undefined;
        return [{
          name: entry.name.trim(),
          transport: codexTransport(entry.transport?.type),
          target: typeof entry.transport?.url === 'string'
            ? entry.transport.url
            : typeof entry.transport?.command === 'string' ? entry.transport.command : undefined,
          status: disabled ? 'disabled' : statusFromText(auth || 'enabled'),
          detail,
          managed: false,
          removable: true
        }];
      });
    }
  } catch {
    // Older Codex builds do not support JSON output. Keep a conservative table parser.
  }
  const connectors: McpConnector[] = [];
  for (const line of clean.split('\n').slice(1)) {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 2 || !columns[0]) continue;
    const statusText = columns.find((column) => /enabled|disabled/i.test(column)) ?? '';
    const target = columns.find((column) => /^https?:\/\//i.test(column)) ?? columns[1];
    connectors.push({
      name: columns[0],
      transport: transportFromTarget(target),
      target,
      status: statusFromText(statusText || 'enabled'),
      detail: statusText || undefined,
      managed: false,
      removable: true
    });
  }
  return connectors;
}
