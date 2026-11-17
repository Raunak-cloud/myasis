import { useEffect,useState } from 'react';
import {BoardBrand,EmployerSitesLabel} from './BoardBrand';
import {EMPLOYER_APPLICATIONS_ENABLED} from '../employer-applications';
import { BOARDS_CHANGED, OPEN_BOARD_SIGNIN, visibleJobBoards, type BoardState, type BoardsStatus } from '../boards';

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

const NAMES = { seek: 'SEEK', indeed: 'Indeed', jora: 'Jora' } as const;
type Board = keyof typeof NAMES;

function describe(state: BoardState | null): string {
  if (!state) return 'Not signed in yet';
  if (state.signedIn) return state.account ? `Signed in as ${state.account}` : 'Signed in';
  return state.signedOutByPerson ? 'Signed out by you' : 'Signed out';
}

export function JobBoardsDialog({ boards, joraSignIn = false, onClose, onSignIn }: {
  boards: BoardsStatus;
  joraSignIn?: boolean;
  onClose: () => void;
  /** Takes the person to the Apply page, where the sign-in window opens. */
  onSignIn: () => void;
}) {
  const [busy, setBusy] = useState<Board | 'employer-sites' | null>(null);
  const [confirming, setConfirming] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [employersEnabled,setEmployersEnabled]=useState(boards.employerApplicationsEnabled!==false);
  const [confirmEmployerOff,setConfirmEmployerOff]=useState(false);
  useEffect(()=>setEmployersEnabled(boards.employerApplicationsEnabled!==false),[boards.employerApplicationsEnabled]);

  async function setEmployerApplications(enabled:boolean) {
    setBusy('employer-sites');setError(null);
    try {
      const response=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({updates:{[EMPLOYER_APPLICATIONS_ENABLED]:String(enabled)}})});
      const body=await response.json();
      if(!response.ok || body.settings?.[EMPLOYER_APPLICATIONS_ENABLED]!==String(enabled))throw new Error(body.error??'Could not change employer-site applications. Please try again.');
      setEmployersEnabled(enabled);setConfirmEmployerOff(false);window.dispatchEvent(new Event(BOARDS_CHANGED));
    }catch(reason){setError((reason as Error).message);}finally{setBusy(null);}
  }

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

  const shown = visibleJobBoards(boards, joraSignIn);

  if(confirmEmployerOff)return <div className="overlay center" onClick={()=>{if(!busy)setConfirmEmployerOff(false);}}><div className="card confirm" role="alertdialog" aria-modal="true" aria-labelledby="employer-off-title" onClick={event=>event.stopPropagation()}>
    <h2 id="employer-off-title">Turn off employer-site applications?</h2>
    <p>Future runs will apply through job boards only. Any run already in progress can finish.</p>
    {!boards.seek?.signedIn&&!boards.indeed?.signedIn&&<p className="dim">Connect a job board to keep applying.</p>}
    {error&&<div className="banner banner-bad" role="alert">{error}</div>}
    <div className="confirm-actions"><button className="btn" autoFocus disabled={busy!==null} onClick={()=>{setConfirmEmployerOff(false);setError(null);}}>Cancel</button><button className="btn btn-danger" disabled={busy!==null} onClick={()=>void setEmployerApplications(false)}>{busy?'Saving…':'Turn off employer sites'}</button></div>
  </div></div>;

  return (
    <div className="overlay center" onClick={onClose}>
      <div className="card confirm boards-dialog" role="dialog" aria-modal="true" aria-labelledby="boards-dialog-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="boards-dialog-title">Job sources</h2>
        <p className="dim">Manage your job-board connections and applications on company websites.</p>
        {error && <div className="banner banner-bad">{error}</div>}

        {shown.map((board) => {
          const state = boards[board] ?? null;
          return (
            <div className="boards-row" key={board}>
              <div className="boards-row-main">
                <strong><BoardBrand board={board}/></strong>
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
                  {board === 'jora'
                    ? <button className="btn" disabled={busy !== null || boards.joraChecking} onClick={() => signIn(board)}>{boards.joraChecking ? 'Checking sign-in…' : state?.signedIn ? 'Manage sign-in' : 'Sign in'}</button>
                    : state?.signedIn
                    ? <button className="btn" disabled={busy !== null} onClick={() => setConfirming(board)}>Sign out</button>
                    : <button className="btn primary" disabled={busy !== null} onClick={() => signIn(board)}>Sign in</button>}
                </div>
              )}
            </div>
          );
        })}

        <div className="boards-row employer-sites-row"><div className="boards-row-main"><strong><EmployerSitesLabel/></strong><span className="job-meta">{employersEnabled?'Apply directly on company websites.':'Employer-site applications are off.'}</span><span className="job-meta">Changes apply to future runs.</span></div><button type="button" role="switch" aria-label="Employer-site applications" aria-checked={employersEnabled} className={`btn employer-sites-switch ${employersEnabled?'on':''}`} disabled={busy!==null} onClick={()=>{setError(null);if(employersEnabled)setConfirmEmployerOff(true);else void setEmployerApplications(true);}}>{busy==='employer-sites'?'Saving…':employersEnabled?'On':'Off'}</button></div>

        <div className="confirm-actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
