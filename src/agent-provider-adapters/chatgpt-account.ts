import { AgentProviderProtocolError } from '../agent-runtime/index.js';

/**
 * Protocol facts required to decide whether a ChatGPT/Codex Account can cross
 * the AgentProviderAdapter boundary safely.
 *
 * Axis does not vendor or pin the Codex CLI: CodexAccountRuntime discovers the
 * external `codex` binary at runtime. This baseline records the upstream stable
 * release that was inspected when this guard was last reviewed. It is evidence,
 * not a claim that every locally installed Codex binary is exactly this version.
 */
export const CODEX_APP_SERVER_ISOLATION_BASELINE = Object.freeze({
  upstreamRelease: '0.153.0',
  protocol: 'app-server-v2',
  clientDynamicTools: true,
  clientToolRequestMethod: 'item/tool/call',
  exactModelVisibleToolAllowlist: false,
  dynamicToolsOnlyMode: false,
  providerManagedServerRequests: Object.freeze([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request'
  ])
} as const);

/**
 * Codex app-server v2 exposes the interception primitive Axis needs for client
 * dynamic tools (`item/tool/call`), but the current protocol does not expose a
 * contractual dynamic-tools-only / exact model-visible tool allowlist.
 *
 * In Codex 0.153.0, core shell, file/apply_patch, MCP/resource and utility tools
 * are assembled independently from `dynamicTools`. Approval requests for those
 * provider-managed tools authorize Codex execution; they do not delegate the
 * operation to Axis as a canonical ToolCall. Therefore an app-server bridge
 * cannot yet prove the invariant `request.tools === model-visible executable
 * tools` for every Account/model/configuration.
 *
 * Axis intentionally does not treat read-only sandboxing, `approvalPolicy=never`,
 * `features.shell_tool=false`, experimental `environments=[]`, a neutral cwd, or
 * post-hoc event parsing as an isolation boundary. Those controls may reduce
 * authority, but they do not convert every provider tool into an Axis ToolCall.
 */
export const CODEX_ACCOUNT_AGENT_BLOCKER = [
  'ChatGPT/Codex Account remains fail-closed in AgentRuntime.',
  'Codex app-server v2, validated against upstream 0.153.0, can intercept client dynamic tools through item/tool/call, but it has no proven all-tools-disabled mode, exact model-visible tool allowlist, or dynamic-tools-only mode.',
  'Provider-managed core tools are assembled independently from dynamicTools; command, file/apply_patch, MCP, permission, and other native tool flows can therefore remain outside the canonical Axis ToolCall boundary.',
  'Provider approval requests authorize Codex execution rather than delegating execution to Axis.',
  'Axis will not rely on a read-only sandbox, shell_tool=false, approvalPolicy=never, experimental environments=[], a neutral cwd, or post-hoc mutation parsing as proof of isolation.',
  'A safe native adapter must intercept tool calls before execution and requires an upstream contract that makes every model-visible executable tool either an Axis dynamic tool or an equivalent client-executed request.'
].join(' ');

export function createChatGptAccountAgentAdapter(): never {
  throw new AgentProviderProtocolError(CODEX_ACCOUNT_AGENT_BLOCKER);
}
