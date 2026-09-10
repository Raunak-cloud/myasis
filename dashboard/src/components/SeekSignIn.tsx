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
}

type Status = { supported: boolean; session: Session | null };

export function SeekSignIn() {
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

  async function open() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // A desktop install has a real screen; use a normal Chrome window there.
      const path = status?.supported ? '/api/signin/session' : '/api/browser/manual-login';
      const response = await fetch(path, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not open the browser.');
      if (status?.supported) setStatus({ supported: true, session: body.session });
      else setNotice('Chrome opened on this computer. Sign in there, then close it.');
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
    try {
      await fetch('/api/signin/session', { method: 'DELETE' });
    } finally {
      setStatus({ supported: true, session: null });
      setBusy(false);
    }
  }

  if (!status) return null;
  const minutesLeft = status.session ? Math.max(0, Math.round((status.session.expiresAt - now) / 60000)) : 0;

  if (!status.session) {
    return (
      <div className="seek-connect">
        {error && <div className="banner banner-bad">{error}</div>}
        {notice && <div className="banner banner-ok">{notice}</div>}
        <div className="seek-connect-row">
          <div>
            <h3>SEEK account</h3>
            <p className="job-meta">Sign in once. Applications are sent from your own account.</p>
          </div>
          <button className="btn primary" disabled={busy} onClick={open}>
            {busy ? 'Opening…' : 'Open SEEK'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="seek-window">
      <div className="seek-window-bar">
        <span className={`seek-dot ${connected ? 'on' : ''}`} aria-hidden="true" />
        <span className="seek-window-title">SEEK sign-in</span>
        <span className="job-meta seek-window-time">{minutesLeft} min left</span>
        <button className="btn btn-small" disabled={busy} onClick={close}>
          {busy ? 'Closing…' : 'Done'}
        </button>
      </div>
      {error && <div className="banner banner-bad seek-window-error">{error}</div>}
      <div className="seek-window-screen" ref={screen} />
    </div>
  );
}
