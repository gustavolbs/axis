import fs from 'node:fs/promises';
import path from 'node:path';

export type TelemetryKind = 'classification' | 'delegation' | 'execution' | 'orchestration';

export interface TelemetryEvent {
  timestamp: string;
  kind: TelemetryKind;
  model?: string;
  route?: 'deterministic' | 'local' | 'local-supervised' | 'claude';
  status?: 'success' | 'escalated' | 'error';
  attempts?: number;
  promptTokens?: number;
  completionTokens?: number;
  generationDurationMs?: number;
  validationDurationMs?: number;
  changedFiles?: number;
  tasks?: number;
  completedTasks?: number;
}

export interface TelemetrySummary {
  since: string;
  events: number;
  classifications: {
    total: number;
    deterministic: number;
    local: number;
    localSupervised: number;
    claude: number;
  };
  delegations: {
    total: number;
    errors: number;
  };
  executions: {
    total: number;
    success: number;
    escalated: number;
    errors: number;
    successRate: number;
    retriedTasks: number;
    totalAttempts: number;
    averageAttempts: number;
    changedFiles: number;
  };
  orchestrations: {
    total: number;
    success: number;
    escalated: number;
    errors: number;
    successRate: number;
    plannedTasks: number;
    completedTasks: number;
    taskCompletionRate: number;
    averageTasksPerPlan: number;
    averageCompletedTasksPerPlan: number;
  };
  localInference: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    generationDurationMs: number;
    validationDurationMs: number;
    apiCostUsd: 0;
    costScopeNote: string;
  };
}

function safeNumber(value: number | undefined): number {
  return Number.isFinite(value) ? value ?? 0 : 0;
}

export class TelemetryStore {
  constructor(
    private readonly filePath: string,
    private readonly enabled = true
  ) {}

  async record(event: Omit<TelemetryEvent, 'timestamp'>): Promise<void> {
    if (!this.enabled) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: TelemetryEvent = { timestamp: new Date().toISOString(), ...event };
    await fs.appendFile(this.filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  }

  async summary(days = 30): Promise<TelemetrySummary> {
    const sinceDate = new Date(Date.now() - Math.max(1, days) * 86_400_000);
    const events = await this.readEvents();
    const filtered = events.filter((event) => new Date(event.timestamp) >= sinceDate);

    const classifications = filtered.filter((event) => event.kind === 'classification');
    const delegations = filtered.filter((event) => event.kind === 'delegation');
    const executions = filtered.filter((event) => event.kind === 'execution');
    const orchestrations = filtered.filter((event) => event.kind === 'orchestration');

    const success = executions.filter((event) => event.status === 'success').length;
    const escalated = executions.filter((event) => event.status === 'escalated').length;
    const executionErrors = executions.filter((event) => event.status === 'error').length;
    const totalAttempts = executions.reduce((sum, event) => sum + safeNumber(event.attempts), 0);

    const orchestrationSuccess = orchestrations.filter((event) => event.status === 'success').length;
    const orchestrationEscalated = orchestrations.filter(
      (event) => event.status === 'escalated'
    ).length;
    const orchestrationErrors = orchestrations.filter((event) => event.status === 'error').length;
    const plannedTasks = orchestrations.reduce((sum, event) => sum + safeNumber(event.tasks), 0);
    const completedTasks = orchestrations.reduce(
      (sum, event) => sum + safeNumber(event.completedTasks),
      0
    );

    const promptTokens = filtered.reduce((sum, event) => sum + safeNumber(event.promptTokens), 0);
    const completionTokens = filtered.reduce((sum, event) => sum + safeNumber(event.completionTokens), 0);

    return {
      since: sinceDate.toISOString(),
      events: filtered.length,
      classifications: {
        total: classifications.length,
        deterministic: classifications.filter((event) => event.route === 'deterministic').length,
        local: classifications.filter((event) => event.route === 'local').length,
        localSupervised: classifications.filter((event) => event.route === 'local-supervised').length,
        claude: classifications.filter((event) => event.route === 'claude').length
      },
      delegations: {
        total: delegations.length,
        errors: delegations.filter((event) => event.status === 'error').length
      },
      executions: {
        total: executions.length,
        success,
        escalated,
        errors: executionErrors,
        successRate: executions.length === 0 ? 0 : success / executions.length,
        retriedTasks: executions.filter((event) => safeNumber(event.attempts) > 1).length,
        totalAttempts,
        averageAttempts: executions.length === 0 ? 0 : totalAttempts / executions.length,
        changedFiles: executions.reduce((sum, event) => sum + safeNumber(event.changedFiles), 0)
      },
      orchestrations: {
        total: orchestrations.length,
        success: orchestrationSuccess,
        escalated: orchestrationEscalated,
        errors: orchestrationErrors,
        successRate:
          orchestrations.length === 0 ? 0 : orchestrationSuccess / orchestrations.length,
        plannedTasks,
        completedTasks,
        taskCompletionRate: plannedTasks === 0 ? 0 : completedTasks / plannedTasks,
        averageTasksPerPlan: orchestrations.length === 0 ? 0 : plannedTasks / orchestrations.length,
        averageCompletedTasksPerPlan:
          orchestrations.length === 0 ? 0 : completedTasks / orchestrations.length
      },
      localInference: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        generationDurationMs: filtered.reduce(
          (sum, event) => sum + safeNumber(event.generationDurationMs),
          0
        ),
        validationDurationMs: filtered.reduce(
          (sum, event) => sum + safeNumber(event.validationDurationMs),
          0
        ),
        apiCostUsd: 0,
        costScopeNote:
          'API inference cost is $0 for the local Ollama executor. Hardware depreciation, electricity, and Claude planning/review usage are intentionally not estimated.'
      }
    };
  }

  private async readEvents(): Promise<TelemetryEvent[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as TelemetryEvent];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
