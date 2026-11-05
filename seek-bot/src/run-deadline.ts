/** The run deadline closes admission; it never cancels an active application. */
export const RUN_DRAIN_REQUEST = 'owtomate:finish-current-applications';
export const RUN_DRAIN_ACK = 'owtomate:finishing-current-applications';

export class RunDeadline {
  private requested = false;
  private listeners = new Set<() => void>();
  private readonly deadlineAt: number;
  private readonly now: () => number;
  constructor(deadlineAt = Number(process.env.OWTOMATE_RUN_DEADLINE_AT), now = Date.now) { this.deadlineAt = deadlineAt; this.now = now; }
  get reached(): boolean { return this.requested || Number.isFinite(this.deadlineAt) && this.deadlineAt > 0 && this.now() >= this.deadlineAt; }
  request(): void {
    if (this.requested) return;
    this.requested = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  onReached(listener: () => void): () => void {
    if (this.reached) listener(); else this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** An absolute deadline also closes admission before a delayed IPC message. */
  listen(): () => void {
    const timer = Number.isFinite(this.deadlineAt) && this.deadlineAt > 0
      ? setTimeout(() => this.request(), Math.max(0, this.deadlineAt - this.now())) : undefined;
    timer?.unref();
    const message = (value: unknown) => {
      if (value !== RUN_DRAIN_REQUEST) return;
      this.request();
      if (process.connected) process.send?.(RUN_DRAIN_ACK, () => {});
    };
    process.on('message', message);
    return () => {
      clearTimeout(timer); this.listeners.clear(); process.off('message', message);
      if (process.connected) process.disconnect();
    };
  }
}

export const runDeadline = new RunDeadline();
