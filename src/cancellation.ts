import { AsyncLocalStorage } from 'node:async_hooks';

const cancellationStorage = new AsyncLocalStorage<AbortSignal>();

export class OperationCancelledError extends Error {
  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

export function currentCancellationSignal(): AbortSignal | undefined {
  return cancellationStorage.getStore();
}

export function withCancellationSignal<T>(
  signal: AbortSignal,
  run: () => T
): T {
  return cancellationStorage.run(signal, run);
}

export function isCancellationError(error: unknown): boolean {
  return (
    error instanceof OperationCancelledError ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export function throwIfCancelled(signal: AbortSignal | undefined = currentCancellationSignal()): void {
  if (signal?.aborted) throw new OperationCancelledError();
}

export function requestAbortSignal(
  timeoutMs: number,
  explicit?: AbortSignal
): { signal: AbortSignal; callerSignals: AbortSignal[]; dispose: () => void } {
  const callerSignals = [explicit, currentCancellationSignal()].filter(
    (signal): signal is AbortSignal => Boolean(signal)
  );
  // AbortSignal.timeout() uses an unref'd timer in Node. That lets the process
  // exit while a tool is awaiting only its abort event, leaving the turn pending.
  // Keep this timer referenced until callers finish, then dispose it explicitly.
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new OperationCancelledError(`Operation timed out after ${timeoutMs}ms.`)),
    Math.max(1, timeoutMs)
  );
  return {
    signal: AbortSignal.any([...callerSignals, timeoutController.signal]),
    callerSignals,
    dispose: () => clearTimeout(timer)
  };
}

export function callerCancelled(signals: AbortSignal[]): boolean {
  return signals.some((signal) => signal.aborted);
}
