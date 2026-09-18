import { useEffect, useState } from 'react';

/**
 * Whether the account is signed in to each job board, as last found out.
 *
 * Shown in the menu foot so the state is visible from every screen, next to
 * the plan. Signing in itself still happens on the Apply page, which is where
 * the browser window opens; this only reports.
 */
export interface BoardState {
  signedIn: boolean;
  checkedAt: string;
}

export interface BoardsStatus {
  seek: BoardState | null;
  indeed: BoardState | null;
}

/** Fired by the Apply page after a sign-in window closes, so the menu updates without waiting for the next poll. */
export const BOARDS_CHANGED = 'boards-changed';

export function useBoardsStatus(): BoardsStatus | null {
  const [status, setStatus] = useState<BoardsStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/signin/session')
        .then((response) => (response.ok ? response.json() : null))
        .then((value) => {
          if (cancelled || !value || typeof value !== 'object') return;
          setStatus({ seek: value.seek ?? null, indeed: value.indeed ?? null });
        })
        .catch(() => {});
    };
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    const timer = window.setInterval(load, 60_000);
    window.addEventListener(BOARDS_CHANGED, load);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(BOARDS_CHANGED, load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return status;
}
