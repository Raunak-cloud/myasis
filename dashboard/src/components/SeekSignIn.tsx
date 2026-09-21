import { useCallback, useEffect, useRef, useState } from 'react';
import { BOARDS_CHANGED, OPEN_BOARD_SIGNIN } from '../boards';

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

interface Session {
  display: number;
  startedAt: number;
  expiresAt: number;
  password: string;
  /** Which sign-in this window was opened for; only the labels differ. */
  target?: 'seek' | 'indeed' | 'gmail';
  assist?: {
    state: 'waiting' | 'clicked' | 'unavailable' | 'failed';
    message: string;
  };
}

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

const SITE_NAME = { seek: 'SEEK', indeed: 'Indeed' } as const;

export function SeekSignIn({ indeedEnabled = false, onVerifyingChange }: {
  indeedEnabled?: boolean;
  /** Told whenever a sign-in check starts or settles, so the page can hold a run back until it has. */
  onVerifyingChange?: (verifying: boolean) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<{ disconnect: () => void } | null>(null);

  const refresh = useCallback(async (verify = false) => {
    try {
      const sites = indeedEnabled ? 'seek,indeed' : 'seek';
      const response = await fetch(
        verify ? `/api/signin/session?verify=${encodeURIComponent(sites)}` : '/api/signin/session',
      );
      setStatus(await response.json());
      window.dispatchEvent(new Event(BOARDS_CHANGED));
    } catch {
      setStatus({ supported: false, session: null });
    }
  }, [indeedEnabled]);

  useEffect(() => {
    // A saved green tick is only the last thing a run observed. Verify every
    // selected board when this indicator appears so it describes the account
    // now, rather than repeating a result that may be hours or days old.
    void refresh(true);
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

  // Connect the viewer once a session exists and the canvas is on screen.
  useEffect(() => {
    const session = status?.session;
    if (!session || !screen.current || rfb.current) return;
    let cancelled = false;

    void (async () => {
      try {
        const { default: RFB } = await import('@novnc/novnc');
        if (cancelled || !screen.current) return;
        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        const client = new RFB(screen.current, `${scheme}://${location.host}/ws/signin`, {
          credentials: { password: session.password },
        });
        client.scaleViewport = true;
        client.background = 'transparent';
        client.addEventListener('connect', () => setConnected(true));
        client.addEventListener('disconnect', () => {
          setConnected(false);
          rfb.current = null;
        });
        rfb.current = client as unknown as { disconnect: () => void };
      } catch (reason) {
        setError(`Could not open the viewer: ${(reason as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status?.session]);

  // Keeps the remaining-time figure honest, and clears the panel once the
  // server has expired the session on its side.
  useEffect(() => {
    if (!status?.session) return;
    const tick = setInterval(() => {
      setNow(Date.now());
      if (Date.now() > status.session!.expiresAt) void refresh();
    }, 15_000);
    return () => clearInterval(tick);
  }, [status?.session, refresh]);

  // The server selects a known Google account for Indeed after the page has
  // rendered. Poll only while that one bounded action is still in progress.
  useEffect(() => {
    if (status?.session?.assist?.state !== 'waiting') return;
    const tick = setInterval(() => void refresh(), 1_500);
    return () => clearInterval(tick);
  }, [status?.session?.assist?.state, refresh]);

  async function open(target: 'seek' | 'indeed' = 'seek', manual = false) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // A desktop install has a real screen; use a normal Chrome window there.
      const path = status?.supported ? '/api/signin/session' : `/api/browser/manual-login?target=${target}`;
      const response = await fetch(path, {
        method: 'POST',
        headers: status?.supported ? { 'Content-Type': 'application/json' } : undefined,
        body: status?.supported ? JSON.stringify({ target, manual }) : undefined,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not open the browser.');
      if (status?.supported) setStatus({ supported: true, session: body.session });
      else setNotice(`Chrome opened on this computer. Sign in to ${target === 'indeed' ? 'Indeed' : 'SEEK'} there, then close it.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function close(verifySignIn: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      rfb.current?.disconnect();
    } catch {
      /* already gone */
    }
    rfb.current = null;
    setConnected(false);
    const target = status?.session?.target ?? 'seek';
    try {
      const path = verifySignIn ? '/api/signin/session' : '/api/signin/session?cancel=true';
      const body = await fetch(path, { method: 'DELETE' }).then((r) => r.json());
      const seek: SeekState | null = body?.seek ?? null;
      const indeed: SeekState | null = body?.indeed ?? null;
      setStatus({ supported: true, session: null, seek, indeed });
      // Only the site that was just checked can say anything new.
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
      setBusy(false);
    }
  }

  // Asked for from the Job boards dialog: the person is signing in themselves, so nothing picks an account for them.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onAsk = (event: Event) => void openRef.current((event as CustomEvent<'seek' | 'indeed'>).detail, true);
    window.addEventListener(OPEN_BOARD_SIGNIN, onAsk);
    return () => window.removeEventListener(OPEN_BOARD_SIGNIN, onAsk);
  }, []);

  if (!status) return null;
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
    if (seekSettled && indeedSettled && !error && !notice) return null;

    const expired = status.seek?.signedIn === false;
    const indeedExpired = status.indeed?.signedIn === false;
    return (
      <div className="seek-connect">
        {error && <div className="banner banner-bad">{error}</div>}
        {notice && <div className={`banner ${/signed out|could not/i.test(notice) ? 'banner-bad' : 'banner-ok'}`}>{notice}</div>}
        {!status.seek?.signedIn && !status.checking && <div className="seek-connect-row">
          <div>
            <h3>SEEK account</h3>
            <p className="job-meta">
              {expired
                ? 'SEEK shows this account signed out. Sign in again to keep applying.'
                : 'Sign in once. Applications are sent from your own account.'}
            </p>
          </div>
          <button className="btn primary" disabled={busy} onClick={() => open('seek')}>
            {busy ? 'Opening…' : expired ? 'Sign in again' : 'Open SEEK'}
          </button>
        </div>}
        {indeedEnabled && !status.indeed?.signedIn && <div className="seek-connect-row">
          <div>
            <h3>Indeed account</h3>
            <p className="job-meta">
              {indeedExpired
                ? 'Indeed shows this account signed out. Sign in again to keep applying.'
                : 'Sign in once, or clear a verification check, in your own Indeed browser.'}
            </p>
          </div>
          <button className="btn" disabled={busy} onClick={() => open('indeed')}>
            {busy ? 'Opening…' : indeedExpired ? 'Sign in again' : 'Open Indeed'}
          </button>
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
  return (
    <div className="overlay center" role="dialog" aria-modal="true" aria-label="Browser sign-in">
      <div className="card seek-window">
        <div className="seek-window-bar">
          <span className={`seek-dot ${connected ? 'on' : ''}`} aria-hidden="true" />
          <span className="seek-window-title">
            {status.session.target === 'gmail' ? 'Gmail sign-in' : status.session.target === 'indeed' ? 'Indeed sign-in' : 'SEEK sign-in'}
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
        <div className="seek-window-screen" ref={screen} />
      </div>
    </div>
  );
}
