import { WebSocket, WebSocketServer } from 'ws';
import { currentUser } from './auth.js';
import { readEnv, runner } from './runner.js';


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
export function cdpBase(portOverride?: number): string {
  const env = readEnv();
  const host = process.env.CDP_HOST ?? env.CDP_HOST ?? '127.0.0.1';
  const port = portOverride ?? Number(process.env.CDP_PORT ?? env.CDP_PORT ?? 9333);
  return `http://${host}:${port}`;
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export async function listTargets(port?: number): Promise<CdpTarget[]> {
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
  private cdp: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;

  // Explicit fields rather than constructor parameter properties: the project
  // builds with `erasableSyntaxOnly`, which disallows the shorthand.
  private client: WebSocket;
  private targetWsUrl: string;

  constructor(client: WebSocket, targetWsUrl: string) {
    this.client = client;
    this.targetWsUrl = targetWsUrl;
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve) => {
      if (!this.cdp || this.cdp.readyState !== WebSocket.OPEN) return resolve(null);
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.cdp.send(JSON.stringify({ id, method, params }));
    });
  }

  async start(quality: number, maxWidth: number) {
    this.cdp = new WebSocket(this.targetWsUrl, { perMessageDeflate: false });

    this.cdp.on('open', async () => {
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

    this.cdp.on('close', () => this.safeSend({ type: 'detached' }));
    this.cdp.on('error', (e) => this.safeSend({ type: 'error', message: e.message }));
  }

  /** One-off screenshot pushed as a frame, for static pages. */
  private async prime() {
    const shot = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
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

  private safeSend(payload: unknown) {
    if (this.closed) return;
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(payload));
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
    void currentUser(req.headers?.cookie).then((user) => {
      const port = user ? runner.browserPortFor(user.id) : null;
      if (!user || !port) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      req.runBrowserPort = port;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }).catch(() => {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    });
  });

  wss.on('connection', async (client, req: any) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const quality = Math.max(30, Math.min(80, Number(url.searchParams.get('quality') ?? 60)));
    const maxWidth = Math.max(800, Math.min(1600, Number(url.searchParams.get('width') ?? 1440)));
    const port = Number(req.runBrowserPort);

    let session: Session | null = null;
    let current: CdpTarget | null = null;
    /** Page targets in the order they were first seen; the newest is the one the run is working in. */
    const seen: string[] = [];
    const viewable = (t: CdpTarget) =>
      t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome://') && Boolean(t.webSocketDebuggerUrl);

    const attach = async (target: CdpTarget) => {
      await session?.stop();
      current = target;
      client.send(JSON.stringify({ type: 'attached', target: { id: target.id, url: target.url, title: target.title } }));
      session = new Session(client, target.webSocketDebuggerUrl!);
      await session.start(quality, maxWidth);
    };

    try {
      const targets = (await listTargets(port)).filter(viewable);
      for (const t of targets) seen.push(t.id);
      const target = targets[0];
      if (!target) {
        client.send(JSON.stringify({ type: 'error', message: 'The live view is still getting ready.' }));
        client.close();
        return;
      }
      await attach(target);
    } catch (e) {
      client.send(
        JSON.stringify({
          type: 'error',
          message: 'The live view is still getting ready. Please try again in a moment.',
        }),
      );
      client.close();
      return;
    }

    /**
     * Follow the run into whichever tab it is working in.
     *
     * Indeed's application form and every employer site open in a new tab,
     * and a viewer pinned to the first tab watched the search results sit
     * still for the whole application. The newest tab still open is where
     * the work is; when it closes, the view falls back to the one before it.
     */
    let switching = false;
    const follow = setInterval(async () => {
      if (switching || client.readyState !== WebSocket.OPEN) return;
      switching = true;
      try {
        const targets = (await listTargets(port)).filter(viewable);
        const byId = new Map(targets.map((t) => [t.id, t]));
        for (const t of targets) if (!seen.includes(t.id)) seen.push(t.id);
        const newest = [...seen].reverse().map((id) => byId.get(id)).find(Boolean) ?? null;
        if (newest && newest.id !== current?.id) await attach(newest);
      } catch {
        // The browser may be between pages, or gone; the next tick will see.
      } finally {
        switching = false;
      }
    }, 1500);

    // Deliberately no `message` handler: the browser connection is view-only
    // even if a client manually sends mouse, keyboard or navigation commands.
    client.on('close', () => {
      clearInterval(follow);
      void session?.stop();
    });
  });
}
