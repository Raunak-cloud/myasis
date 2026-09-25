import { useEffect, useState } from 'react';

/**
 * The state of this account's run, polled once for the whole page.
 *
 * Two components want this: the shell, to show the Running badge and to
 * notice a run finishing, and the Apply panel, to drive everything it shows.
 * Each used to run its own timer against the same endpoint — one at 2s, one
 * at 1.5s — so every open tab asked the same question about 1.2 times a
 * second and threw half the answers away. There is one timer now, shared by
 * every subscriber, and the page makes half as many requests.
 *
 * The poll lives outside React rather than in a context because it has to
 * outlive individual mounts: the Apply panel unmounts whenever the user looks
 * at another tab, and the shell still needs to know when the run ends.
 */
interface RunStatus {
  running: boolean;
  mode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  applied: number;
  hasKey: boolean;
  /** false when a run is active but belongs to a different account — the server withholds every other field then. */
  isOwner: boolean;
}

/** The faster of the two rates the components used, so nothing became less responsive. */
const POLL_MS = 1_500;

const subscribers = new Set<(status: RunStatus) => void>();
let timer: number | null = null;
/** The last answer, handed to a new subscriber so it need not wait for the next tick. */
let latest: RunStatus | null = null;

async function poll(): Promise<void> {
  try {
    const status = (await fetch('/api/run/status').then((response) => response.json())) as RunStatus;
    latest = status;
    for (const notify of subscribers) notify(status);
  } catch {
    // The server may be restarting; the next tick will pick it up.
  }
}

export function useRunStatus(): RunStatus | null {
  const [status, setStatus] = useState<RunStatus | null>(latest);

  useEffect(() => {
    subscribers.add(setStatus);
    // A tab reopened mid-run should not show a blank panel until the next tick.
    if (latest) setStatus(latest);
    if (timer === null) {
      void poll();
      timer = window.setInterval(() => void poll(), POLL_MS);
    }
    return () => {
      subscribers.delete(setStatus);
      if (subscribers.size === 0 && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
  }, []);

  return status;
}
