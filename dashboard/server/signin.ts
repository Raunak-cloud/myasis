import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { currentUser } from './auth.js';
import { readEnv } from './runner.js';
import { userChromeDir, ensureUserDataDir } from './userdata.js';

/**
 * Signing an account in to SEEK on a headless server.
 *
 * The bot never handles credentials, so every account's SEEK session has to
 * be established by that person, in a real browser, on their own Chrome
 * profile. On a desktop that is a Chrome window. On a VPS there is no screen,
 * so this gives each account a private virtual one: its own Xvfb display, its
 * own Chrome on its own profile, and an x11vnc server bound to localhost that
 * the dashboard proxies to the browser over an authenticated WebSocket.
 *
 * Why a real remote desktop rather than the CDP screencast this project
 * already has: protocol-injected keystrokes are exactly what Cloudflare's
 * challenge looks for, and sign-in is the one moment where being rejected is
 * fatal. Here the keyboard and mouse events reach X11 as ordinary input and
 * Chrome cannot tell the difference.
 *
 * Nothing here is reachable from outside. x11vnc listens on 127.0.0.1 only,
 * carries a random password generated per session, and the only route to it
 * is a WebSocket that checks the dashboard session cookie and refuses to
 * bridge one account to another account's display.
 */

const SESSION_MS = 15 * 60_000;
const FIRST_DISPLAY = 100;
const FIRST_PORT = 5900;
const SCREEN = '1280x900x24';

export interface SigninSession {
  userId: string;
  display: number;
  vncPort: number;
  password: string;
  startedAt: number;
  expiresAt: number;
}

interface Live extends SigninSession {
  xvfb: ChildProcess;
  chrome: ChildProcess;
  vnc: ChildProcess;
  passwordDir: string;
  timer: NodeJS.Timeout;
}

const sessions = new Map<string, Live>();

export function signinSupported(): boolean {
  return process.platform === 'linux';
}

/**
 * A display and port nobody is using.
 *
 * The in-memory map is not enough on its own: a dashboard restart forgets its
 * sessions while their Xvfb processes keep running, and X refuses a display
 * whose lock file already exists. Checking the filesystem too means a
 * leftover display is skipped rather than collided with.
 */
function allocate(): { display: number; vncPort: number } {
  const used = new Set([...sessions.values()].map((s) => s.display));
  let display = FIRST_DISPLAY;
  while (used.has(display) || existsSync(`/tmp/.X${display}-lock`) || existsSync(`/tmp/.X11-unix/X${display}`)) {
    display++;
    if (display > FIRST_DISPLAY + 64) throw new Error('No free virtual display. Restart the server to clear stale ones.');
  }
  return { display, vncPort: FIRST_PORT + (display - FIRST_DISPLAY) };
}

function stopProcess(child: ChildProcess | undefined): void {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

export function stopSignin(userId: string): { ok: boolean } {
  const live = sessions.get(userId);
  if (!live) return { ok: false };
  sessions.delete(userId);
  clearTimeout(live.timer);
  // Reverse order: the viewer first, then the browser, then the display it drew on.
  stopProcess(live.vnc);
  stopProcess(live.chrome);
  stopProcess(live.xvfb);
  try {
    rmSync(live.passwordDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  return { ok: true };
}

export function sessionFor(userId: string): SigninSession | null {
  const live = sessions.get(userId);
  if (!live) return null;
  const { userId: id, display, vncPort, password, startedAt, expiresAt } = live;
  return { userId: id, display, vncPort, password, startedAt, expiresAt };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens a private browser for this account and returns what the viewer needs.
 *
 * Chrome runs on the account's own profile, so whatever the person signs in
 * to is exactly what their runs will use afterwards. It is deliberately a
 * plain Chrome — no automation flags, no CDP — because this window exists to
 * be driven by a human.
 */
export async function startSignin(userId: string, startUrl = 'https://www.seek.com.au/oauth/login/'): Promise<{
  ok: boolean;
  error?: string;
  session?: SigninSession;
}> {
  if (!signinSupported()) {
    return { ok: false, error: 'Remote sign-in is only available on the Linux server. On this machine, use the local Chrome sign-in instead.' };
  }
  const existing = sessions.get(userId);
  if (existing) return { ok: true, session: sessionFor(userId)! };

  const env = readEnv();
  const chromePath = env.CHROME_PATH?.trim() || '/usr/bin/google-chrome';
  ensureUserDataDir(userId);
  const profileDir = userChromeDir(userId);
  const { display, vncPort } = allocate();
  const password = randomBytes(8).toString('base64url').slice(0, 8);

  let passwordDir = '';
  let xvfb: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let vnc: ChildProcess | undefined;
  try {
    passwordDir = mkdtempSync(resolve(tmpdir(), 'myasis-vnc-'));
    const passwordFile = resolve(passwordDir, 'passwd');
    // x11vnc -passwd would put the secret in the process list; a 0600 file does not.
    writeFileSync(passwordFile, password);
    chmodSync(passwordFile, 0o600);

    xvfb = spawn('Xvfb', [`:${display}`, '-screen', '0', SCREEN, '-nolisten', 'tcp'], { stdio: 'ignore' });
    xvfb.on('error', () => {});
    await wait(700);
    if (xvfb.exitCode !== null) {
      throw new Error(
        `The virtual display :${display} would not start. If Xvfb is missing, install it with \`apt install xvfb\`; ` +
          'otherwise a stale display is holding it and the server needs a restart.',
      );
    }

    chrome = spawn(
      chromePath,
      [
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-position=0,0',
        '--window-size=1280,900',
        '--test-type',
        startUrl,
      ],
      { env: { ...process.env, DISPLAY: `:${display}` }, stdio: 'ignore' },
    );
    chrome.on('error', () => {});
    // Chrome exiting on its own means the person closed the window; tear the rest down.
    chrome.on('exit', () => stopSignin(userId));
    await wait(1200);
    if (chrome.exitCode !== null) {
      throw new Error(`Chrome could not start. Check CHROME_PATH (${chromePath}) and that the profile is not already in use by a run.`);
    }

    vnc = spawn(
      'x11vnc',
      [
        '-display', `:${display}`,
        '-rfbport', String(vncPort),
        '-localhost',
        '-passwdfile', passwordFile,
        '-forever',
        '-shared',
        '-noxdamage',
        '-quiet',
      ],
      { stdio: 'ignore' },
    );
    vnc.on('error', () => {});
    await wait(700);
    if (vnc.exitCode !== null) throw new Error('x11vnc did not start. Install it with `apt install x11vnc`.');

    const startedAt = Date.now();
    const live: Live = {
      userId,
      display,
      vncPort,
      password,
      startedAt,
      expiresAt: startedAt + SESSION_MS,
      xvfb,
      chrome,
      vnc,
      passwordDir,
      // A forgotten sign-in window is a logged-in browser left open on a server.
      timer: setTimeout(() => stopSignin(userId), SESSION_MS),
    };
    sessions.set(userId, live);
    return { ok: true, session: sessionFor(userId)! };
  } catch (error) {
    stopProcess(vnc);
    stopProcess(chrome);
    stopProcess(xvfb);
    if (passwordDir) {
      try {
        rmSync(passwordDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    return { ok: false, error: (error as Error).message };
  }
}

/** Closes every open sign-in window; used when the server shuts down. */
export function stopAllSignins(): void {
  for (const userId of [...sessions.keys()]) stopSignin(userId);
}

/**
 * Bridges the browser's WebSocket to that account's own x11vnc port.
 *
 * The account is taken from the dashboard session cookie, never from the
 * request, so one account cannot ask for another's display.
 */
export function attachSigninVnc(server: { on: (ev: string, cb: (...a: any[]) => void) => unknown }): void {
  const wss = new WebSocketServer({ noServer: true });

  // A restart must not leave a signed-in browser running on a spare display.
  for (const signal of ['SIGINT', 'SIGTERM', 'exit'] as const) {
    process.once(signal, () => stopAllSignins());
  }

  server.on('upgrade', (req: any, socket: any, head: any) => {
    if (!req.url?.startsWith('/ws/signin')) return; // leave HMR and the screencast alone
    void currentUser(req.headers?.cookie).then((user) => {
      const live = user ? sessions.get(user.id) : null;
      if (!live) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, live.vncPort));
    });
  });
}

/** Plain byte pipe between the WebSocket and the local VNC port. */
function bridge(ws: WebSocket, port: number): void {
  const tcp = createConnection({ host: '127.0.0.1', port });
  let open = true;
  const shutdown = () => {
    if (!open) return;
    open = false;
    try {
      tcp.destroy();
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
    tcp.write(buf);
  });
  ws.on('error', shutdown);
  ws.on('close', shutdown);
}
