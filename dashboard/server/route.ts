import { connect, createServer, type Server, type Socket } from 'node:net';
import { one } from './db/index.js';
import { upsertSettingRow } from './db/records.js';
import { endpointOf, parseProxy, proxyUrl, resolvesPublic, type ProxyDetails } from './proxy-address.js';
import { onPoolChange, poolHolderOf, pooledProxyFor, reconcilePool } from './proxy-pool.js';

/**
 * Which connection an account's browser goes out on.
 *
 * Every Chrome here runs in a data centre, and job boards treat a data-centre
 * address with more suspicion than a home one. An account can be given a
 * better address — an "exit" — of one of two kinds:
 *
 *  - a home route: a SOCKS tunnel that a machine at the person's home holds
 *    open to this server (deploy/home-route), landing on a loopback port;
 *  - a proxy: a SOCKS5 proxy bought for the account, such as a dedicated
 *    static residential address, reached with a username and password.
 *
 * While the exit answers, the account's browsers go out through it; when it
 * does not they go out from the server as before, so a sleeping PC or a
 * proxy outage costs the better address and never the run. A proxy, when
 * set, is used instead of the home route: an account has one exit.
 *
 * Chrome cannot change proxy once started, cannot log in to a SOCKS proxy at
 * all, and a run must not fail because an exit went away, so Chrome is never
 * pointed at the exit itself. It is pointed at a switch — a small SOCKS server
 * of this process, one per account — that forwards each new connection
 * through the exit or directly. Two rules keep that from looking like an
 * account hopping between addresses:
 *
 *  - exit to server happens at once, the moment the exit stops answering;
 *  - server to exit happens only while the account's browsers are closed, so a
 *    run that started on one address finishes on it.
 *
 * Both settings are set by an operator, per account, never by the account,
 * and neither can aim this server's Chrome at a machine it could not already
 * reach: the home route is a port on 127.0.0.1 and nothing else, so it can
 * only be a tunnel someone already put there; a proxy must resolve to a public
 * address, never this server's own network.
 */

const HOME_ROUTE_PORT_KEY = 'ADMIN_HOME_ROUTE_PORT';
const PROXY_KEY = 'ADMIN_PROXY_URL';
/** Asked of the exit to prove it reaches the internet, not just this server. */
const PROBE_HOST = 'www.seek.com.au';
const PROBE_PORT = 443;
const PROBE_TIMEOUT_MS = 6_000;
const PROBE_FRESH_MS = 15_000;
/** How long a replaced switch must sit unused before it is closed. */
const RETIRE_IDLE_MS = 30 * 60_000;

export type ExitKind = 'home' | 'proxy';

export interface RouteStatus {
  /** The better address this account has, if any. */
  exit: ExitKind | null;
  using: ExitKind | 'server';
  /** The exit answered the last time it was asked. */
  exitOnline: boolean;
  /** The public address the exit goes out on, once seen. */
  exitAddress: string | null;
  /** Why the exit is not answering, when it said. For the operator. */
  exitProblem: string | null;
  since: string;
}

export interface Exit {
  kind: ExitKind;
  host: string;
  port: number;
  /** SOCKS5 username and password (RFC 1929). The home tunnel takes none. */
  auth: { username: string; password: string } | null;
}

// ---------------------------------------------------------------- settings

async function setting(userId: string, key: string): Promise<string> {
  const row = await one<{ value: string }>('SELECT value FROM settings WHERE user_id = $1 AND key = $2', [userId, key]);
  return row?.value ?? '';
}

export async function homeRoutePort(userId: string): Promise<number | null> {
  const port = Math.floor(Number(await setting(userId, HOME_ROUTE_PORT_KEY)));
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

export async function setHomeRoutePort(userId: string, port: number | null): Promise<void> {
  await upsertSettingRow(userId, HOME_ROUTE_PORT_KEY, port ? String(port) : '');
  forget(userId);
}

/**
 * Saves, or with null removes, the account's hand-set proxy. Returns why it
 * was refused, if it was. Either way the pool is reconciled after: an account
 * with a hand-set proxy gives up its pooled one, and one without may get one.
 */
export async function setProxy(userId: string, raw: string | null): Promise<string | null> {
  if (raw === null || !raw.trim()) {
    await upsertSettingRow(userId, PROXY_KEY, '');
  } else {
    const proxy = parseProxy(raw);
    if (typeof proxy === 'string') return proxy;
    if (!(await resolvesPublic(proxy.host))) return 'The proxy must be on the public internet: its host does not resolve, or resolves to a private address.';
    const holder = await poolHolderOf(endpointOf(proxy));
    if (holder && holder !== userId) return 'That proxy is already given to another account from the Webshare pool.';
    await upsertSettingRow(userId, PROXY_KEY, proxyUrl(proxy));
  }
  forget(userId);
  await reconcilePool().catch((error) => console.warn(`[proxy-pool] reconcile failed: ${(error as Error).message}`));
  return null;
}

async function savedProxy(userId: string): Promise<ProxyDetails | null> {
  const raw = await setting(userId, PROXY_KEY);
  if (!raw) return null;
  const proxy = parseProxy(raw);
  return typeof proxy === 'string' ? null : proxy;
}

/** The proxy as the operator may see it again: never its password. */
export async function proxySummary(userId: string): Promise<{ address: string; username: string } | null> {
  const proxy = await savedProxy(userId);
  return proxy ? { address: `${proxy.host}:${proxy.port}`, username: proxy.username } : null;
}

/**
 * The account's exit, most specific first: a proxy an operator set for it by
 * hand, then the one it holds from the Webshare pool, then its home route.
 * `assign` lets the pool give it a proxy on the spot, for a browser about to open.
 */
async function exitFor(userId: string, assign: boolean): Promise<Exit | null> {
  const proxy = (await savedProxy(userId)) ?? (await pooledProxyFor(userId, assign));
  if (proxy) {
    return { kind: 'proxy', host: proxy.host, port: proxy.port, auth: { username: proxy.username, password: proxy.password } };
  }
  const port = await homeRoutePort(userId);
  return port ? { kind: 'home', host: '127.0.0.1', port, auth: null } : null;
}

// ---------------------------------------------------------------- SOCKS5

/** Reads exactly `length` bytes, leaving anything after them in the socket. */
function take(socket: Socket, length: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<Buffer> {
  if (length === 0) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('timed out')), timeoutMs);
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onReadable = () => {
      const chunk = socket.read(length) as Buffer | null;
      if (!chunk) return;
      cleanup();
      resolve(chunk);
    };
    const onClose = () => fail(new Error('closed'));
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('readable', onReadable);
      socket.off('error', fail);
      socket.off('close', onClose);
    };
    socket.on('readable', onReadable);
    socket.on('error', fail);
    socket.on('close', onClose);
    onReadable();
  });
}

/** The address part of a SOCKS5 request or reply: type byte, address, port. */
async function takeAddress(socket: Socket): Promise<Buffer> {
  const type = await take(socket, 1);
  if (type[0] === 1) return Buffer.concat([type, await take(socket, 4 + 2)]);
  if (type[0] === 4) return Buffer.concat([type, await take(socket, 16 + 2)]);
  if (type[0] !== 3) throw new Error('unsupported address type');
  const length = await take(socket, 1);
  return Buffer.concat([type, length, await take(socket, length[0] + 2)]);
}

function domainAddress(host: string, port: number): Buffer {
  const name = Buffer.from(host);
  return Buffer.concat([Buffer.from([3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]);
}

function readAddress(address: Buffer): { host: string; port: number } {
  const port = address.readUInt16BE(address.length - 2);
  if (address[0] === 3) return { host: address.subarray(2, address.length - 2).toString(), port };
  if (address[0] === 1) return { host: [...address.subarray(1, 5)].join('.'), port };
  const groups: string[] = [];
  for (let at = 1; at < 17; at += 2) groups.push(address.readUInt16BE(at).toString(16));
  return { host: groups.join(':'), port };
}

/** Thrown when the exit itself is gone or refused us, as opposed to the site it was asked for. */
class ExitDown extends Error {}

function dialTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    // A blackholed address would otherwise hang for the operating system's whole SYN timeout.
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Opens `address` through the exit. Resolves with the connected socket and the reply code. */
async function dialThroughExit(exit: Exit, address: Buffer): Promise<{ socket: Socket; code: number }> {
  let socket: Socket;
  try {
    socket = await dialTcp(exit.host, exit.port, PROBE_TIMEOUT_MS);
  } catch (error) {
    throw new ExitDown(`unreachable (${(error as Error).message})`);
  }
  try {
    socket.write(Buffer.from([5, 1, exit.auth ? 2 : 0]));
    const method = await take(socket, 2);
    if (method[0] !== 5) throw new Error('it is not a SOCKS5 server');
    if (method[1] === 0xff) throw new Error('it refused every way of signing in that was offered');
    if (exit.auth) {
      const username = Buffer.from(exit.auth.username);
      const password = Buffer.from(exit.auth.password);
      socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
      const verdict = await take(socket, 2);
      if (verdict[1] !== 0) throw new Error('it refused the username or password');
    }
  } catch (error) {
    socket.destroy();
    throw new ExitDown((error as Error).message);
  }
  try {
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address]));
    const head = await take(socket, 3);
    await takeAddress(socket);
    return { socket, code: head[1] };
  } catch (error) {
    socket.destroy();
    // The exit accepted us and then went quiet: the far end is gone.
    throw new ExitDown((error as Error).message);
  }
}

function dialDirect(address: Buffer): Promise<Socket> {
  const { host, port } = readAddress(address);
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

// ---------------------------------------------------------------- the switch

const EXIT_NAME: Record<ExitKind, string> = { home: 'the home connection', proxy: 'the proxy' };

export class RouteSwitch {
  private server: Server | null = null;
  private open = new Set<Socket>();
  private using: ExitKind | 'server' = 'server';
  private exitOnline = false;
  private exitAddress: string | null = null;
  private exitProblem: string | null = null;
  private since = new Date();
  private probedAt = 0;
  private probing: Promise<void> | null = null;
  private lastUsed = Date.now();

  private readonly userId: string;
  private readonly exit: Exit;

  constructor(userId: string, exit: Exit) {
    this.userId = userId;
    this.exit = exit;
  }

  /** The port Chrome is given. Started on first use. */
  async port(): Promise<number> {
    if (!this.server) {
      const server = createServer(client => void this.serve(client));
      server.on('error', () => {});
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      this.server = server;
    }
    return (this.server.address() as { port: number }).port;
  }

  close(): void {
    this.server?.close();
    for (const socket of this.open) socket.destroy();
  }

  /**
   * Replaced by a newer setting. A browser already pointed here keeps working
   * on the route it started with; the switch closes once nothing has used it
   * for a while, which is long after that browser is gone.
   */
  retire(): void {
    const timer = setInterval(() => {
      if (this.open.size > 0 || Date.now() - this.lastUsed < RETIRE_IDLE_MS) return;
      clearInterval(timer);
      this.close();
    }, 60_000);
    timer.unref();
  }

  private move(to: ExitKind | 'server', why: string): void {
    if (this.using === to) return;
    this.using = to;
    this.since = new Date();
    console.log(`[route] user ${this.userId}: now on ${to === 'server' ? 'the server' : EXIT_NAME[to]} (${why})`);
  }

  private lost(problem: string): void {
    this.exitOnline = false;
    this.exitAddress = null;
    this.exitProblem = problem;
    this.probedAt = Date.now();
    this.move('server', `${EXIT_NAME[this.exit.kind]} is not answering: ${problem}`);
  }

  /**
   * Asks the exit to reach a real site. Cheap enough to do whenever someone
   * is about to rely on the answer — a browser starting, the dashboard asking
   * — and not otherwise: a timer would have the account's address knocking on
   * a job board every few seconds around the clock.
   */
  async check(force = false): Promise<void> {
    if (!force && Date.now() - this.probedAt < PROBE_FRESH_MS) return;
    this.probing ??= (async () => {
      let problem: string | null = null;
      try {
        const { socket, code } = await dialThroughExit(this.exit, domainAddress(PROBE_HOST, PROBE_PORT));
        socket.destroy();
        if (code !== 0) problem = `it could not reach ${PROBE_HOST} (SOCKS reply ${code})`;
      } catch (error) {
        problem = (error as Error).message;
      }
      if (problem) return this.lost(problem);
      this.exitOnline = true;
      this.exitProblem = null;
      this.probedAt = Date.now();
      // Back to the exit only between browsers, never under one.
      if (this.open.size === 0) this.move(this.exit.kind, `${EXIT_NAME[this.exit.kind]} is answering`);
      if (!this.exitAddress) this.exitAddress = await this.lookUpAddress().catch(() => null);
    })().finally(() => (this.probing = null));
    await this.probing;
  }

  /** What the rest of the internet sees the exit as. */
  private async lookUpAddress(): Promise<string | null> {
    const { socket, code } = await dialThroughExit(this.exit, domainAddress('api.ipify.org', 80));
    if (code !== 0) {
      socket.destroy();
      return null;
    }
    return new Promise((resolve) => {
      let reply = '';
      const done = () => {
        socket.destroy();
        resolve(reply.split('\r\n\r\n')[1]?.trim().match(/^[0-9a-f.:]{3,45}$/i)?.[0] ?? null);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS, done);
      socket.on('data', chunk => (reply += chunk));
      socket.on('end', done);
      socket.on('error', done);
      socket.write('GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
    });
  }

  private async serve(client: Socket): Promise<void> {
    this.lastUsed = Date.now();
    this.open.add(client);
    client.on('close', () => this.open.delete(client));
    client.on('error', () => {});
    try {
      const hello = await take(client, 2);
      if (hello[0] !== 5) throw new Error('not SOCKS5');
      await take(client, hello[1]);
      client.write(Buffer.from([5, 0]));
      const head = await take(client, 3);
      const address = await takeAddress(client);
      if (head[1] !== 1) {
        client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); // only CONNECT; Chrome asks for nothing else
        return;
      }

      let upstream: Socket | null = null;
      let code = 0;
      if (this.using !== 'server') {
        try {
          ({ socket: upstream, code } = await dialThroughExit(this.exit, address));
        } catch (error) {
          if (!(error instanceof ExitDown)) throw error;
          // The page being loaded should not break because the exit went away: this connection goes out directly.
          this.lost(error.message);
        }
      }
      upstream ??= await dialDirect(address);
      if (code !== 0) {
        upstream.destroy();
        client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    } catch {
      // Host unreachable, in SOCKS terms; Chrome shows its ordinary connection error.
      if (client.writable) client.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
      else client.destroy();
    }
  }

  status(): RouteStatus {
    return {
      exit: this.exit.kind,
      using: this.using,
      exitOnline: this.exitOnline,
      exitAddress: this.exitAddress,
      exitProblem: this.exitProblem,
      since: this.since.toISOString(),
    };
  }
}

const switches = new Map<string, RouteSwitch>();

/** A changed setting takes effect with the account's next browser; one already open keeps the switch it started on. */
function forget(userId: string): void {
  switches.get(userId)?.retire();
  switches.delete(userId);
}

// A proxy given, taken back or swapped by the pool is a changed setting like any other.
onPoolChange(forget);

async function switchFor(userId: string, assign = false): Promise<RouteSwitch | null> {
  const existing = switches.get(userId);
  if (existing) return existing;
  const exit = await exitFor(userId, assign);
  if (!exit) return null;
  const created = new RouteSwitch(userId, exit);
  switches.set(userId, created);
  return created;
}

const SERVER_ONLY: RouteStatus = { exit: null, using: 'server', exitOnline: false, exitAddress: null, exitProblem: null, since: new Date(0).toISOString() };

/** What the account's dashboard shows. */
export async function routeStatus(userId: string): Promise<RouteStatus> {
  const route = await switchFor(userId);
  if (!route) return SERVER_ONLY;
  await route.check();
  return route.status();
}

/**
 * The Chrome flags for a browser about to be opened for this account, and the
 * route it will start on. Empty for an account without an exit, whose Chrome
 * starts exactly as it always has.
 */
export async function browserRoute(userId: string): Promise<{ proxyServer: string | null; args: string[]; status: RouteStatus }> {
  const route = await switchFor(userId, true);
  if (!route) return { proxyServer: null, args: [], status: SERVER_ONLY };
  await route.check(true);
  const proxyServer = `socks5://127.0.0.1:${await route.port()}`;
  return {
    proxyServer,
    args: [
      `--proxy-server=${proxyServer}`,
      // WebRTC would otherwise announce this server's address from behind the exit's.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
    status: route.status(),
  };
}

/** One line for a run's console. */
export function describeRoute(status: RouteStatus): string {
  const address = status.exitAddress ? ` (${status.exitAddress})` : '';
  if (status.using === 'home') return `your home connection${address}`;
  if (status.using === 'proxy') return `your dedicated address${address}`;
  if (status.exit === 'home') return 'the server, because your home machine is not connected';
  if (status.exit === 'proxy') return 'the server, because your dedicated address is not answering';
  return 'the server';
}
