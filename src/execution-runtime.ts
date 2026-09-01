import type { LocalCoderConfig } from './config.js';
import {
  executeAgenticCodeTask,
  type AgenticCodeTask,
  type AgenticExecutionResult
} from './executor.js';
import type {
  LocalEngineerEscalation,
  LocalEngineerResult
} from './local-engineer.js';
import type { OllamaClient, OllamaGeneration } from './ollama.js';
import {
  executeLocalCodePlan,
  type LocalExecutionPlan,
  type LocalExecutionPlanResult
} from './orchestrator.js';
import { executePremiumLocalAgent } from './premium-agent.js';
import {
  ProjectAwareEngineerBackend,
  type ProjectEngineerInput,
  type ProjectEscalationChoice,
  type ProjectEscalationGuidance,
  type ProjectEscalationPlan
} from './project-engineer-backend.js';
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
  executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult>;
  prepareEscalation?(
    input: ProjectEngineerInput,
    escalation: LocalEngineerEscalation
  ): Promise<ProjectEscalationPlan>;
  consultEscalation?(
    input: ProjectEngineerInput,
    escalation: LocalEngineerEscalation,
    choice: ProjectEscalationChoice
  ): Promise<ProjectEscalationGuidance>;
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

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    const { projectId: _projectId, ...legacyInput } = input;
    return (await executePremiumLocalAgent(this.ollama, this.config, legacyInput)).result;
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

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    const { projectId: _projectId, ...legacyInput } = input;
    try {
      return await this.remote.executeEngineer(legacyInput);
    } catch (error) {
      if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
      return await this.local.executeEngineer(legacyInput);
    }
  }
}

class ProjectAwareExecutionBackend implements ExecutionBackend {
  private readonly engineer: ProjectAwareEngineerBackend;

  constructor(
    private readonly legacy: ExecutionBackend,
    config: LocalCoderConfig,
    ollama: OllamaClient
  ) {
    this.engineer = new ProjectAwareEngineerBackend(config, ollama, legacy);
  }

  async executeTask(input: AgenticCodeTask): Promise<AgenticExecutionResult> {
    return await this.legacy.executeTask(input);
  }

  async executePlan(input: LocalExecutionPlan): Promise<LocalExecutionPlanResult> {
    return await this.legacy.executePlan(input);
  }

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    return await this.engineer.executeEngineer(input);
  }

  async prepareEscalation(
    input: ProjectEngineerInput,
    escalation: LocalEngineerEscalation
  ): Promise<ProjectEscalationPlan> {
    return await this.engineer.prepareEscalation(input, escalation);
  }

  async consultEscalation(
    input: ProjectEngineerInput,
    escalation: LocalEngineerEscalation,
    choice: ProjectEscalationChoice
  ): Promise<ProjectEscalationGuidance> {
    return await this.engineer.consultEscalation(input, escalation, choice);
  }
}

function projectAware(
  legacy: ExecutionBackend,
  config: LocalCoderConfig,
  ollama: OllamaClient
): ExecutionBackend {
  return new ProjectAwareExecutionBackend(legacy, config, ollama);
}

const WORKER_NOT_CONFIGURED = 'No worker URL is set. Add one in Settings → General → Windows worker.';

/**
 * Stands in for the worker until a URL exists. RemoteWorkerClient throws from
 * its constructor, and the runtime builds it in a class field initializer — so
 * an unconfigured worker used to kill the process before any window opened,
 * which also made the settings screen that fixes it unreachable. Fail per call
 * instead, with a message that says what to do.
 */
class UnconfiguredWorkerBackend implements ExecutionBackend, ChatClient {
  private fail(): never {
    throw new RemoteWorkerError(WORKER_NOT_CONFIGURED, true);
  }

  async chat(): Promise<OllamaGeneration> { return this.fail(); }
  async executeTask(): Promise<AgenticExecutionResult> { return this.fail(); }
  async executePlan(): Promise<LocalExecutionPlanResult> { return this.fail(); }
  async executeEngineer(): Promise<LocalEngineerResult> { return this.fail(); }
}

export function createExecutionRuntime(
  config: LocalCoderConfig,
  ollama: OllamaClient
): ExecutionRuntime {
  const localExecution = new LocalExecutionBackend(ollama, config);

  if (config.executionMode !== 'local' && !config.remoteWorkerUrl) {
    const unconfigured = new UnconfiguredWorkerBackend();
    return {
      mode: config.executionMode,
      chat: unconfigured,
      execution: projectAware(unconfigured, config, ollama),
      health: async () => ({
        executionMode: config.executionMode,
        workerConfigured: false,
        error: WORKER_NOT_CONFIGURED
      })
    };
  }

  if (config.executionMode === 'local') {
    return {
      mode: 'local',
      chat: ollama,
      execution: projectAware(localExecution, config, ollama),
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
      execution: projectAware(remote, config, ollama),
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
    execution: projectAware(autoExecution, config, ollama),
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
