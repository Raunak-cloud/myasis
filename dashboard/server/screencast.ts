import { WebSocket, WebSocketServer } from 'ws';
import { upgradeOriginAllowed } from './http-guards.js';
import { currentUser } from './auth.js';
import { readEnv, runner } from './runner.js';
import { userDir } from './userdata.js';
import { readLiveWorkers, readLiveTarget, type LiveWorkerId } from '../../seek-bot/src/live-workers.js';


/**
 * Live browser view over the Chrome DevTools Protocol.
 *
 * Chrome's `Page.startScreencast` emits JPEG frames; `Input.*` accepts synthetic
 * The product uses only Page.startScreencast: frames travel from Chrome to the
 * signed-in owner, and no input messages travel back. Sign-in remains on the
 * separate authenticated VNC session because that workflow requires control.
 *
 * Chosen over VNC deliberately: no X11/Xvfb/x11vnc stack to install, and it
 * reuses the same debugging port Patchright already talks to.
 */

/**
 * Resolved per request rather than at module load, so the endpoint can be
 * repointed by editing seek-bot/.env — no dashboard restart — and a VPS can
 * host the browser somewhere other than localhost.
 */
function cdpBase(portOverride?: number): string {
  const env = readEnv();
  const host = process.env.CDP_HOST ?? env.CDP_HOST ?? '127.0.0.1';
  const port = portOverride ?? Number(process.env.CDP_PORT ?? env.CDP_PORT ?? 9333);
  return `http://${host}:${port}`;
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function listTargets(port?: number): Promise<CdpTarget[]> {
  const res = await fetch(`${cdpBase(port)}/json/list`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`CDP ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

type Pending = (msg: any) => void;

/**
 * One viewer session: a socket to the browser tab and a socket to the dashboard,
 * pumping frames one way and input the other.
 */
class Session {
  disconnected = false;
  private cdp: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private frameQuality = 60;

  // Explicit fields rather than constructor parameter properties: the project
  // builds with `erasableSyntaxOnly`, which disallows the shorthand.
  private client: WebSocket;
  private targetWsUrl: string;
  private workerId: LiveWorkerId;

  constructor(client: WebSocket, targetWsUrl: string, workerId: LiveWorkerId) {
    this.client = client;
    this.targetWsUrl = targetWsUrl;
    this.workerId = workerId;
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve) => {
      if (!this.cdp || this.cdp.readyState !== WebSocket.OPEN) return resolve(null);
      const id = this.nextId++;
      const deadline = setTimeout(() => { this.pending.delete(id); resolve(null); }, 5_000);
      this.pending.set(id, result => { clearTimeout(deadline); resolve(result); });
      this.cdp.send(JSON.stringify({ id, method, params }));
    });
  }

  async start(quality: number, maxWidth: number) {
    this.frameQuality = quality;
    this.cdp = new WebSocket(this.targetWsUrl, { perMessageDeflate: false });

    this.cdp.on('open', async () => {
      if (this.closed) return;
      /**
       * Page domain only. Never enable Runtime here: that is the single
       * biggest thing Cloudflare fingerprints in a CDP-driven tab, and the
       * exact leak Patchright exists to avoid. A tab Cloudflare has flagged
       * fails the Turnstile checkbox even for a person clicking in the real
       * window. Screencast, screenshots and Input.* do not need it.
       */
      await this.send('Page.enable');
      await this.send('Page.startScreencast', {
        format: 'jpeg',
        quality,
        maxWidth,
        maxHeight: Math.round((maxWidth * 9) / 16) * 2,
        everyNthFrame: 1,
      });
      this.safeSend({ type: 'ready' });

      /**
       * `startScreencast` only emits when the page *changes*, so attaching to a
       * static page shows nothing until something moves — indistinguishable
       * from a broken connection. Prime the view with one screenshot, and keep
       * a slow heartbeat so the picture cannot silently go stale.
       */
      await this.prime();
      if (this.closed) return;
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastFrameAt > 3000) void this.prime();
      }, 3000);
    });

    this.cdp.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg.result);
        this.pending.delete(msg.id);
        return;
      }

      if (msg.method === 'Page.screencastFrame') {
        const { data, sessionId, metadata } = msg.params;
        // Must ack or Chrome stops sending frames.
        this.send('Page.screencastFrameAck', { sessionId });
        this.lastFrameAt = Date.now();
        this.safeSend({ type: 'frame', data, metadata });
      } else if (msg.method === 'Page.frameNavigated' && !msg.params?.frame?.parentId) {
        this.safeSend({ type: 'navigated', url: msg.params.frame.url });
      }
    });

    this.cdp.on('close', () => { this.disconnected = true; this.safeSend({ type: 'detached' }); });
    this.cdp.on('error', (e) => { this.disconnected = true; this.safeSend({ type: 'error', message: e.message }); });
  }

  /** One-off screenshot pushed as a frame, for static pages. */
  private async prime() {
    // Keep static-page refreshes at the same quality as live screencast frames.
    // A lower hard-coded value made an initially sharp view turn visibly soft
    // after the three-second heartbeat replaced it.
    const shot = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: this.frameQuality });
    if (!shot?.data) return;
    const m = await this.send('Page.getLayoutMetrics', {});
    const vp = m?.cssLayoutViewport ?? m?.layoutViewport;
    this.lastFrameAt = Date.now();
    this.safeSend({
      type: 'frame',
      data: shot.data,
      metadata: { deviceWidth: vp?.clientWidth ?? 1280, deviceHeight: vp?.clientHeight ?? 720 },
    });
  }

  private safeSend(payload: Record<string, unknown>) {
    if (this.closed) return;
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify({ ...payload, workerId: this.workerId }));
  }

  async stop() {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.send('Page.stopScreencast').catch(() => {});
    this.cdp?.close();
    this.cdp = null;
  }
}

/**
 * Attaches the screencast WebSocket to the dev/preview server.
 * A separate path from Vite's HMR socket so the two do not collide.
 */
/** Accepts any Node-style server that emits 'upgrade' (Vite's type is wider than http.Server). */
export function attachScreencast(server: { on: (ev: string, cb: (...a: any[]) => void) => unknown }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: any, socket: any, head: any) => {
    if (!req.url?.startsWith('/ws/screencast')) return; // leave HMR alone
    if (!upgradeOriginAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    void currentUser(req.headers?.cookie).then((user) => {
      const port = user ? runner.browserPortFor(user.id) : null;
      if (!user || !port) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      req.runBrowserPort = port;
      req.runUserId = user.id;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }).catch(() => {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    });
  });

  wss.on('connection', (client, req: any) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const bounded = (name: string, fallback: number, min: number, max: number) => {
      const value = Number(url.searchParams.get(name) ?? fallback);
      return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    };
    streamLiveWorkers(client, {
      directory: userDir(String(req.runUserId)), port: Number(req.runBrowserPort),
      quality: bounded('quality', 82, 30, 90), maxWidth: bounded('width', 1440, 800, 1600),
    });
  });
}

interface WorkerStream {
  session: Session | null;
  current: CdpTarget | null;
  state: string;
  activityKey: string;
}

/** One authenticated socket carries independent, account-owned worker streams.
 * The optional target reader is for offline fixtures; callers never supply a
 * browser port, worker path, or target through a client message.
 */
export function streamLiveWorkers(client: WebSocket, options: {
  directory: string; port: number; quality: number; maxWidth: number;
  targets?: (port: number) => Promise<CdpTarget[]>;
  intervalMs?: number;
}): void {
  const streams = new Map<LiveWorkerId, WorkerStream>();
  let roster = '', disposed = false, switching = false;
  const send = (message: Record<string, unknown>) => {
    if (!disposed && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const stop = async (stream: WorkerStream) => {
    const session = stream.session;
    stream.session = null; stream.current = null;
    await session?.stop();
  };
  const update = async () => {
    if (disposed || switching || client.readyState !== WebSocket.OPEN) return;
    switching = true;
    try {
      const workers = readLiveWorkers(options.directory);
      const nextRoster = JSON.stringify(workers);
      if (nextRoster !== roster) {
        roster = nextRoster;
        send({ type: 'workers', workers });
        for (const [id, stream] of streams) if (!workers.some(worker => worker.id === id)) {
          streams.delete(id); await stop(stream);
        }
      }
      // Fetch once per tick, shared by both streams. Never guess another
      // worker's target when its own page is between tabs or closed.
      const targets = await (options.targets ?? listTargets)(options.port).catch(() => []);
      if (disposed) return;
      await Promise.all(workers.map(async worker => {
        let stream = streams.get(worker.id);
        if (!stream) {
          stream = { session: null, current: null, state: '', activityKey: '' };
          streams.set(worker.id, stream);
        }
        const emit = (message: Record<string, unknown>) => send({ ...message, workerId: worker.id });
        const waiting = async (state: string, finished = false) => {
          await stop(stream!);
          if (stream!.state !== state) emit({ type: 'waiting', finished });
          stream!.state = state;
        };
        const named = readLiveTarget(options.directory, worker.id);
        const activity = named?.activity;
        const activityKey = JSON.stringify(activity ?? null);
        if (activityKey !== stream.activityKey) {
          emit({ type: 'activity', activity: activity ?? null });
          stream.activityKey = activityKey;
        }
        if (named?.finished || activity?.phase === 'finished') { await waiting('finished', true); return; }
        if (activity && activity.phase !== 'applying' && activity.phase !== 'reviewing') {
          await waiting(activity.phase); return;
        }
        const pages = targets.filter(target => target.type === 'page'
          && !/^(devtools|chrome):/.test(target.url) && Boolean(target.webSocketDebuggerUrl));
        const active = named?.targetId ? pages.find(target => target.id === named.targetId)
          : worker.id === 'main' ? pages.find(target => target.id === stream!.current?.id) ?? pages[0] : undefined;
        if (!active) { await waiting('waiting'); return; }
        if (active.id !== stream.current?.id || stream.session?.disconnected) {
          await stop(stream);
          if (disposed) return;
          stream.current = active; stream.state = 'local';
          emit({ type: 'attached', target: { id: active.id, url: active.url, title: active.title } });
          stream.session = new Session(client, active.webSocketDebuggerUrl!, worker.id);
          await stream.session.start(options.quality, options.maxWidth);
        }
      }));
    } finally { switching = false; }
  };
  const follow = setInterval(() => { void update().catch(() => {}); }, options.intervalMs ?? 1500);
  // View-only: no client message handler or Input/Runtime CDP commands.
  client.once('close', () => {
    disposed = true; clearInterval(follow);
    for (const stream of streams.values()) void stop(stream);
    streams.clear();
  });
  void update().catch(() => {});
}
