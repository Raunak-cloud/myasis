import { browserRoute } from './route.js';
import { upgradeOriginAllowed } from './http-guards.js';
import { createConnection } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { currentUser } from './auth.js';
import { readEnv } from './runner.js';
import { userChromeDir, ensureUserDataDir } from './userdata.js';
import { chromeGoogleAccounts } from './chrome-accounts.js';
import { assistIndeedGoogleSignin } from './signin-assist.js';
import { releaseChromeProfile } from './chrome-profile.js';
import { SigninInputFilter } from './signin-input.js';
import { SigninDesktop } from './signin-desktop.js';
import { SigninSessions, type SigninTarget } from './signin-sessions.js';

const START_URLS: Record<SigninTarget, string> = {
  seek: 'https://www.seek.com.au/oauth/login/',
  indeed: 'https://secure.indeed.com/account/login?hl=en_AU&co=AU',
  gmail: 'https://accounts.google.com/AddSession?service=mail',
};

/** Each account owns its profile, desktop processes, lease and recovery budget.
 * VNC and Chrome debugging listen only on loopback. Only the authenticated
 * owner may see or drive the private sign-in screen; credentials remain manual.
 */
const desktops = new SigninSessions(async (session, assist) => {
  const { userId, target, id } = session;
  ensureUserDataDir(userId);
  const profileDir = userChromeDir(userId);
  if (!await releaseChromeProfile(profileDir)) throw new Error('The previous browser is still closing. Please retry shortly.');
  const route = await browserRoute(userId);
  const account = target === 'indeed' && assist ? chromeGoogleAccounts(userId)[0] : undefined;
  if (target === 'indeed') session.assist = account
    ? { state: 'waiting', message: `Selecting ${account} with Google...` }
    : { state: 'unavailable', message: 'No Google account is available in this browser profile. Sign in manually.' };
  const desktop = new SigninDesktop({
    profileDir, chromePath: readEnv().CHROME_PATH?.trim() || '/usr/bin/google-chrome',
    routeArgs: route.args, startUrl: START_URLS[target], password: session.password,
    log: message => console.warn(`[signin ${id}] ${message}`),
    onReady: debugPort => {
      if (!account) return;
      const revision = desktop.revision;
      const active = () => desktops.sessionFor(userId)?.id === id && desktop.revision === revision && desktop.state === 'ready';
      void assistIndeedGoogleSignin({ debugPort, email: account, active,
        update: status => { if (active()) session.assist = status; },
      });
    },
  });
  return desktop;
});

export function signinSupported(): boolean { return process.platform === 'linux'; }
export const sessionFor = (userId: string) => desktops.sessionFor(userId);
export const signinSessionCount = () => desktops.count();
export const stopSignin = (userId: string) => desktops.stop(userId);
export const stopAllSignins = () => desktops.stopAll();

export async function startSignin(userId: string, target: SigninTarget = 'seek', options: { assist?: boolean; expiresAt?: number } = {}) {
  if (!signinSupported()) return { ok: false, error: 'Remote sign-in is only available on the Linux server. On this machine, use the local Chrome sign-in instead.' };
  return desktops.start(userId, target, options.assist !== false, options.expiresAt);
}

/**
 * Bridges the browser's WebSocket to that account's own x11vnc port.
 *
 * The account is taken from the dashboard session cookie, never from the
 * request, so one account cannot ask for another's display.
 */
export function attachSigninVnc(server: { on: (ev: string, cb: (...a: any[]) => void) => unknown }): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  // A restart must not leave a signed-in browser running on a spare display.
  for (const signal of ['SIGINT', 'SIGTERM', 'exit'] as const) {
    process.once(signal, () => { void stopAllSignins(); });
  }

  server.on('upgrade', (req: any, socket: any, head: any) => {
    if (!req.url?.startsWith('/ws/signin')) return; // leave HMR and the screencast alone
    // A page on another site must never drive this browser, whatever cookies it carries.
    if (!upgradeOriginAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    void currentUser(req.headers?.cookie).then((user) => {
      const live = user ? desktops.desktopFor(user.id) : null;
      if (!live || live.state !== 'ready') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        live.closeViewer?.();
        live.closeViewer = bridge(ws, live.vncPort);
      });
    }).catch(() => socket.destroy());
  });
}

/** The authenticated viewer can enter sign-in details, not drive Chrome's UI. */
export function bridge(ws: WebSocket, port: number): () => void {
  const tcp = createConnection({ host: '127.0.0.1', port });
  const input = new SigninInputFilter();
  let open = true;
  const shutdown = () => {
    if (!open) return;
    open = false;
    try {
      for (const packet of input.release()) tcp.write(packet);
      tcp.end();
      tcp.setTimeout(1_000, () => tcp.destroy()).unref();
    } catch {
      /* already gone */
    }
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  };

  tcp.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  tcp.on('error', shutdown);
  tcp.on('close', shutdown);

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    if (!open) return;
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    try {
      for (const packet of input.feed(buf)) tcp.write(packet);
    } catch {
      shutdown();
    }
  });
  ws.on('error', shutdown);
  ws.on('close', shutdown);
  return shutdown;
}
