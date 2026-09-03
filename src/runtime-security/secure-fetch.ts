import {
  assertRuntimeNetworkUrl,
  type RuntimeNetworkPolicy
} from './network-policy.js';
import { isRuntimeSecretField } from './redaction.js';

function redirectMethod(status: number, method: string): string {
  if (status === 303 && method !== 'HEAD') return 'GET';
  if ((status === 301 || status === 302) && method === 'POST') return 'GET';
  return method;
}

function stripCrossOriginCredentials(headers: Headers): Headers {
  const next = new Headers(headers);
  for (const [name] of next.entries()) {
    if (isRuntimeSecretField(name)) next.delete(name);
  }
  return next;
}

export interface RuntimeSecureFetchOptions {
  readonly policy?: RuntimeNetworkPolicy;
  readonly maxRedirects?: number;
}

/** Every redirect hop is authorized before any request is sent to it. */
export async function runtimeSecureFetch(
  fetchImpl: typeof globalThis.fetch,
  rawUrl: string,
  init: RequestInit = {},
  options: RuntimeSecureFetchOptions = {}
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  let current = new URL(assertRuntimeNetworkUrl(rawUrl, options.policy).normalizedUrl);
  let method = (init.method ?? 'GET').toUpperCase();
  let headers = new Headers(init.headers);
  let body = init.body;

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(current.toString(), {
      ...init,
      method,
      headers,
      body,
      redirect: 'manual'
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= maxRedirects) throw new Error(`Outbound redirect limit exceeded (${maxRedirects}).`);

    const location = response.headers.get('location');
    if (!location) return response;
    const target = new URL(location, current);
    assertRuntimeNetworkUrl(target.toString(), options.policy);

    if (current.origin !== target.origin) headers = stripCrossOriginCredentials(headers);

    const nextMethod = redirectMethod(response.status, method);
    if (nextMethod === 'GET' && method !== 'GET') {
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    method = nextMethod;
    current = target;
  }
}
