import {
  OperationCancelledError,
  callerCancelled,
  requestAbortSignal,
  throwIfCancelled
} from '../cancellation.js';
import { redactRuntimeText } from '../runtime-security/redaction.js';
import { runtimeSecureFetch } from '../runtime-security/secure-fetch.js';
import type { RuntimeNetworkPolicy } from '../runtime-security/network-policy.js';
import { ProviderError } from './types.js';

export type FetchLike = typeof globalThis.fetch;

export interface SseEvent {
  event?: string;
  data: string;
}

export function redactSecrets(value: string, secrets: string[]): string {
  return redactRuntimeText(value, { knownSecrets: secrets });
}

function providerNetworkPolicy(providerId: string): RuntimeNetworkPolicy {
  if (providerId.trim().toLowerCase() === 'ollama') {
    return Object.freeze({
      allowLoopback: true,
      allowPrivateNetwork: false,
      allowInsecureHttp: true
    });
  }
  return Object.freeze({
    allowLoopback: false,
    allowPrivateNetwork: false,
    allowInsecureHttp: false
  });
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

export async function throwProviderHttpError(
  providerId: string,
  response: Response,
  secrets: string[] = []
): Promise<never> {
  const raw = await response.text().catch(() => '');
  const body = redactSecrets(raw || response.statusText || 'Request failed.', secrets).slice(0, 4000);
  const status = response.status;
  throw new ProviderError(providerId, `${providerId} HTTP ${status}: ${body}`, {
    status,
    rateLimited: status === 429,
    retryable: status === 408 || status === 409 || status === 429 || status >= 500,
    retryAfterMs: retryAfterMs(response)
  });
}

export async function fetchWithProviderErrors(
  providerId: string,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  secrets: string[] = []
): Promise<Response> {
  throwIfCancelled();
  const abort = requestAbortSignal(timeoutMs, init.signal ?? undefined);
  let response: Response;
  try {
    response = await runtimeSecureFetch(fetchImpl, url, {
      ...init,
      signal: abort.signal
    }, {
      policy: providerNetworkPolicy(providerId)
    });
  } catch (error) {
    if (callerCancelled(abort.callerSignals)) {
      throw new OperationCancelledError(`${providerId} request cancelled.`);
    }
    const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    throw new ProviderError(providerId, `${providerId} request failed: ${message}`, {
      retryable: true
    });
  }
  throwIfCancelled();
  if (!response.ok) await throwProviderHttpError(providerId, response, secrets);
  return response;
}

function boundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return undefined;
  if (lf < 0) return { index: crlf, length: 4 };
  if (crlf < 0) return { index: lf, length: 2 };
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function parseSseBlock(block: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join('\n') };
}

export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) throw new Error('Streaming response did not include a body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      throwIfCancelled();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const next = boundary(buffer);
        if (!next) break;
        const block = buffer.slice(0, next.index);
        buffer = buffer.slice(next.index + next.length);
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
      }
      if (done) break;
    }
    throwIfCancelled();
    const trailing = parseSseBlock(buffer.trim());
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}
