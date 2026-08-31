import type { OllamaClient, OllamaThinkingLevel } from '../ollama.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth,
  ReasoningEffort
} from './types.js';

type OllamaProviderClient = Pick<OllamaClient, 'health' | 'chat'>;

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

function thinking(effort: ReasoningEffort | undefined): OllamaThinkingLevel | undefined {
  if (effort === undefined) return undefined;
  if (effort === 'none') return false;
  if (effort === 'low' || effort === 'medium') return effort;
  return 'high';
}

export class OllamaInferenceProvider implements InferenceProvider {
  readonly id = 'ollama';
  readonly kind = 'local' as const;
  readonly capabilities = capabilities;

  constructor(private readonly client: OllamaProviderClient) {}

  async listModels(): Promise<ModelDefinition[]> {
    const health = await this.client.health();
    return health.availableModels.map((model) => ({
      providerId: this.id,
      id: model,
      displayName: model,
      capabilities: this.capabilities,
      metadata: {
        configuredFastModel: model === health.fastModel,
        configuredStrongModel: model === health.strongModel
      }
    }));
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const health = await this.client.health();
      return {
        providerId: this.id,
        ok: health.ok,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        modelsAvailable: health.availableModels.length,
        message: health.ok ? undefined : 'Ollama health check failed.'
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
    let eventCount = 0;
    let outputChars = 0;
    request.onProgress?.({
      providerId: this.id,
      model: request.model,
      state: 'waiting-response',
      timestamp: new Date().toISOString(),
      eventCount,
      outputChars
    });

    const generation = await this.client.chat(
      request.systemPrompt,
      request.userPrompt,
      request.output?.type === 'json_schema' ? request.output.schema : undefined,
      {
        model: request.model,
        think: thinking(request.reasoning?.effort),
        maxDurationMs: request.timeoutMs,
        maxTokens: request.maxOutputTokens,
        onStreamProgress: (progress) => {
          eventCount = progress.chunkCount;
          outputChars = progress.outputChars;
          request.onProgress?.({
            providerId: this.id,
            model: request.model,
            state: progress.state === 'thinking' ? 'reasoning' : 'generating',
            timestamp: progress.lastActivityAt,
            eventCount,
            outputChars
          });
        }
      }
    );

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
  }
}
