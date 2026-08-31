import type { OllamaGeneration } from './ollama.js';

interface OllamaChatChunk {
  error?: string;
  model?: string;
  message?: {
    role?: string;
    content?: string;
    // Thinking chunks are intentionally not persisted or returned, but receiving
    // them still proves the model is alive and resets the stream inactivity timer.
    thinking?: string;
  };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaStreamTimeoutPolicy {
  /** Maximum silence after headers before the first body chunk arrives. */
  firstChunkTimeoutMs: number;
  /** Maximum silence between subsequent body chunks. */
  idleTimeoutMs: number;
  /** Hard per-inference wall-clock safety cap. */
  maxDurationMs: number;
}

export interface OllamaStreamProgress {
  elapsedMs: number;
  chunkCount: number;
  thinkingChars: number;
  outputChars: number;
  state: 'thinking' | 'generating';
  lastActivityAt: string;
}

export type OllamaStreamProgressReporter = (progress: OllamaStreamProgress) => void;

const DEFAULT_TIMEOUT_POLICY: OllamaStreamTimeoutPolicy = {
  firstChunkTimeoutMs: 600_000,
  idleTimeoutMs: 300_000,
  maxDurationMs: 1_800_000
};

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  message: string
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readOllamaChatStream(
  response: Response,
  fallbackModel: string,
  timeoutPolicy: OllamaStreamTimeoutPolicy = DEFAULT_TIMEOUT_POLICY,
  onProgress?: OllamaStreamProgressReporter
): Promise<OllamaGeneration> {
  if (!response.body) throw new Error('Ollama returned a response without a body.');

  const firstChunkTimeoutMs = Math.max(1, timeoutPolicy.firstChunkTimeoutMs);
  const idleTimeoutMs = Math.max(1, timeoutPolicy.idleTimeoutMs);
  const maxDurationMs = Math.max(1, timeoutPolicy.maxDurationMs);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let observedChunk = false;
  let buffer = '';
  let content = '';
  let finalChunk: OllamaChatChunk | undefined;
  let chunkCount = 0;
  let thinkingChars = 0;
  let outputChars = 0;

  const consume = (line: string): void => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as OllamaChatChunk;
    if (chunk.error) throw new Error('Ollama stream error: ' + chunk.error);

    const output = chunk.message?.content ?? '';
    const thinking = chunk.message?.thinking ?? '';
    content += output;
    outputChars += output.length;
    thinkingChars += thinking.length;
    chunkCount += 1;
    finalChunk = chunk;

    onProgress?.({
      elapsedMs: Math.max(0, Date.now() - startedAt),
      chunkCount,
      thinkingChars,
      outputChars,
      state: outputChars > 0 ? 'generating' : 'thinking',
      lastActivityAt: new Date().toISOString()
    });
  };

  try {
    while (true) {
      const elapsedMs = Date.now() - startedAt;
      const remainingAbsoluteMs = maxDurationMs - elapsedMs;
      if (remainingAbsoluteMs <= 0) {
        throw new Error(
          `Ollama inference exceeded the ${maxDurationMs}ms hard safety cap while the stream was active.`
        );
      }

      const livenessMs = observedChunk ? idleTimeoutMs : firstChunkTimeoutMs;
      const absoluteWins = remainingAbsoluteMs <= livenessMs;
      const effectiveTimeoutMs = Math.max(1, Math.min(livenessMs, remainingAbsoluteMs));
      const timeoutMessage = absoluteWins
        ? `Ollama inference exceeded the ${maxDurationMs}ms hard safety cap while the stream was active.`
        : observedChunk
          ? `Ollama inference stalled: no stream activity for ${idleTimeoutMs}ms.`
          : `Ollama inference did not produce its first stream chunk within ${firstChunkTimeoutMs}ms.`;

      const { done, value } = await readWithTimeout(reader, effectiveTimeoutMs, timeoutMessage);
      if (done) break;

      // Any bytes count as liveness, including model-thinking chunks that are not
      // exposed to callers. This avoids killing a model that is actively reasoning
      // before it emits user-visible answer content.
      observedChunk = true;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);

  const normalized = content.trim();
  if (!normalized) throw new Error('Ollama returned an empty assistant message.');

  return {
    content: normalized,
    model: finalChunk?.model ?? fallbackModel,
    doneReason: finalChunk?.done_reason,
    totalDurationNs: finalChunk?.total_duration,
    promptTokens: finalChunk?.prompt_eval_count,
    completionTokens: finalChunk?.eval_count
  };
}
