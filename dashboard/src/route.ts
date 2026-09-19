import { useEffect, useState } from 'react';

/**
 * Which connection this account's browser goes out on: its better address —
 * the person's own home connection while their machine is connected, or a
 * dedicated proxy — or this service's server when that address is not
 * answering. Reported, never chosen here — the server decides, and says.
 */
export interface RouteStatus {
  exit: 'home' | 'proxy' | null;
  using: 'home' | 'proxy' | 'server';
  exitOnline: boolean;
  exitAddress: string | null;
}

export function useRouteStatus(): RouteStatus | null {
  const [status, setStatus] = useState<RouteStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/route')
        .then((response) => (response.ok ? response.json() : null))
        .then((value) => {
          if (!cancelled && value && typeof value.using === 'string') setStatus(value as RouteStatus);
        })
        .catch(() => {});
    };
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    const timer = window.setInterval(load, 30_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return status;
}
