import { useEffect, useState } from 'react';

/**
 * Which connection this account's browser goes out on: the person's own home
 * address while their machine is connected, or this service's server.
 * Reported, never chosen here — the server decides, and says.
 */
export interface RouteStatus {
  configured: boolean;
  using: 'home' | 'server';
  homeOnline: boolean;
  homeAddress: string | null;
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
