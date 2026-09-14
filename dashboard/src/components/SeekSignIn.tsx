import { useCallback, useEffect, useRef, useState } from 'react';

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

export function SeekSignIn({ indeedEnabled = false }: { indeedEnabled?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<{ disconnect: () => void } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/signin/session');
      setStatus(await response.json());
    } catch {
      setStatus({ supported: false, session: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While the server is asking SEEK, keep asking the server.
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

  async function open(target: 'seek' | 'indeed' = 'seek') {
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
        body: status?.supported ? JSON.stringify({ target }) : undefined,
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

  async function close() {
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
      const body = await fetch('/api/signin/session', { method: 'DELETE' }).then((r) => r.json());
      const seek: SeekState | null = body?.seek ?? null;
      const indeed: SeekState | null = body?.indeed ?? null;
      setStatus({ supported: true, session: null, seek, indeed });
      // Only the site that was just checked can say anything new.
      if (target === 'seek' || target === 'indeed') {
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

  if (!status) return null;
  const minutesLeft = status.session ? Math.max(0, Math.round((status.session.expiresAt - now) / 60000)) : 0;

  if (!status.session) {
    /**
     * Nothing to say to an account that is already signed in.
     *
     * "Sign in once" is a one-time instruction, so leaving it on the Apply
     * page forever reads as an unfinished step. It comes back by itself: a
     * run that finds the session dead records that, and the prompt returns
     * with the reason attached.
     */
    const seekSettled = Boolean(status.seek?.signedIn) || Boolean(status.checking);
    const indeedSettled = !indeedEnabled || Boolean(status.indeed?.signedIn);
    /**
     * Signed in everywhere: say so in one line rather than nothing.
     *
     * A green tick per job board is the answer to "did that work?", which
     * a person asks right after closing the window, and it stays as a quiet
     * confirmation afterwards. Still nothing while a check is in progress,
     * since a tick would be a guess.
     */
    if (seekSettled && indeedSettled && !error && !notice) {
      if (status.checking) return null;
      const boards = [['SEEK', true] as const, ...(indeedEnabled ? [['Indeed', true] as const] : [])];
      return (
        <div className="signin-status" role="status" aria-label="Signed in">
          {boards.map(([name]) => (
            <span className="signin-pill" key={name}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              {name}
            </span>
          ))}
        </div>
      );
    }

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
          <button className="btn primary btn-small" disabled={busy} onClick={close}>
            {busy
              ? status.session.target === 'seek' || status.session.target === 'indeed'
                ? `Checking with ${SITE_NAME[status.session.target]}…`
                : 'Closing…'
              : 'Done'}
          </button>
        </div>
        {error && <div className="banner banner-bad seek-window-error">{error}</div>}
        <div className="seek-window-screen" ref={screen} />
      </div>
    </div>
  );
}
