import { execFile, type ChildProcess } from 'node:child_process';
import { RUN_DRAIN_ACK, RUN_DRAIN_REQUEST } from '../../seek-bot/src/run-deadline.js';

const RUN_STOP_GRACE_MS = 10_000;
export const RUN_OUTPUT_DRAIN_MS = 1_000;
const DEFAULT_RUN_MINUTES = 60;

/** Operator setting only; invalid values cannot disable the watchdog. */
export function runTimeoutMs(value?: string): number {
  const minutes = Number(value);
  return (Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 120) : DEFAULT_RUN_MINUTES) * 60_000;
}

/** Linux workers are spawned in their own process group, never the dashboard's. */
export function signalRunTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

export function superviseRun(child: ChildProcess, options: {
  timeoutMs: number;
  graceMs?: number;
  drainTimeoutMs?: number;
  finishCurrent?: boolean;
  signal?: typeof signalRunTree;
  onTimeout: () => void;
  onEscalation: () => void;
  onError: (error: Error) => void;
  onFinish: (code: number | null, signal: NodeJS.Signals | null) => Promise<void>;
}): { stop: () => void; finished: Promise<void> } {
  const signal = options.signal ?? signalRunTree;
  let stopping = false;
  let finishing = false;
  let exited = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let outputDrain: ReturnType<typeof setTimeout> | undefined;
  let acknowledgement: ReturnType<typeof setTimeout> | undefined;
  let deadlineReached = false;
  let drainDeadline: ReturnType<typeof setTimeout> | undefined;
  let resolveFinished: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const send = (value: 'SIGTERM' | 'SIGKILL') => {
    try { signal(child, value); } catch (error) { options.onError(error as Error); }
  };
  const stop = () => {
    if (stopping || finishing || exited) return;
    stopping = true;
    clearTimeout(deadline);
    clearTimeout(acknowledgement);
    clearTimeout(drainDeadline);
    send('SIGTERM');
    escalation = setTimeout(() => {
      options.onEscalation();
      send('SIGKILL');
    }, options.graceMs ?? RUN_STOP_GRACE_MS);
  };
  const deadline = setTimeout(() => {
    deadlineReached = true;
    options.onTimeout();
    if (!options.finishCurrent || !child.connected || !child.send) { stop(); return; }
    // Give a responsive worker a bounded chance to finish its current work.
    // An unsupported/unresponsive worker falls back to the stop watchdog.
    acknowledgement = setTimeout(stop, options.graceMs ?? RUN_STOP_GRACE_MS);
    try { child.send(RUN_DRAIN_REQUEST, error => { if (error) stop(); }); }
    catch (error) { options.onError(error as Error); stop(); }
  }, options.timeoutMs);
  const onMessage = (value: unknown) => {
    if (value === RUN_DRAIN_ACK && deadlineReached && !stopping && !exited) {
      clearTimeout(acknowledgement);
      // Finishing current work cannot disable the run's time budget forever.
      drainDeadline ??= setTimeout(stop, options.drainTimeoutMs ?? 120_000);
    }
  };
  child.on('message', onMessage);
  const finish = (code: number | null, exitSignal: NodeJS.Signals | null) => {
    if (finishing) return;
    finishing = true;
    clearTimeout(deadline);
    clearTimeout(escalation);
    clearTimeout(outputDrain);
    clearTimeout(drainDeadline);
    clearTimeout(acknowledgement);
    child.off('message', onMessage);
    void Promise.resolve().then(() => options.onFinish(code, exitSignal))
      .catch((error) => options.onError(error as Error))
      .finally(() => resolveFinished());
  };
  child.once('exit', (code, exitSignal) => {
    exited = true;
    clearTimeout(drainDeadline);
    clearTimeout(deadline);
    clearTimeout(escalation);
    clearTimeout(acknowledgement);
    // Prefer close so final submission/billing messages are consumed. A
    // descendant holding stdout open must not prevent cleanup indefinitely.
    outputDrain = setTimeout(() => finish(code, exitSignal), RUN_OUTPUT_DRAIN_MS);
  });
  child.once('close', finish);
  child.once('error', (error) => {
    options.onError(error);
    if (!child.pid) finish(-1, null);
    else stop();
  });
  return { stop, finished };
}
