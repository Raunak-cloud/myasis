import { useEffect, useRef, useState } from 'react';

export interface BrowserSigninSession {
  id?: string;
  display: number;
  startedAt: number;
  expiresAt: number;
  password: string;
  target?: 'seek' | 'indeed';
  state?: 'starting' | 'ready' | 'recovering' | 'failed' | 'closed';
  revision?: number;
  message?: string;
  assist?: { state: 'waiting' | 'clicked' | 'unavailable' | 'failed'; message: string };
}

/** Transport reconnects preserve the form. Process recovery is owned by the
 * server and announced through session revisions; never launch a second browser.
 */
export function SigninViewer({ session, onConnectionChange, onRetry }: {
  session: BrowserSigninSession;
  onConnectionChange: (connected: boolean) => void;
  onRetry: () => void;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const [retry, setRetry] = useState(0);
  const [connected, setConnected] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const attempts = useRef(0);
  const state = session.state ?? 'ready';
  const identity = session.id ?? String(session.startedAt);
  useEffect(() => { attempts.current = 0; setExhausted(false); }, [identity, session.revision]);
  useEffect(() => {
    setConnected(false); onConnectionChange(false);
    if (state !== 'ready' || !screen.current) return;
    let cancelled = false;
    let client: {disconnect: () => void} | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let disconnected = false;
    const reconnect = () => {
      if (cancelled || disconnected) return;
      disconnected = true;
      clearTimeout(stableTimer); clearTimeout(connectTimer);
      setConnected(false); onConnectionChange(false);
      if (++attempts.current > 5) { setExhausted(true); return; }
      reconnectTimer = setTimeout(() => setRetry(value => value + 1), Math.min(1_000 * 2 ** (attempts.current - 1), 8_000));
    };
    void (async () => {
      try {
        const { default: RFB } = await import('@novnc/novnc');
        if (cancelled || !screen.current) return;
        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        const rfb = new RFB(screen.current, `${scheme}://${location.host}/ws/signin`, { credentials: {password: session.password} });
        client = rfb;
        connectTimer = setTimeout(() => { reconnect(); rfb.disconnect(); }, 10_000);
        rfb.scaleViewport = true; rfb.background = 'transparent';
        rfb.addEventListener('connect', () => {
          if (cancelled) return;
          clearTimeout(connectTimer);
          setConnected(true); setExhausted(false); onConnectionChange(true);
          stableTimer = setTimeout(() => { attempts.current = 0; }, 10_000);
        });
        rfb.addEventListener('disconnect', reconnect);
      } catch { reconnect(); }
    })();
    return () => {
      cancelled = true; clearTimeout(reconnectTimer); clearTimeout(stableTimer); clearTimeout(connectTimer);
      client?.disconnect();
    };
  }, [identity, session.revision, session.password, state, retry, onConnectionChange]);

  const failed = state === 'failed' || state === 'closed';
  return <>
    {(!connected || session.message) && <div className={`banner ${failed ? 'banner-bad' : ''}`} role={failed ? 'alert' : 'status'}>
      {failed ? session.message || 'The sign-in browser stopped. Please retry.'
        : state !== 'ready' ? session.message || 'Restoring your sign-in window...'
        : exhausted ? 'The screen could not reconnect. Your sign-in browser may still be open.'
        : !connected ? 'Connecting to your sign-in screen...' : session.message}
      {failed && <button className="btn btn-small" onClick={onRetry}>Retry sign-in</button>}
      {exhausted && state === 'ready' && <button className="btn btn-small" onClick={() => {
        attempts.current = 0; setExhausted(false); setRetry(value => value + 1);
      }}>Reconnect screen</button>}
    </div>}
    <div className="seek-window-screen" ref={screen} />
  </>;
}
