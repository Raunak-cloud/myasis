import { WebSocket, WebSocketServer } from 'ws';
import { readEnv } from './runner.js';


/**
 * Live browser view over the Chrome DevTools Protocol.
 *
 * Chrome's `Page.startScreencast` emits JPEG frames; `Input.*` accepts synthetic
 * mouse and keyboard events. Together that is a remote-control surface for a
 * browser running anywhere. This is useful for observing the worker and for
 * ordinary interaction. It is not a reliable CAPTCHA handoff because CDP input
 * is synthetic; security verification should use a normal desktop Chrome
 * window (local install) or a secure OS-level remote desktop (VPS).
 *
 * Chosen over VNC deliberately: no X11/Xvfb/x11vnc stack to install, and it
 * reuses the same debugging port Patchright already talks to.
 */

/**
 * Resolved per request rather than at module load, so the endpoint can be
 * repointed by editing seek-bot/.env — no dashboard restart — and a VPS can
 * host the browser somewhere other than localhost.
 */
export function cdpBase(): string {
  const env = readEnv();
  const host = process.env.CDP_HOST ?? env.CDP_HOST ?? '127.0.0.1';
  const port = Number(process.env.CDP_PORT ?? env.CDP_PORT ?? 9333);
  return `http://${host}:${port}`;
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export async function listTargets(): Promise<CdpTarget[]> {
  const res = await fetch(`${cdpBase()}/json/list`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`CDP ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

export async function browserInfo(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const res = await fetch(`${cdpBase()}/json/version`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, error: `CDP responded ${res.status}` };
    const j: any = await res.json();
    return { ok: true, version: j.Browser };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Opens a new tab, used when the browser has no page to attach to. */
export async function openTab(url: string): Promise<CdpTarget | null> {
  const res = await fetch(`${cdpBase()}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) return null;
  return (await res.json()) as CdpTarget;
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
      await this.send('Page.enable');
      await this.send('Runtime.enable');
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

  /** Relays a viewer gesture into the page. */
  async input(msg: any) {
    switch (msg.type) {
      case 'mouse':
        await this.send('Input.dispatchMouseEvent', {
          type: msg.event, // mousePressed | mouseReleased | mouseMoved
          x: msg.x,
          y: msg.y,
          button: msg.button ?? 'left',
          clickCount: msg.clickCount ?? 1,
          modifiers: msg.modifiers ?? 0,
        });
        break;
      case 'wheel':
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: msg.x,
          y: msg.y,
          deltaX: msg.deltaX ?? 0,
          deltaY: msg.deltaY ?? 0,
          modifiers: msg.modifiers ?? 0,
        });
        break;
      case 'key':
        await this.send('Input.dispatchKeyEvent', {
          type: msg.event, // keyDown | keyUp | char
          text: msg.text,
          unmodifiedText: msg.text,
          key: msg.key,
          code: msg.code,
          windowsVirtualKeyCode: msg.keyCode,
          nativeVirtualKeyCode: msg.keyCode,
          modifiers: msg.modifiers ?? 0,
        });
        break;
      case 'text':
        await this.send('Input.insertText', { text: msg.text });
        break;
      case 'navigate':
        await this.send('Page.navigate', { url: msg.url });
        break;
      case 'reload':
        await this.send('Page.reload', {});
        break;
      case 'back':
      case 'forward': {
        const hist = await this.send('Page.getNavigationHistory', {});
        if (!hist) break;
        const idx = hist.currentIndex + (msg.type === 'back' ? -1 : 1);
        const entry = hist.entries?.[idx];
        if (entry) await this.send('Page.navigateToHistoryEntry', { entryId: entry.id });
        break;
      }
    }
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

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws/screencast')) return; // leave HMR alone
    wss.handleUpgrade(req, socket as any, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (client, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const quality = Number(url.searchParams.get('quality') ?? 60);
    const maxWidth = Number(url.searchParams.get('width') ?? 1280);
    const wantTarget = url.searchParams.get('target');

    let session: Session | null = null;
    try {
      const targets = (await listTargets()).filter(
        (t) => t.type === 'page' && !t.url.startsWith('devtools://'),
      );
      const target =
        targets.find((t) => t.id === wantTarget) ??
        targets.find((t) => !t.url.startsWith('chrome://')) ??
        targets[0];

      if (!target?.webSocketDebuggerUrl) {
        client.send(
          JSON.stringify({
            type: 'error',
            message: 'No page to attach to. Open a tab in the browser first.',
          }),
        );
        client.close();
        return;
      }

      client.send(JSON.stringify({ type: 'attached', target: { id: target.id, url: target.url, title: target.title } }));
      session = new Session(client, target.webSocketDebuggerUrl);
      await session.start(quality, maxWidth);
    } catch (e) {
      client.send(
        JSON.stringify({
          type: 'error',
          message: `Cannot reach Chrome at ${cdpBase()}: ${(e as Error).message}`,
        }),
      );
      client.close();
      return;
    }

    client.on('message', async (raw) => {
      try {
        await session?.input(JSON.parse(raw.toString()));
      } catch {
        /* malformed frame from the viewer — ignore */
      }
    });
    client.on('close', () => session?.stop());
  });
}
