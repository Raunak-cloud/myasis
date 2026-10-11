import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which agent tool call the current code runs for.
 *
 * A call that outlives its time limit is abandoned, not stopped: it keeps
 * running in the background. On Nestlé's form one pressed a control after the
 * agent had moved on, and a letter written after a 300 s abandonment could
 * land in a page the agent had already left. The run is marked retired here,
 * and every place that writes into the page asks before it does.
 */
export interface ToolRun {
  generation: number;
  retired: boolean;
}

export const toolRun = new AsyncLocalStorage<ToolRun>();

/** The code runs for a tool call that was abandoned for taking too long. */
export function abandoned(): boolean {
  return toolRun.getStore()?.retired === true;
}

export class AbandonedStepError extends Error {
  constructor() {
    super('This step was abandoned for taking too long; nothing was changed.');
    this.name = 'AbandonedStepError';
  }
}

/** Refuses a write into the page from an abandoned tool call. Outside a tool call it never throws. */
export function assertLive(): void {
  if (abandoned()) throw new AbandonedStepError();
}
