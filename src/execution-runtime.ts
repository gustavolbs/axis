import type { LocalCoderConfig } from './config.js';
import {
  executeAgenticCodeTask,
  type AgenticCodeTask,
  type AgenticExecutionResult
} from './executor.js';
import type {
  LocalEngineerInput,
  LocalEngineerResult
} from './local-engineer.js';
import type { OllamaClient, OllamaGeneration } from './ollama.js';
import {
  executeLocalCodePlan,
  type LocalExecutionPlan,
  type LocalExecutionPlanResult
} from './orchestrator.js';
import { executeLocalEngineerWithRepoIntelligence } from './repo-intelligence.js';
import { RemoteWorkerClient, RemoteWorkerError } from './remote-worker-client.js';

export interface ChatClient {
  chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>
  ): Promise<OllamaGeneration>;
}

export interface ExecutionBackend {
  executeTask(input: AgenticCodeTask): Promise<AgenticExecutionResult>;
  executePlan(input: LocalExecutionPlan): Promise<LocalExecutionPlanResult>;
  executeEngineer(input: LocalEngineerInput): Promise<LocalEngineerResult>;
}

export interface ExecutionRuntime {
  mode: LocalCoderConfig['executionMode'];
  chat: ChatClient;
  execution: ExecutionBackend;
  health(): Promise<Record<string, unknown>>;
}

class LocalExecutionBackend implements ExecutionBackend {
  constructor(
    private readonly ollama: OllamaClient,
    private readonly config: LocalCoderConfig
  ) {}

  async executeTask(input: AgenticCodeTask): Promise<AgenticExecutionResult> {
    return await executeAgenticCodeTask(this.ollama, this.config, input);
  }

  async executePlan(input: LocalExecutionPlan): Promise<LocalExecutionPlanResult> {
    return await executeLocalCodePlan(this.ollama, this.config, input);
  }

  async executeEngineer(input: LocalEngineerInput): Promise<LocalEngineerResult> {
    return (await executeLocalEngineerWithRepoIntelligence(this.ollama, this.config, input)).result;
  }
}

class AutoChatClient implements ChatClient {
  constructor(
    private readonly remote: RemoteWorkerClient,
    private readonly local: ChatClient
  ) {}

  async chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>
  ): Promise<OllamaGeneration> {
    try {
      return await this.remote.chat(systemPrompt, userPrompt, format);
    } catch (error) {
      if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
      return await this.local.chat(systemPrompt, userPrompt, format);
    }
  }
}

class AutoExecutionBackend implements ExecutionBackend {
  constructor(
    private readonly remote: RemoteWorkerClient,
    private readonly local: ExecutionBackend
  ) {}

  async executeTask(input: AgenticCodeTask): Promise<AgenticExecutionResult> {
    try {
      return await this.remote.executeTask(input);
    } catch (error) {
      if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
      return await this.local.executeTask(input);
    }
  }

  async executePlan(input: LocalExecutionPlan): Promise<LocalExecutionPlanResult> {
    try {
      return await this.remote.executePlan(input);
    } catch (error) {
      if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
      return await this.local.executePlan(input);
    }
  }

  async executeEngineer(input: LocalEngineerInput): Promise<LocalEngineerResult> {
    try {
      return await this.remote.executeEngineer(input);
    } catch (error) {
      if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
      return await this.local.executeEngineer(input);
    }
  }
}

export function createExecutionRuntime(
  config: LocalCoderConfig,
  ollama: OllamaClient
): ExecutionRuntime {
  const localExecution = new LocalExecutionBackend(ollama, config);

  if (config.executionMode === 'local') {
    return {
      mode: 'local',
      chat: ollama,
      execution: localExecution,
      health: async () => ({
        executionMode: 'local',
        ollama: await ollama.health()
      })
    };
  }

  const remote = new RemoteWorkerClient(config);

  if (config.executionMode === 'remote') {
    return {
      mode: 'remote',
      chat: remote,
      execution: remote,
      health: async () => ({
        executionMode: 'remote',
        workerUrl: config.remoteWorkerUrl,
        worker: await remote.health(),
        localFallbackEnabled: false
      })
    };
  }

  const autoChat = new AutoChatClient(remote, ollama);
  const autoExecution = new AutoExecutionBackend(remote, localExecution);
  return {
    mode: 'auto',
    chat: autoChat,
    execution: autoExecution,
    health: async () => {
      try {
        return {
          executionMode: 'auto',
          preferred: 'remote',
          workerUrl: config.remoteWorkerUrl,
          worker: await remote.health(),
          localFallbackEnabled: true
        };
      } catch (error) {
        if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
        return {
          executionMode: 'auto',
          preferred: 'remote',
          remoteAvailable: false,
          remoteError: error.message,
          localFallbackEnabled: true,
          ollama: await ollama.health()
        };
      }
    }
  };
}
