import { useState } from 'react';
import { BOARDS_CHANGED, OPEN_BOARD_SIGNIN, type BoardState, type BoardsStatus } from '../boards';

/**
 * Who each job board thinks this account is, and the two things a person may
 * want to do about it: sign out, and sign in themselves.
 *
 * Owtomate signs a lapsed session back in by itself, with the account the
 * browser already holds. That is right until it is not — the wrong Google
 * account, a job search moved to another address — so signing out here is
 * final until the person signs in again: nothing signs a board back in that
 * its owner signed out of.
 */

const NAMES = { seek: 'SEEK', indeed: 'Indeed' } as const;
type Board = keyof typeof NAMES;

function describe(state: BoardState | null): string {
  if (!state) return 'Not signed in yet';
  if (state.signedIn) return state.account ? `Signed in as ${state.account}` : 'Signed in';
  return state.signedOutByPerson ? 'Signed out by you' : 'Signed out';
}

export function JobBoardsDialog({ boards, onClose, onSignIn }: {
  boards: BoardsStatus;
  onClose: () => void;
  /** Takes the person to the Apply page, where the sign-in window opens. */
  onSignIn: () => void;
}) {
  const [busy, setBusy] = useState<Board | null>(null);
  const [confirming, setConfirming] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signOut(board: Board) {
    setBusy(board);
    setError(null);
    try {
      const response = await fetch('/api/signin/signout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site: board }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not sign out.');
      setConfirming(null);
      window.dispatchEvent(new Event(BOARDS_CHANGED));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function signIn(board: Board) {
    onSignIn();
    // The Apply page owns the sign-in window; give it a moment to be on screen before it is asked to open one.
    window.setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN_BOARD_SIGNIN, { detail: board })), 150);
    onClose();
  }

  // SEEK is every account's board; Indeed appears once the account has used it.
  const shown = (Object.keys(NAMES) as Board[]).filter((board) => board === 'seek' || boards[board] !== null);

  return (
    <div className="overlay center" onClick={onClose}>
      <div className="card confirm boards-dialog" role="dialog" aria-modal="true" aria-labelledby="boards-dialog-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="boards-dialog-title">Job boards</h2>
        <p className="dim">The accounts Owtomate applies with. It signs an expired session back in by itself; a board you sign out of here stays signed out until you sign in again.</p>
        {error && <div className="banner banner-bad">{error}</div>}

        {shown.map((board) => {
          const state = boards[board] ?? null;
          return (
            <div className="boards-row" key={board}>
              <div className="boards-row-main">
                <strong>{NAMES[board]}</strong>
                <span className="job-meta">
                  <span className={`nav-dot ${state?.signedIn ? 'on' : 'off'}`} aria-hidden="true" /> {describe(state)}
                </span>
              </div>
              {confirming === board ? (
                <div className="boards-row-actions">
                  <span className="job-meta">Owtomate will stop applying on {NAMES[board]}.</span>
                  <button className="btn" disabled={busy !== null} onClick={() => setConfirming(null)}>Cancel</button>
                  <button className="btn btn-danger" disabled={busy !== null} onClick={() => void signOut(board)}>
                    {busy === board ? 'Signing out…' : 'Sign out'}
                  </button>
                </div>
              ) : (
                <div className="boards-row-actions">
                  {state?.signedIn
                    ? <button className="btn" disabled={busy !== null} onClick={() => setConfirming(board)}>Sign out</button>
                    : <button className="btn primary" disabled={busy !== null} onClick={() => signIn(board)}>Sign in</button>}
                </div>
              )}
            </div>
          );
        })}

        <div className="confirm-actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
