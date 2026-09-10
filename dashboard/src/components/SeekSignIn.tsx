import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Signing in to SEEK on the server, in your own browser.
 *
 * The agent never handles anyone's password: each account's SEEK session has
 * to be created by that person. On a hosted server there is no screen, so
 * this opens a private virtual one — a real Chrome on this account's own
 * profile — and streams it here. Keyboard and mouse go through as ordinary
 * input, which matters because SEEK's login sits behind a bot check that
 * rejects synthetic typing.
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

  // Keeps the "closes in N minutes" countdown honest, and clears the panel
  // once the server has expired the session on its side.
  useEffect(() => {
    if (!status?.session) return;
    const tick = setInterval(() => {
      setNow(Date.now());
      if (Date.now() > status.session!.expiresAt) void refresh();
    }, 15_000);
    return () => clearInterval(tick);
  }, [status?.session, refresh]);

  function disconnectViewer() {
    try {
      rfb.current?.disconnect();
    } catch {
      /* already gone */
    }
    rfb.current = null;
    setConnected(false);
  }

  async function open() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/signin/session', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not open the sign-in browser.');
      setStatus({ supported: true, session: body.session });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (busy) return;
    setBusy(true);
    disconnectViewer();
    try {
      await fetch('/api/signin/session', { method: 'DELETE' });
    } finally {
      setStatus({ supported: true, session: null });
      setBusy(false);
    }
  }

  if (!status) return null;

  if (!status.supported && !status.session) {
    return (
      <p className="job-meta">
        Remote sign-in is available on the hosted server. On this machine, use the local Chrome sign-in on the Apply
        screen instead.
      </p>
    );
  }

  const minutesLeft = status.session ? Math.max(0, Math.round((status.session.expiresAt - now) / 60000)) : 0;

  return (
    <div className="signin">
      {error && <div className="banner banner-bad">{error}</div>}

      {!status.session ? (
        <>
          <p className="job-meta">
            Opens a private browser on the server, signed in to nothing. Sign in to SEEK as you normally would; the
            session is saved to your own profile and used for your applications. Nobody else can see this window.
          </p>
          <button className="btn primary" disabled={busy} onClick={open}>
            {busy ? 'Opening…' : 'Open SEEK sign-in'}
          </button>
        </>
      ) : (
        <>
          <div className="run-actions signin-bar">
            <span className="job-meta">
              {connected ? 'Connected.' : 'Connecting…'} This window closes automatically in {minutesLeft} minute
              {minutesLeft === 1 ? '' : 's'}.
            </span>
            <button className="btn primary" disabled={busy} onClick={close}>
              {busy ? 'Closing…' : "I'm signed in — close"}
            </button>
          </div>
          <div className="signin-screen" ref={screen} />
        </>
      )}
    </div>
  );
}
