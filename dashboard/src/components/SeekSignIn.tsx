import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BOARDS_CHANGED, OPEN_BOARD_SIGNIN } from '../boards';
import { SigninViewer, type BrowserSigninSession as Session } from './SigninViewer';

/**
 * Signing in to SEEK, in a browser this account controls.
 *
 * Applications are sent from the candidate's own SEEK account, so that
 * account has to be signed in once — and the agent never handles anyone's
 * password. On the hosted server there is no screen for that, so this opens a
 * private virtual one (its own display, its own Chrome, on this account's own
 * profile) and streams it here over an authenticated socket. Keyboard and
 * mouse arrive as ordinary X11 input, which matters because SEEK's login sits
 * behind a bot check that rejects synthetic typing.
 *
 * On a desktop install there is a real screen, so it falls back to opening a
 * normal Chrome window instead.
 */

/** Last known SEEK sign-in state; null when nobody has ever found out. */
interface SeekState {
  signedIn: boolean;
  checkedAt: string;
  source: 'run' | 'declared';
}

type Status = {
  supported: boolean;
  session: Session | null;
  seek?: SeekState | null;
  indeed?: SeekState | null;
  checking?: boolean;
};

const SITE_NAME = { seek: 'SEEK', indeed: 'Indeed', gmail: 'Gmail' } as const;

export function SeekSignIn({ indeedEnabled = false, showConnected = false, onVerifyingChange }: {
  indeedEnabled?: boolean;
  /** Keep the connection state visible on Setup, even after sign-in succeeds. */
  showConnected?: boolean;
  /** Told whenever a sign-in check starts or settles, so the page can hold a run back until it has. */
  onVerifyingChange?: (verifying: boolean) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const requestEpoch = useRef(0);
  const acting = useRef(false);
  const polling = useRef(false);
  const previousSession = useRef<Session | null>(null);
  const reopening = useRef(false);
  const reopenTimes = useRef<number[]>([]);
  previousSession.current = status?.session ?? null;

  const refresh = useCallback(async (verify = false) => {
    if (acting.current || polling.current) return;
    polling.current = true;
    const epoch = requestEpoch.current;
    try {
      const sites = indeedEnabled ? 'seek,indeed' : 'seek';
      const response = await fetch(
        verify ? `/api/signin/session?verify=${encodeURIComponent(sites)}` : '/api/signin/session',
        {signal: AbortSignal.timeout(10_000)},
      );
      if (!response.ok) throw new Error('Could not check sign-in.');
      const body = await response.json();
      if (epoch !== requestEpoch.current || acting.current) return;
      const previous = previousSession.current;
      // A dashboard restart forgets its in-memory session. Restore the window
      // only while the user still has it open and its original lease is valid.
      if (!body.session && previous && Date.now() < previous.expiresAt && !reopening.current) {
        reopenTimes.current = reopenTimes.current.filter(time => Date.now() - time < 60_000);
        if (reopenTimes.current.length < 3) {
          reopenTimes.current.push(Date.now()); reopening.current = true;
          setStatus(current => current?.session ? {...current, session: {...current.session, state: 'recovering', message: 'Restoring your sign-in window after the connection stopped...'}} : current);
          try {
            const restored = await fetch('/api/signin/session', { method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({target: previous.target ?? 'seek', manual: true, resumeUntil: previous.expiresAt, ...(previous.target === 'gmail' ? { consent: true } : {})}) });
            const result = await restored.json();
            if (epoch !== requestEpoch.current) return;
            if (restored.ok && result.session) { setStatus({...body, session: result.session}); return; }
            setError(result.error ?? 'Could not restore sign-in. Please open it again.');
          } finally { reopening.current = false; }
        } else setNotice('The sign-in window keeps stopping. Please open it again to retry.');
      } else if (!body.session && reopening.current) return;
      setStatus(body);
      window.dispatchEvent(new Event(BOARDS_CHANGED));
    } catch {
      if (epoch === requestEpoch.current) setStatus(previous => previous ?? { supported: false, session: null });
    } finally {
      polling.current = false;
    }
  }, [indeedEnabled]);

  useEffect(() => {
    // Load the last confirmed state immediately. A full browser verification
    // happens after the person presses Done; runs independently re-check and
    // repair expired sessions, so opening Apply never blocks on a browser.
    void refresh();
    const changed = (event: Event) => {
      // Use the successful open response immediately, even if an older status
      // request is still in flight. Its late response must not hide the viewer.
      requestEpoch.current++;
      setStatus(current => ({ ...current, supported: true, session: (event as CustomEvent<Session>).detail }));
    };
    window.addEventListener('signin-session-changed', changed);
    return () => window.removeEventListener('signin-session-changed', changed);
  }, [refresh]);

  // Before the first answer the check has been asked for but not reported, which is still verifying.
  const verifying = status === null || Boolean(status.checking);
  useEffect(() => {
    onVerifyingChange?.(verifying);
    return () => onVerifyingChange?.(false);
  }, [verifying, onVerifyingChange]);

  // While the server is asking a job board, keep asking the server.
  useEffect(() => {
    if (!status?.checking) return;
    const tick = setInterval(() => void refresh(), 4_000);
    return () => clearInterval(tick);
  }, [status?.checking, refresh]);

  // Session state/revision changes drive recovery without replacing a healthy
  // viewer on every poll. A temporary HTTP outage must not discard the session.
  const activeSession = Boolean(status?.session);
  useEffect(() => {
    if (!activeSession) return;
    const tick = setInterval(() => { setNow(Date.now()); void refresh(); }, 2_000);
    return () => clearInterval(tick);
  }, [activeSession, refresh]);

  async function open(target: 'seek' | 'indeed' | 'gmail' = 'seek', manual = false) {
    if (acting.current) return;
    acting.current = true;
    requestEpoch.current++;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // A desktop install has a real screen; use a normal Chrome window there.
      const path = status?.supported ? '/api/signin/session' : `/api/browser/manual-login?target=${target}`;
      const response = await fetch(path, {
        method: 'POST',
        headers: status?.supported ? { 'Content-Type': 'application/json' } : undefined,
        body: status?.supported ? JSON.stringify({ target, manual, ...(target === 'gmail' ? { consent: true } : {}) }) : undefined,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not open the browser.');
      if (status?.supported) setStatus({ supported: true, session: body.session });
      else setNotice(`Chrome opened on this computer. Sign in to ${target === 'indeed' ? 'Indeed' : 'SEEK'} there, then close it.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  async function close(verifySignIn: boolean) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    requestEpoch.current++;
    setConnected(false);
    const target = status?.session?.target ?? 'seek';
    try {
      const path = verifySignIn ? '/api/signin/session' : '/api/signin/session?cancel=true';
      const body = await fetch(path, { method: 'DELETE' }).then((r) => r.json());
      const seek: SeekState | null = body?.seek ?? null;
      const indeed: SeekState | null = body?.indeed ?? null;
      setStatus({ supported: true, session: null, seek, indeed });
      window.dispatchEvent(new Event(BOARDS_CHANGED));
      // Only the site that was just checked can say anything new.
      if (target === 'gmail') window.dispatchEvent(new Event('gmail-connection-changed'));
      if (verifySignIn && (target === 'seek' || target === 'indeed')) {
        const site = target === 'seek' ? seek : indeed;
        const name = SITE_NAME[target];
        if (!site?.signedIn) {
          setNotice(
            site?.signedIn === false
              ? `${name} shows this account signed out. Sign in again to keep applying.`
              : `Could not confirm the sign-in with ${name}. Open it and try again.`,
          );
        }
      }
    } catch {
      setStatus({ supported: true, session: null });
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  // Asked for from the Job boards dialog: the person is signing in themselves, so nothing picks an account for them.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    const onAsk = (event: Event) => void openRef.current((event as CustomEvent<'seek' | 'indeed'>).detail, true);
    window.addEventListener(OPEN_BOARD_SIGNIN, onAsk);
    return () => window.removeEventListener(OPEN_BOARD_SIGNIN, onAsk);
  }, []);

  if (!status) return showConnected ? <div className="signin-status" role="status">Checking SEEK connection…</div> : null;
  const minutesLeft = status.session ? Math.max(0, Math.round((status.session.expiresAt - now) / 60000)) : 0;

  if (!status.session) {
    if (status.checking) {
      return (
        <div className="signin-status" role="status" aria-label="Verifying job-board sign-ins">
          <span className="signin-pill verifying">Verifying job-board sign-ins…</span>
        </div>
      );
    }

    /**
     * Nothing to say to an account that is already signed in.
     *
     * "Sign in once" is a one-time instruction, so leaving it on the Apply
     * page forever reads as an unfinished step. It comes back by itself: a
     * run that finds the session dead records that, and the prompt returns
     * with the reason attached.
     */
    const seekSettled = Boolean(status.seek?.signedIn);
    const indeedSettled = !indeedEnabled || Boolean(status.indeed?.signedIn);
    /**
     * Signed in everywhere: nothing to show here. The menu foot carries the
     * signed-in state on every screen, so repeating it among the run
     * controls only made it look like a setting.
     */
    if (seekSettled && indeedSettled && !error && !notice && !showConnected) return null;

    const expired = status.seek?.signedIn === false;
    const indeedExpired = status.indeed?.signedIn === false;
    return (
      <div className="seek-connect">
        {error && <div className="banner banner-bad">{error}</div>}
        {notice && <div className={`banner ${/signed out|could not/i.test(notice) ? 'banner-bad' : 'banner-ok'}`}>{notice}</div>}
        {(showConnected || !status.seek?.signedIn) && !status.checking && <div className="seek-connect-row">
          <div>
            <h3>SEEK</h3>
            <p className="job-meta">
              {status.seek?.signedIn
                ? 'Connected'
                : expired
                ? 'Signed out'
                : 'Not connected'}
            </p>
          </div>
          {!status.seek?.signedIn && <button className="btn primary" disabled={busy} onClick={() => open('seek')}>
            {busy ? 'Opening…' : expired ? 'Sign in again' : 'Open SEEK'}
          </button>}
        </div>}
        {(indeedEnabled || (showConnected && status.indeed?.signedIn)) && (showConnected || !status.indeed?.signedIn) && <div className="seek-connect-row">
          <div>
            <h3>Indeed</h3>
            <p className="job-meta">
              {status.indeed?.signedIn
                ? 'Connected'
                : indeedExpired
                ? 'Signed out'
                : 'Not connected'}
            </p>
          </div>
          {!status.indeed?.signedIn && <button className="btn" disabled={busy} onClick={() => open('indeed')}>
            {busy ? 'Opening…' : indeedExpired ? 'Sign in again' : 'Open Indeed'}
          </button>}
        </div>}
      </div>
    );
  }

  /**
   * The browser opens over the page, not inside the column.
   *
   * The virtual screen is 1280 wide; squeezed into the run column it renders
   * at about a third of that and SEEK is unreadable. An overlay gives it the
   * width it was drawn at. Clicking the backdrop deliberately does nothing —
   * losing a half-finished sign-in to a stray click would be worse than the
   * inconvenience of reaching for Done.
   */
  return createPortal(
    <div className="overlay center" role="dialog" aria-modal="true" aria-label="Browser sign-in">
      <div className="card seek-window">
        <div className="seek-window-bar">
          <span className={`seek-dot ${connected ? 'on' : ''}`} aria-hidden="true" />
          <span className="seek-window-title">
            {`${SITE_NAME[status.session.target ?? 'seek']} sign-in`}
          </span>
          <span className="job-meta seek-window-time">{minutesLeft} min left</span>
          <button className="btn btn-small" disabled={busy} onClick={() => void close(false)}>
            {busy ? 'Closing…' : 'Close'}
          </button>
          <button className="btn primary btn-small" disabled={busy} onClick={() => void close(true)}>
            {busy
              ? status.session.target === 'seek' || status.session.target === 'indeed'
                ? `Checking with ${SITE_NAME[status.session.target]}…`
                : 'Closing…'
              : 'Done'}
          </button>
        </div>
        {status.session.assist && (
          <div className={`signin-assist ${status.session.assist.state}`} role="status">
            {status.session.assist.message}
          </div>
        )}
        {error && <div className="banner banner-bad seek-window-error">{error}</div>}
        <SigninViewer session={status.session} onConnectionChange={setConnected}
          onRetry={() => void open(status.session?.target ?? 'seek', true)} />
      </div>
    </div>, document.body
  );
}
