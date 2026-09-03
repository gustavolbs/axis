import { AgentProviderProtocolError } from '../agent-runtime/index.js';

/**
 * Current `codex exec` has no proven switch that removes every model-visible
 * core tool. In particular, disabling the stable shell tool and using a
 * read-only sandbox does not prove that model-dependent core tools such as
 * apply_patch are absent. Until Axis can intercept Codex tool calls before the
 * CLI executes them (for example through a native app-server bridge), Account
 * execution must not enter the canonical runtime through this path.
 */
export const CODEX_ACCOUNT_AGENT_BLOCKER =
  'ChatGPT/Codex Account cannot enter AgentRuntime through codex exec because the current CLI has no proven all-tools-disabled mode. read-only sandbox and shell_tool=false are insufficient: model-dependent core tools such as apply_patch can remain provider-managed. A native Codex protocol adapter must intercept tool calls before execution.';

export function createChatGptAccountAgentAdapter(): never {
  throw new AgentProviderProtocolError(CODEX_ACCOUNT_AGENT_BLOCKER);
}
