export interface ClaudeMcpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ClaudeConfigDocument {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ClaudeRemoteWorkerConfigInput {
  serverPath: string;
  remoteWorkerUrl: string;
  credentialRef: string;
  model: string;
}

/**
 * Builds the Claude MCP entry without embedding bearer tokens. The returned document
 * preserves unrelated Claude settings and MCP servers while replacing only local-coder.
 */
export function buildClaudeRemoteWorkerConfig(
  current: ClaudeConfigDocument,
  input: ClaudeRemoteWorkerConfigInput
): ClaudeConfigDocument {
  const existingServers =
    current.mcpServers && typeof current.mcpServers === 'object' && !Array.isArray(current.mcpServers)
      ? current.mcpServers
      : {};

  const localCoder: ClaudeMcpServerConfig = {
    type: 'stdio',
    command: process.execPath,
    args: [input.serverPath],
    env: {
      LOCAL_CODER_EXECUTION_MODE: 'remote',
      LOCAL_CODER_REMOTE_WORKER_URL: input.remoteWorkerUrl,
      LOCAL_CODER_REMOTE_WORKER_CREDENTIAL_REF: input.credentialRef,
      LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS: '7200000',
      LOCAL_CODER_REMOTE_MAX_DELTA_BYTES: '8000000',
      LOCAL_CODER_ADAPTIVE_MODELS: 'false',
      LOCAL_CODER_MODEL: input.model,
      LOCAL_CODER_FAST_MODEL: input.model,
      LOCAL_CODER_STRONG_MODEL: input.model,
      LOCAL_CODER_NUM_CTX: '16384',
      LOCAL_CODER_MAX_CONTEXT_BYTES: '96000',
      LOCAL_CODER_TIMEOUT_MS: '600000',
      LOCAL_CODER_COGNITIVE_MODE: 'adaptive',
      LOCAL_CODER_MAX_DELIBERATION_PASSES: '3',
      LOCAL_CODER_QUALITY_GATE_MIN_SCORE: '80',
      LOCAL_CODER_RESEARCH_ENABLED: 'true',
      LOCAL_CODER_MICROSOFT_LEARN_RESEARCH_ENABLED: 'true'
    }
  };

  return {
    ...current,
    mcpServers: {
      ...existingServers,
      'local-coder': localCoder
    }
  };
}
