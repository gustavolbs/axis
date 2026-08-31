import type { RemoteWorkerClient } from '../remote-worker-client.js';
import { RemoteWorkerError } from '../remote-worker-client.js';
import {
  ProviderError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelDefinition,
  type ProviderCapabilities,
  type ProviderHealth
} from './types.js';

type RemoteWorkerProviderClient = Pick<RemoteWorkerClient, 'health' | 'chat'>;

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

function remoteFailure(error: unknown): ProviderError | undefined {
  if (!(error instanceof RemoteWorkerError)) return undefined;
  return new ProviderError('ollama', error.message, {
    status: error.status,
    retryable: error.unavailable,
    code: 'remote_worker_error'
  });
}

/**
 * Exposes the Windows worker's configured Qwen model as the Project router's local
 * provider while the Agent Runtime itself remains on the Mac control plane.
 *
 * The current worker protocol intentionally exposes only the configured model here.
 * `/v1/chat` already applies stage-specific Qwen thinking, token budgets, context and
 * keep-alive defaults on the worker. Remote arbitrary model switching will be added as
 * a separate protocol capability instead of silently pretending the v1 endpoint can do it.
 */
export class RemoteWorkerInferenceProvider implements InferenceProvider {
  readonly id = 'ollama';
  readonly kind = 'local' as const;
  readonly capabilities = capabilities;

  private configuredModel?: string;

  constructor(private readonly client: RemoteWorkerProviderClient) {}

  async listModels(): Promise<ModelDefinition[]> {
    let health;
    try {
      health = await this.client.health();
    } catch (error) {
      throw remoteFailure(error) ?? error;
    }
    if (!health.ok || !health.model?.trim()) {
      throw new ProviderError(this.id, 'Remote worker did not report a usable configured model.', {
        retryable: true,
        code: 'remote_worker_model_unavailable'
      });
    }
    this.configuredModel = health.model.trim();
    return [{
      providerId: this.id,
      id: this.configuredModel,
      displayName: `${this.configuredModel} (Windows Worker)`,
      capabilities: this.capabilities,
      metadata: {
        remoteWorker: true,
        workerVersion: health.workerVersion,
        hostname: health.hostname,
        configuredFastModel: true,
        configuredStrongModel: true
      }
    }];
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const health = await this.client.health();
      const model = health.model?.trim();
      if (model) this.configuredModel = model;
      return {
        providerId: this.id,
        ok: health.ok && Boolean(model),
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        modelsAvailable: model ? 1 : 0,
        message: health.ok && model ? undefined : 'Remote worker has no configured model.'
      };
    } catch (error) {
      return {
        providerId: this.id,
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    const started = Date.now();
    const configured = this.configuredModel ?? (await this.listModels())[0]?.id;
    if (!configured || request.model !== configured) {
      throw new ProviderError(
        this.id,
        `Remote worker protocol v1 can invoke only its configured model ${configured ?? '[unknown]'}, not ${request.model}.`,
        { retryable: false, code: 'remote_worker_model_switch_unsupported' }
      );
    }

    request.onProgress?.({
      providerId: this.id,
      model: request.model,
      state: 'waiting-response',
      timestamp: new Date().toISOString(),
      eventCount: 0,
      outputChars: 0
    });

    try {
      const generation = await this.client.chat(
        request.systemPrompt,
        request.userPrompt,
        request.output?.type === 'json_schema' ? request.output.schema : undefined
      );
      request.onProgress?.({
        providerId: this.id,
        model: generation.model,
        state: 'generating',
        timestamp: new Date().toISOString(),
        eventCount: 1,
        outputChars: generation.content.length
      });
      return {
        providerId: this.id,
        model: generation.model,
        content: generation.content,
        stopReason: generation.doneReason,
        latencyMs: Date.now() - started,
        usage: {
          inputTokens: generation.promptTokens,
          outputTokens: generation.completionTokens,
          totalTokens:
            generation.promptTokens !== undefined || generation.completionTokens !== undefined
              ? (generation.promptTokens ?? 0) + (generation.completionTokens ?? 0)
              : undefined
        }
      };
    } catch (error) {
      throw remoteFailure(error) ?? error;
    }
  }
}
