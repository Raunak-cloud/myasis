import { AsyncLocalStorage } from 'node:async_hooks';

/** One process owns shared files and counters; application browser contexts are isolated. */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
}

export class ApplicationSlots {
  private active = 0;
  private sent = 0;
  private externalActive = 0;
  private externalSent = 0;
  private readonly initialDay: number;
  private waiters = new Set<() => void>();
  constructor(private readonly limits: { run: number; day: number; external: number; appliedToday: () => number; externalToday: number }) {
    this.initialDay = limits.appliedToday();
  }
  async acquire(external: boolean): Promise<{ beforeSubmit: (external: boolean) => boolean; finish: (mayHaveSent: boolean) => void } | null> {
    for (;;) {
      if (this.sent >= this.limits.run || this.initialDay + this.sent >= this.limits.day) return null;
      if (external && this.externalSent + this.limits.externalToday >= this.limits.external) return null;
      if (this.sent + this.active < this.limits.run && this.initialDay + this.sent + this.active < this.limits.day
        && (!external || this.externalSent + this.externalActive + this.limits.externalToday < this.limits.external)) break;
      await new Promise<void>(resolve => this.waiters.add(resolve));
    }
    this.active++;
    let externalReserved = external, finished = false;
    if (externalReserved) this.externalActive++;
    return {
      beforeSubmit: isExternal => {
        if (finished) return false;
        if (isExternal && !externalReserved) {
          if (this.externalSent + this.externalActive + this.limits.externalToday >= this.limits.external) return false;
          this.externalActive++; externalReserved = true;
        }
        return true;
      },
      finish: mayHaveSent => {
        if (finished) return;
        finished = true; this.active--;
        if (externalReserved) this.externalActive--;
        if (mayHaveSent) { this.sent++; if (externalReserved) this.externalSent++; }
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
      },
    };
  }
}

const workerScope = new AsyncLocalStorage<string>();
let loggingInstalled = false;
export function withApplicationWorker<T>(worker: string, action: () => T): T {
  if (!loggingInstalled) {
    loggingInstalled = true;
    for (const method of ['log', 'warn', 'error'] as const) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        const worker = workerScope.getStore();
        if (!worker) return original(...args);
        original(...args.map(arg => typeof arg === 'string' ? arg.replace(/^/gm, `[worker:${worker}] `) : arg));
      };
    }
  }
  return workerScope.run(worker, action);
}
