import type { OllamaGeneration } from './ollama.js';

interface OllamaChatChunk {
  error?: string;
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export async function readOllamaChatStream(
  response: Response,
  fallbackModel: string
): Promise<OllamaGeneration> {
  if (!response.body) throw new Error('Ollama returned a response without a body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finalChunk: OllamaChatChunk | undefined;

  const consume = (line: string): void => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as OllamaChatChunk;
    if (chunk.error) throw new Error('Ollama stream error: ' + chunk.error);
    content += chunk.message?.content ?? '';
    finalChunk = chunk;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
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
