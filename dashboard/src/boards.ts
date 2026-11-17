import {dashboardGet,DASHBOARD_ACCOUNT_CHANGED} from './dashboard-requests.js';
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
  /** The address the board knows the account by, when it was last seen signed in. */
  account?: string | null;
  /** The person signed this board out themselves; nothing signs it back in for them. */
  signedOutByPerson?: boolean;
}

export interface BoardsStatus {
  employerApplicationsEnabled?: boolean;
  adzunaAvailable?: boolean;
  seek: BoardState | null;
  indeed: BoardState | null;
  jora?: BoardState | null;
  joraChecking?: boolean;
}

export function visibleJobBoards(boards: BoardsStatus, joraSignIn: boolean) {
  return (['seek','indeed','jora'] as const).filter(board =>
    board === 'jora' ? joraSignIn : board === 'seek' || boards[board] != null);
}

/** Fired by the Apply page after a sign-in window closes, so the menu updates without waiting for the next poll. */
export const BOARDS_CHANGED = 'boards-changed';

/** Asks the Apply page to open a private sign-in window (SEEK, Indeed or Jora), with nothing choosing an account for the person. */
export const OPEN_BOARD_SIGNIN = 'open-board-signin';

export function useBoardsStatus(verifyJora = false): BoardsStatus | null {
  const [status, setStatus] = useState<BoardsStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = (verify = false) => {
      dashboardGet(verify ? '/api/signin/session?verify=jora' : '/api/signin/session')
        .then((response) => (response.ok ? response.json() : null))
        .then((value) => {
          if (cancelled || !value || typeof value !== 'object') return;
          setStatus({ seek: value.seek ?? null, indeed: value.indeed ?? null, jora: value.jora ?? null,
            employerApplicationsEnabled:value.employerApplicationsEnabled!==false,
            joraChecking: value.joraChecking === true, adzunaAvailable: value.adzunaAvailable === true });
        })
        .catch(() => {});
    };
    load(verifyJora);
    const accountChanged=()=>{setStatus(null);load();};
    window.addEventListener(DASHBOARD_ACCOUNT_CHANGED,accountChanged);
    const onVisible = () => document.visibilityState === 'visible' && load();
    const timer = window.setInterval(() => load(), verifyJora ? 4_000 : 60_000);
    const changed = () => load();
    window.addEventListener(BOARDS_CHANGED, changed);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener(DASHBOARD_ACCOUNT_CHANGED,accountChanged);
      window.clearInterval(timer);
      window.removeEventListener(BOARDS_CHANGED, changed);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [verifyJora]);
  return status;
}
