export interface RuntimeRequest {
  method?: string;
  path: string;
  body?: unknown;
}

export interface RuntimeEvent {
  type: 'job' | 'worker' | 'worker-error';
  payload: unknown;
}

function parseBody(init?: RequestInit): unknown {
  if (init?.body === undefined || init.body === null) return undefined;
  if (typeof init.body !== 'string') throw new Error('Local Coder app requests require JSON string bodies.');
  return init.body.trim() ? JSON.parse(init.body) as unknown : undefined;
}

export async function appRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (window.localCoder?.request) {
    return await window.localCoder.request<T>({
      method: init?.method ?? 'GET',
      path,
      body: parseBody(init)
    });
  }

  // Test-only fallback used by the renderer smoke harness. The shipped desktop app
  // always receives the isolated Electron preload bridge.
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export function subscribeRuntime(listener: (event: RuntimeEvent) => void): () => void {
  if (window.localCoder?.onRuntimeEvent) return window.localCoder.onRuntimeEvent(listener);

  // Test-only fallback for the browser-backed layout smoke.
  const events = new EventSource('/api/events');
  const handlers = ['job', 'worker', 'worker-error'] as const;
  for (const type of handlers) {
    events.addEventListener(type, (event) => {
      listener({ type, payload: JSON.parse((event as MessageEvent<string>).data) as unknown });
    });
  }
  return () => events.close();
}
