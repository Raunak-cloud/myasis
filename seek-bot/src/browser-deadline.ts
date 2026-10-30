import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

interface Budget { signal: AbortSignal; expiresAt: number }
const current = new AsyncLocalStorage<Budget>();

export class BrowserOperationTimeout extends Error {
  constructor(label: string, milliseconds: number) {
    super(`${label} did not respond within ${milliseconds}ms. No action was retried; inspect the current browser state before choosing recovery.`);
    this.name = 'BrowserOperationTimeout';
  }
}

/** Wall-clock I/O budget, independent of application/run duration. Nested
 * operations inherit cancellation, so an abandoned solver cannot start a
 * subsequent navigation or apply a late token. A race alone cannot do that. */
export async function browserDeadline<T>(label: string, milliseconds: number, operation: () => Promise<T>): Promise<T> {
  const parent = current.getStore();
  parent?.signal.throwIfAborted();
  const controller = new AbortController();
  const budget = Math.max(1, Math.min(milliseconds, (parent?.expiresAt ?? Infinity) - Date.now()));
  const expiresAt = Date.now() + budget;
  const abortParent = () => controller.abort(parent!.signal.reason);
  parent?.signal.addEventListener('abort', abortParent, { once: true });
  const timer = setTimeout(() => controller.abort(new BrowserOperationTimeout(label, budget)), budget);
  let onAbort: (() => void) | undefined;
  try {
    return await current.run({ signal: controller.signal, expiresAt }, () => Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      }),
    ]));
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    parent?.signal.removeEventListener('abort', abortParent);
    // Also cancel detached continuations when the owning operation finishes.
    controller.abort(new Error(`${label} has ended.`));
  }
}

export function browserOperationSignal(milliseconds: number): AbortSignal {
  const parent = current.getStore();
  parent?.signal.throwIfAborted();
  return parent ? AbortSignal.any([parent.signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);
}

export const assertBrowserOperationActive = (): void => current.getStore()?.signal.throwIfAborted();

export async function browserDelay(milliseconds: number): Promise<void> {
  const signal = current.getStore()?.signal;
  signal?.throwIfAborted();
  await delay(milliseconds, undefined, { signal });
}

/** Passed into queued page callbacks to reject a token that arrives after its
 * operation expired, even if the renderer did not service the command on time. */
export const browserOperationExpiresAt = (milliseconds: number): number => Math.min(Date.now() + milliseconds, current.getStore()?.expiresAt ?? Infinity);

/** Cleanup must survive the cancelled owner, but cannot hold the run open. */
export async function browserCleanup(label: string, operation: () => Promise<unknown>): Promise<void> {
  await current.exit(() => browserDeadline(label, 1000, operation)).catch(() => {});
}
