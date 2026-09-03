import {
  assertRuntimeNetworkUrl,
  type RuntimeNetworkPolicy
} from './network-policy.js';

const CROSS_ORIGIN_SECRET_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key'
] as const;

function redirectMethod(status: number, method: string): string {
  if (status === 303 && method !== 'HEAD') return 'GET';
  if ((status === 301 || status === 302) && method === 'POST') return 'GET';
  return method;
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

    if (current.origin !== target.origin) {
      const nextHeaders = new Headers(headers);
      for (const name of CROSS_ORIGIN_SECRET_HEADERS) nextHeaders.delete(name);
      headers = nextHeaders;
    }

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
