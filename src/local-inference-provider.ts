import type { LocalCoderConfig } from './config.js';
import type { OllamaClient } from './ollama.js';
import { AutoLocalInferenceProvider } from './providers/auto-local-provider.js';
import { OllamaInferenceProvider } from './providers/ollama-provider.js';
import { RemoteWorkerInferenceProvider } from './providers/remote-worker-provider.js';
import type { InferenceProvider } from './providers/types.js';
import { RemoteWorkerClient } from './remote-worker-client.js';
import type { RemoteWorkerHealth } from './remote-protocol.js';

type RemoteLocalProviderClient = {
  health(): Promise<RemoteWorkerHealth>;
  chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>
  ): Promise<{
    content: string;
    model: string;
    doneReason?: string;
    totalDurationNs?: number;
    promptTokens?: number;
    completionTokens?: number;
  }>;
};

export type LocalInferenceLabel =
  | 'mac-ollama'
  | 'windows-worker'
  | 'windows-worker-with-mac-fallback';

/**
 * One source of truth for what local inference means to the standalone app.
 * In remote mode the provider still has kind=local because source code never leaves the
 * user's machines; only the compute host moves to the authenticated Windows worker.
 */
export function createLocalInferenceProvider(
  config: LocalCoderConfig,
  ollama: OllamaClient,
  remoteClient?: RemoteLocalProviderClient
): InferenceProvider {
  const mac = new OllamaInferenceProvider(ollama);
  if (config.executionMode === 'local') return mac;

  const remote = new RemoteWorkerInferenceProvider(
    remoteClient ?? new RemoteWorkerClient(config)
  );
  if (config.executionMode === 'remote') return remote;
  return new AutoLocalInferenceProvider(remote, mac);
}

export function localInferenceLabel(
  executionMode: LocalCoderConfig['executionMode']
): LocalInferenceLabel {
  if (executionMode === 'local') return 'mac-ollama';
  if (executionMode === 'remote') return 'windows-worker';
  return 'windows-worker-with-mac-fallback';
}
