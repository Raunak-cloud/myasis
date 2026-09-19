import { connect, createServer, type Server, type Socket } from 'node:net';
import { one } from './db/index.js';
import { upsertSettingRow } from './db/records.js';

/**
 * Which connection an account's browser goes out on.
 *
 * Every Chrome here runs in a data centre, and job boards treat a data-centre
 * address with more suspicion than a home one. An account can be given a "home
 * route": a SOCKS tunnel that a machine at the person's home holds open to
 * this server (deploy/home-route), landing on a loopback port. While that
 * machine is on, the account's browsers go out through it; when it is off they
 * go out from the server as before, so a sleeping PC costs the better address
 * and never the run.
 *
 * Chrome cannot change proxy once started, and a run must not fail because a
 * laptop lid closed, so Chrome is never pointed at the tunnel itself. It is
 * pointed at a switch — a small SOCKS server of this process, one per account
 * — that forwards each new connection through the tunnel or directly. Two
 * rules keep that from looking like an account hopping between addresses:
 *
 *  - home to server happens at once, the moment the tunnel stops answering;
 *  - server to home happens only while the account's browsers are closed, so a
 *    run that started on one address finishes on it.
 *
 * The setting is a loopback port and nothing else. A host name would let
 * whoever sets it aim this server's Chrome at any machine it can reach; a port
 * on 127.0.0.1 can only ever be a tunnel someone already put there. It is set
 * by an operator, per account, never by the account.
 */

const HOME_ROUTE_PORT_KEY = 'ADMIN_HOME_ROUTE_PORT';
/** Asked of the tunnel to prove it reaches the internet, not just this server. */
const PROBE_HOST = 'www.seek.com.au';
const PROBE_PORT = 443;
const PROBE_TIMEOUT_MS = 6_000;
const PROBE_FRESH_MS = 15_000;

export type RouteName = 'home' | 'server';

export interface RouteStatus {
  /** Whether this account has a home route at all. */
  configured: boolean;
  using: RouteName;
  /** The home machine answered the last time it was asked. */
  homeOnline: boolean;
  /** The public address the home route goes out on, once seen. */
  homeAddress: string | null;
  since: string;
}

export async function homeRoutePort(userId: string): Promise<number | null> {
  const row = await one<{ value: string }>('SELECT value FROM settings WHERE user_id = $1 AND key = $2', [userId, HOME_ROUTE_PORT_KEY]);
  const port = Math.floor(Number(row?.value));
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

export async function setHomeRoutePort(userId: string, port: number | null): Promise<void> {
  await upsertSettingRow(userId, HOME_ROUTE_PORT_KEY, port ? String(port) : '');
  switches.get(userId)?.close();
  switches.delete(userId);
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

/** Thrown when the tunnel itself is gone, as opposed to the site it was asked for. */
class TunnelDown extends Error {}

/** Opens `address` through the SOCKS tunnel on `port`. Resolves with the connected socket and the reply code. */
async function dialThroughTunnel(port: number, address: Buffer): Promise<{ socket: Socket; code: number }> {
  const socket = connect({ host: '127.0.0.1', port });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(Buffer.from([5, 1, 0]));
    const method = await take(socket, 2);
    if (method[0] !== 5 || method[1] !== 0) throw new Error('not a SOCKS5 tunnel');
  } catch (error) {
    socket.destroy();
    throw new TunnelDown((error as Error).message);
  }
  try {
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address]));
    const head = await take(socket, 3);
    await takeAddress(socket);
    return { socket, code: head[1] };
  } catch (error) {
    socket.destroy();
    // The tunnel accepted us and then went quiet: the far end is gone.
    throw new TunnelDown((error as Error).message);
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

export class RouteSwitch {
  private server: Server | null = null;
  private open = new Set<Socket>();
  private using: RouteName = 'server';
  private homeOnline = false;
  private homeAddress: string | null = null;
  private since = new Date();
  private probedAt = 0;
  private probing: Promise<void> | null = null;

  private readonly userId: string;
  private readonly tunnelPort: number;

  constructor(userId: string, tunnelPort: number) {
    this.userId = userId;
    this.tunnelPort = tunnelPort;
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

  private move(to: RouteName, why: string): void {
    if (this.using === to) return;
    this.using = to;
    this.since = new Date();
    console.log(`[route] user ${this.userId}: now on ${to === 'home' ? 'the home connection' : 'the server'} (${why})`);
  }

  /**
   * Asks the tunnel to reach a real site. Cheap enough to do whenever someone
   * is about to rely on the answer — a browser starting, the dashboard asking
   * — and not otherwise: a timer would have a home address knocking on a job
   * board every few seconds around the clock.
   */
  async check(force = false): Promise<void> {
    if (!force && Date.now() - this.probedAt < PROBE_FRESH_MS) return;
    this.probing ??= (async () => {
      try {
        const { socket, code } = await dialThroughTunnel(this.tunnelPort, domainAddress(PROBE_HOST, PROBE_PORT));
        socket.destroy();
        this.homeOnline = code === 0;
      } catch {
        this.homeOnline = false;
      }
      this.probedAt = Date.now();
      if (!this.homeOnline) this.move('server', 'the home machine is not answering');
      // Back to the home address only between browsers, never under one.
      else if (this.open.size === 0) this.move('home', 'the home machine is answering');
      if (this.homeOnline && !this.homeAddress) this.homeAddress = await this.lookUpAddress().catch(() => null);
      if (!this.homeOnline) this.homeAddress = null;
    })().finally(() => (this.probing = null));
    await this.probing;
  }

  /** What the rest of the internet sees the home route as. */
  private async lookUpAddress(): Promise<string | null> {
    const { socket, code } = await dialThroughTunnel(this.tunnelPort, domainAddress('api.ipify.org', 80));
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
      if (this.using === 'home') {
        try {
          ({ socket: upstream, code } = await dialThroughTunnel(this.tunnelPort, address));
        } catch (error) {
          if (!(error instanceof TunnelDown)) throw error;
          // The page being loaded should not break because a PC went to sleep: this connection goes out directly.
          this.homeOnline = false;
          this.homeAddress = null;
          this.probedAt = Date.now();
          this.move('server', 'the home machine stopped answering');
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
    return { configured: true, using: this.using, homeOnline: this.homeOnline, homeAddress: this.homeAddress, since: this.since.toISOString() };
  }
}

const switches = new Map<string, RouteSwitch>();

async function switchFor(userId: string): Promise<RouteSwitch | null> {
  const existing = switches.get(userId);
  if (existing) return existing;
  const port = await homeRoutePort(userId);
  if (!port) return null;
  const created = new RouteSwitch(userId, port);
  switches.set(userId, created);
  return created;
}

const SERVER_ONLY: RouteStatus = { configured: false, using: 'server', homeOnline: false, homeAddress: null, since: new Date(0).toISOString() };

/** What the account's dashboard shows. */
export async function routeStatus(userId: string): Promise<RouteStatus> {
  const route = await switchFor(userId);
  if (!route) return SERVER_ONLY;
  await route.check();
  return route.status();
}

/**
 * The Chrome flags for a browser about to be opened for this account, and the
 * route it will start on. Empty for an account without a home route, whose
 * Chrome starts exactly as it always has.
 */
export async function browserRoute(userId: string): Promise<{ proxyServer: string | null; args: string[]; status: RouteStatus }> {
  const route = await switchFor(userId);
  if (!route) return { proxyServer: null, args: [], status: SERVER_ONLY };
  await route.check(true);
  const proxyServer = `socks5://127.0.0.1:${await route.port()}`;
  return {
    proxyServer,
    args: [
      `--proxy-server=${proxyServer}`,
      // WebRTC would otherwise announce this server's address from behind the home one.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
    status: route.status(),
  };
}

/** One line for a run's console. */
export function describeRoute(status: RouteStatus): string {
  if (!status.configured) return 'the server';
  return status.using === 'home'
    ? `your home connection${status.homeAddress ? ` (${status.homeAddress})` : ''}`
    : 'the server, because your home machine is not connected';
}
