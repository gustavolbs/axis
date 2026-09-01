import type { RuntimeEvent } from './runtime-client.js';

function isAppRequest(input: RequestInfo | URL): input is string {
  return typeof input === 'string' && input.startsWith('/api/');
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export function installRuntimeTransport(): void {
  const bridge = window.localCoder;
  if (!bridge?.request) return;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isAppRequest(input)) return await nativeFetch(input, init);
    try {
      const body = typeof init?.body === 'string' && init.body.trim()
        ? JSON.parse(init.body) as unknown
        : undefined;
      const payload = await bridge.request({
        method: init?.method ?? 'GET',
        path: input,
        body
      });
      return jsonResponse(payload);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }) as typeof window.fetch;

  class IpcEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials = false;
    readyState = IpcEventSource.CONNECTING;
    onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
    onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
    onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
    private unsubscribe?: () => void;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      if (this.url !== '/api/events') {
        queueMicrotask(() => {
          this.readyState = IpcEventSource.CLOSED;
          const event = new Event('error');
          this.dispatchEvent(event);
          this.onerror?.call(this as unknown as EventSource, event);
        });
        return;
      }

      this.unsubscribe = bridge.onRuntimeEvent((event: RuntimeEvent) => this.emitRuntimeEvent(event));
      queueMicrotask(() => {
        if (this.readyState === IpcEventSource.CLOSED) return;
        this.readyState = IpcEventSource.OPEN;
        const event = new Event('open');
        this.dispatchEvent(event);
        this.onopen?.call(this as unknown as EventSource, event);
      });
    }

    close(): void {
      if (this.readyState === IpcEventSource.CLOSED) return;
      this.readyState = IpcEventSource.CLOSED;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }

    private emitRuntimeEvent(event: RuntimeEvent): void {
      if (this.readyState === IpcEventSource.CLOSED) return;
      const message = new MessageEvent(event.type, { data: JSON.stringify(event.payload) });
      this.dispatchEvent(message);
      if (event.type === 'job') this.onmessage?.call(this as unknown as EventSource, message);
    }
  }

  window.EventSource = IpcEventSource as unknown as typeof EventSource;
}
