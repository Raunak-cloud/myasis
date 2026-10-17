import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { signinChromeArgs } from './signin-input.js';

export type DesktopState = 'starting' | 'ready' | 'recovering' | 'failed' | 'closed';
type Part = 'display' | 'browser' | 'viewer';
type Lease = { display: number; vncPort: number; debugPort: number; token: string };
const leases = new Set<number>();
const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function identity(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19]; } catch { return undefined; }
}
function removeOwnedDisplay(display: number, pid: number) {
  const lock = `/tmp/.X${display}-lock`;
  try {
    if (Number(readFileSync(lock, 'utf8').trim()) !== pid || statSync(lock).uid !== process.getuid?.() || identity(pid)) return;
    rmSync(`/tmp/.X11-unix/X${display}`, {force: true}); rmSync(lock, {force: true});
  } catch { /* X already removed its files, or another owner holds them */ }
}
interface Ownership { owner: {pid: number; identity: string}; display: number; children: Array<{pid: number; identity: string; part: Part}> }
let orphanCleanup: Promise<void> | undefined;
const leasePath = (display: number) => resolve(tmpdir(), `myasis-signin-display-${display}.json`);
function claimDisplay(display: number, token: string): boolean {
  const path = leasePath(display);
  const candidate = `${path}.${token}`;
  try {
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8')) as {pid: number; identity: string};
      if (statSync(path).uid !== process.getuid?.() || identity(owner.pid) === owner.identity) return false;
      rmSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    writeFileSync(candidate, JSON.stringify({pid: process.pid, identity: identity(process.pid), token}), {flag: 'wx', mode: 0o600});
    linkSync(candidate, path); // Publish a complete lease with atomic no-replace.
    return true;
  } catch { return false; }
  finally { rmSync(candidate, {force: true}); }
}
function releaseDisplay(lease: Lease) {
  leases.delete(lease.display);
  try { if (JSON.parse(readFileSync(leasePath(lease.display), 'utf8')).token === lease.token) rmSync(leasePath(lease.display)); } catch { /* already released */ }
}
/** After a hard dashboard crash, reap only processes recorded by this service,
 * with matching kernel start times. Never kill an unrelated display or reused PID.
 */
async function reapOrphans() {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('myasis-vnc-')) continue;
    const directory = resolve(tmpdir(), name);
    try {
      if (statSync(directory).uid !== process.getuid?.()) continue;
      const record = JSON.parse(readFileSync(resolve(directory, 'owner.json'), 'utf8')) as Ownership;
      if (identity(record.owner.pid) === record.owner.identity) continue;
      if (!Number.isInteger(record.display) || record.display < 100 || record.display > 164 || !Array.isArray(record.children)) continue;
      for (const child of [...record.children].reverse()) {
        if (!Number.isInteger(child.pid) || child.pid < 2 || !child.identity || identity(child.pid) !== child.identity) continue;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
        await wait(200);
        const remaining = identity(child.pid);
        if (!remaining || remaining === child.identity) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
        if (child.part === 'display') { await wait(50); removeOwnedDisplay(record.display, child.pid); }
      }
      rmSync(directory, {recursive: true, force: true});
    } catch { /* legacy sessions have no manifest; do not touch unknown processes */ }
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise(done => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

async function allocate(): Promise<Lease> {
  await (orphanCleanup ??= reapOrphans());
  for (let display = 100; display <= 164; display++) {
    if (leases.has(display) || existsSync(`/tmp/.X${display}-lock`) || existsSync(`/tmp/.X11-unix/X${display}`)) continue;
    // Reserve before yielding: two accounts may start at the same time.
    leases.add(display);
    const lease = { display, vncPort: 5900 + display - 100, debugPort: 19222 + display - 100, token: randomUUID() };
    if (!claimDisplay(display, lease.token)) { leases.delete(display); continue; }
    if (await portFree(lease.vncPort) && await portFree(lease.debugPort)) return lease;
    releaseDisplay(lease);
  }
  throw new Error('No free sign-in display or local browser port. Please retry shortly.');
}

export async function vncReady(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (ok: boolean) => { if (!settled) { settled = true; socket.destroy(); done(ok); } };
    socket.setTimeout(1_000, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 12) finish(bytes.subarray(0, 12).equals(Buffer.from('RFB 003.008\n')));
    });
  });
}

function alive(child: ChildProcess): boolean {
  return Boolean(child.pid) && child.exitCode === null && child.signalCode === null;
}

async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  const signal = (value: NodeJS.Signals) => {
    // Each component owns a process group; include Chrome descendants after
    // the main process crashes, without touching another account's browser.
    try { process.kill(-child.pid!, value); } catch { /* already gone */ }
  };
  signal('SIGTERM');
  const until = Date.now() + 1_500;
  while (alive(child) && Date.now() < until) await wait(50);
  signal('SIGKILL');
  const forcedUntil = Date.now() + 1_000;
  while (alive(child) && Date.now() < forcedUntil) await wait(50);
}

interface ManagedProcess { child: ChildProcess; error?: Error; diagnostic: string; }
export interface SigninDesktopOptions {
  profileDir: string;
  chromePath: string;
  routeArgs: string[];
  startUrl: string;
  password: string;
  /** Credentials and page contents must never enter these lifecycle logs. */
  log?: (message: string) => void;
  onReady?: (debugPort: number) => void;
  healthIntervalMs?: number;
}

/** Owns a single account's desktop and all of its recovery/cleanup work. */
export class SigninDesktop {
  state: DesktopState = 'starting';
  revision = 0;
  message = 'Opening the sign-in browser...';
  closeViewer?: () => void;
  private lease?: Lease;
  private processes = new Map<Part, ManagedProcess>();
  private stopped = false;
  private task?: Promise<void>;
  private stopTask?: Promise<void>;
  private monitor?: NodeJS.Timeout;
  private cdp?: WebSocket;
  private unhealthy = 0;
  private checking = false;
  private crashes: number[] = [];
  private passwordDir = '';
  private pendingRecovery?: Part;
  private options: SigninDesktopOptions;
  constructor(options: SigninDesktopOptions) { this.options = options; }

  get display() { return this.lease?.display ?? 0; }
  get vncPort() { return this.lease?.vncPort ?? 0; }
  get debugPort() { return this.lease?.debugPort ?? 0; }
  get processIds(): Partial<Record<Part, number>> { return Object.fromEntries([...this.processes].map(([part, process]) => [part, process.child.pid])); }

  start(): Promise<void> {
    if (!this.task) this.task = this.transition('display', false).finally(() => this.finished());
    return this.task;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    this.state = 'closed';
    clearInterval(this.monitor);
    this.cdp?.terminate();
    this.closeViewer?.();
    // Begin termination synchronously even in the process 'exit' handler.
    for (const {child} of this.processes.values()) {
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    }
    this.stopTask = (async () => {
      await this.task?.catch(() => {});
      await this.cleanup('display');
      if (this.passwordDir) rmSync(this.passwordDir, { recursive: true, force: true });
    })();
    return this.stopTask;
  }

  private assertActive() { if (this.stopped) throw new Error('Sign-in was closed.'); }

  private launch(part: Part, command: string, args: string[], env = process.env): ManagedProcess {
    this.assertActive();
    const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const managed: ManagedProcess = { child, diagnostic: '' };
    this.processes.set(part, managed);
    child.stderr?.on('data', data => {
      // Classify errors without logging page URLs, account details or secrets.
      const text = String(data);
      if (/address already in use|server is already active|Cannot establish any listening sockets/i.test(text)) managed.diagnostic = 'local display or port is already in use';
      else if (/XOpenDisplay.*fail|unable to open display/i.test(text)) managed.diagnostic = 'virtual display is unavailable';
      else if (/cannot allocate memory|no space left on device/i.test(text)) managed.diagnostic = 'server resources are exhausted';
    });
    child.on('error', error => { managed.error = error; this.lost(part, managed, 'could not start'); });
    child.on('exit', (code, signal) => this.lost(part, managed, `exited (${signal ?? code})`));
    this.recordOwnership();
    return managed;
  }

  private lost(part: Part, managed: ManagedProcess, reason: string) {
    if (this.processes.get(part) !== managed || this.stopped || this.state !== 'ready') return;
    this.options.log?.(`${part} ${reason}${managed.diagnostic ? `: ${managed.diagnostic}` : ''}`);
    this.recover(part);
  }

  private recover(part: Part) {
    if (this.stopped || this.state === 'failed' || this.state === 'closed') return;
    if (this.task) { this.pendingRecovery = part; return; }
    if (this.state !== 'ready') return;
    this.crashes = this.crashes.filter(time => Date.now() - time < 60_000);
    this.crashes.push(Date.now());
    this.state = 'recovering';
    this.message = part === 'viewer' ? 'Reconnecting the sign-in screen...' : 'The browser stopped. Restoring your sign-in window...';
    this.closeViewer?.();
    this.task = (async () => {
      if (this.crashes.length > 6) {
        clearInterval(this.monitor); this.cdp?.terminate(); this.cdp = undefined;
        await this.cleanup('display');
        this.state = 'failed'; this.message = 'The browser keeps stopping. Please retry sign-in.';
        return;
      }
      await this.transition(part, true);
    })().catch(error => {
      if (!this.stopped) { this.state = 'failed'; this.message = (error as Error).message; }
    }).finally(() => this.finished());
  }

  private finished() {
    this.task = undefined;
    const pending = this.pendingRecovery; this.pendingRecovery = undefined;
    if (pending && !this.stopped && this.state === 'ready') queueMicrotask(() => this.recover(pending));
  }

  private async ready(part: Part, probe: () => Promise<boolean>): Promise<void> {
    const until = Date.now() + 12_000;
    while (Date.now() < until) {
      this.assertActive();
      const managed = this.processes.get(part)!;
      if (!managed.child.pid && !managed.error) await new Promise(done => setImmediate(done));
      if (managed.error) {
        if ((managed.error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${part} executable is unavailable on the server.`);
        throw new Error(`${part} could not start (${(managed.error as NodeJS.ErrnoException).code ?? 'process error'}).`);
      }
      if (!alive(managed.child)) throw new Error(`${part} exited before it was ready (${managed.child.signalCode ?? managed.child.exitCode})${managed.diagnostic ? `: ${managed.diagnostic}` : ''}.`);
      if (await probe()) {
        if (alive(managed.child)) return;
      }
      await wait(100);
    }
    throw new Error(`${part} did not become ready in time.`);
  }

  private async browserInfo(): Promise<{webSocketDebuggerUrl: string} | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`, { signal: AbortSignal.timeout(1_500) });
      if (!response.ok) return null;
      const info = await response.json() as { webSocketDebuggerUrl?: unknown };
      return typeof info.webSocketDebuggerUrl === 'string' ? {webSocketDebuggerUrl: info.webSocketDebuggerUrl} : null;
    } catch { return null; }
  }

  private async transition(first: Part, recovering: boolean): Promise<void> {
    clearInterval(this.monitor);
    this.cdp?.terminate(); this.cdp = undefined;
    let part = first;
    let last = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.assertActive();
      try {
        await this.cleanup(part);
        this.assertActive();
        if (!this.passwordDir) {
          this.passwordDir = mkdtempSync(resolve(tmpdir(), 'myasis-vnc-'));
          writeFileSync(resolve(this.passwordDir, 'passwd'), this.options.password);
          chmodSync(resolve(this.passwordDir, 'passwd'), 0o600);
        }
        if (part === 'display') {
          this.lease = await allocate();
          this.assertActive();
          this.launch('display', 'Xvfb', [`:${this.display}`, '-screen', '0', '1280x900x24', '-nolisten', 'tcp']);
          await this.ready('display', async () => {
            try { if (Number(readFileSync(`/tmp/.X${this.display}-lock`, 'utf8').trim()) !== this.processes.get('display')?.child.pid) return false; } catch { return false; }
            return new Promise(done => {
              const socket = createConnection({ path: `/tmp/.X11-unix/X${this.display}` });
              const finish = (ok: boolean) => { socket.destroy(); done(ok); };
              socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(500, () => finish(false));
            });
          });
        }
        if (part !== 'viewer') {
          this.launch('browser', this.options.chromePath, [
            `--user-data-dir=${this.options.profileDir}`, ...this.options.routeArgs,
            '--no-first-run', '--no-default-browser-check', '--window-position=0,0', '--window-size=1280,900', '--test-type',
            '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${this.debugPort}`,
            ...signinChromeArgs(this.options.startUrl),
          ], { ...process.env, DISPLAY: `:${this.display}` });
          await this.ready('browser', async () => Boolean(await this.browserInfo()));
        }
        this.launch('viewer', 'x11vnc', ['-display', `:${this.display}`, '-rfbport', String(this.vncPort), '-localhost',
          '-passwdfile', resolve(this.passwordDir, 'passwd'), '-forever', '-shared', '-rfbversion', '3.8',
          '-input', 'KMB', '-nosel', '-noxdamage', '-quiet']);
        await this.ready('viewer', () => vncReady(this.vncPort));
        this.assertActive();
        // Every component must still be alive, including ones started earlier.
        for (const [name, process] of this.processes) if (!alive(process.child)) throw new Error(`${name} stopped during startup.`);
        this.state = 'ready'; this.revision++; this.unhealthy = 0;
        this.message = recovering ? 'Sign-in window restored. You may need to repeat the last sign-in step.' : '';
        await this.watchBrowser();
        this.monitor = setInterval(() => void this.health(), this.options.healthIntervalMs ?? 5_000);
        this.monitor.unref();
        this.options.onReady?.(this.debugPort);
        return;
      } catch (error) {
        last = (error as Error).message;
        this.options.log?.(`startup attempt ${attempt}/3: ${last}`);
        await this.cleanup('display');
        if (this.stopped) throw error;
        if (/executable is unavailable/.test(last)) break;
        part = 'display';
        await wait(attempt * 250);
      }
    }
    this.state = 'failed';
    this.message = `Could not restore the sign-in browser. ${last} Please retry sign-in.`;
    throw new Error(this.message);
  }

  private async watchBrowser() {
    const info = await this.browserInfo();
    if (!info || this.stopped || this.state !== 'ready') return;
    const socket = new WebSocket(info.webSocketDebuggerUrl);
    this.cdp = socket;
    socket.on('error', () => {});
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } })));
    socket.on('message', data => {
      try { if (JSON.parse(String(data)).method === 'Target.targetCrashed' && this.cdp === socket) this.recover('browser'); } catch { /* malformed event */ }
    });
  }

  private async health() {
    if (this.checking || this.state !== 'ready' || this.stopped) return;
    this.checking = true;
    const revision = this.revision;
    try {
      const browserOk = Boolean(await this.browserInfo());
      const viewerOk = browserOk && await vncReady(this.vncPort);
      if (this.revision !== revision || this.stopped || this.state !== 'ready') return;
      if (browserOk && viewerOk) {
        this.unhealthy = 0;
        if (this.cdp?.readyState !== WebSocket.OPEN && this.cdp?.readyState !== WebSocket.CONNECTING) await this.watchBrowser();
      } else if (++this.unhealthy >= 3) this.recover(browserOk ? 'viewer' : 'browser');
    } finally { this.checking = false; }
  }

  private async cleanup(part: Part) {
    const parts: Part[] = part === 'viewer' ? ['viewer'] : part === 'browser' ? ['viewer', 'browser'] : ['viewer', 'browser', 'display'];
    for (const name of parts) {
      const managed = this.processes.get(name);
      this.processes.delete(name); // Old exit events cannot affect replacements.
      await terminate(managed?.child);
      if (name === 'display' && managed?.child.pid && this.lease) removeOwnedDisplay(this.display, managed.child.pid);
    }
    if (part === 'display' && this.lease) { releaseDisplay(this.lease); this.lease = undefined; }
    this.recordOwnership();
  }

  private recordOwnership() {
    if (!this.passwordDir) return;
    const record: Ownership = { owner: {pid: process.pid, identity: identity(process.pid)!}, display: this.display,
      children: [...this.processes].flatMap(([part, {child}]) => {
        const start = child.pid ? identity(child.pid) : undefined;
        return start ? [{pid: child.pid!, identity: start, part}] : [];
      }) };
    const path = resolve(this.passwordDir, 'owner.json');
    const pending = `${path}.pending`;
    writeFileSync(pending, JSON.stringify(record), {mode: 0o600});
    renameSync(pending, path); // A crash cannot leave half a recovery manifest.
  }
}
