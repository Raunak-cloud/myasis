import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real SOCKS traffic and isolated Chrome, with fictional accounts/sites only.
// No production database, account profile, external proxy or employer is used.
const script = fileURLToPath(import.meta.url);
const loader = resolve(import.meta.dirname, '../../seek-bot/node_modules/tsx/dist/loader.mjs');
const pause = () => new Promise(done => setTimeout(done, 40));
async function wait(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 750; i++) { if (await condition()) return; await pause(); }
  throw new Error('Route survival fixture did not complete.');
}
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const branch = process.argv[2];
const directory = process.env.OWTOMATE_RUN_SERVICE_DIR!;

if (branch === '--host') {
  delete process.env.OWTOMATE_RUN_SERVICE_CLIENT;
  const { RunPool } = await import('../server/runner.js');
  const { serveRuns } = await import('../server/run-service.js');
  const { RouteSwitch } = await import('../server/route.js');
  let receipts = 0, authenticatedConnections = 0;
  const website = httpServer((request, response) => {
    const page = (body: string) => { response.setHeader('content-type', 'text/html'); response.end(body); };
    if (request.url === '/review') {
      let body = '';
      request.on('data', chunk => body += chunk);
      request.on('end', () => {
        assert.equal(new URLSearchParams(body).get('candidate'), 'Fictional Candidate');
        page('<h1>Review fictional application</h1><form method="post" action="/receipt"><button>Submit fixture</button></form>');
      });
    } else if (request.url === '/receipt') {
      receipts++;
      writeFileSync(resolve(directory, 'receipts.json'), JSON.stringify({ receipts, authenticatedConnections }));
      page('<h1>Fictional application received</h1>');
    } else page('<h1>Fictional application</h1><form method="post" action="/review"><label>Candidate<input name="candidate"></label><button>Next</button></form>');
  });
  await new Promise<void>(done => website.listen(0, '127.0.0.1', done));
  const websitePort = (website.address() as { port: number }).port;
  const sockets = new Set<Socket>();
  const exact = async (socket: Socket, count: number): Promise<Buffer> => {
    for (;;) {
      const bytes = socket.read(count) as Buffer | null;
      if (bytes) return bytes;
      await new Promise<void>((done, reject) => {
        const cleanup = () => { socket.off('readable', ready); socket.off('error', failed); socket.off('close', closed); };
        const ready = () => { cleanup(); done(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const closed = () => failed(new Error('Fixture connection closed.'));
        socket.once('readable', ready); socket.once('error', failed); socket.once('close', closed);
      });
    }
  };
  const proxy = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    void (async () => {
      const greeting = await exact(socket, 2); await exact(socket, greeting[1]);
      socket.write(Buffer.from([5, 2]));
      const login = await exact(socket, 2), username = await exact(socket, login[1]);
      const length = await exact(socket, 1), password = await exact(socket, length[0]);
      assert.equal(username.toString(), 'fixture-user'); assert.equal(password.toString(), 'fixture-password');
      authenticatedConnections++; socket.write(Buffer.from([1, 0]));
      const request = await exact(socket, 4);
      assert.equal(request[3], 3);
      const hostLength = await exact(socket, 1), host = (await exact(socket, hostLength[0])).toString();
      await exact(socket, 2);
      const success = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
      if (host === 'api.ipify.org') {
        socket.write(success);
        socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n203.0.113.7'));
      } else if (host === 'application.fixture.invalid') {
        const upstream = connect({ host: '127.0.0.1', port: websitePort });
        upstream.on('connect', () => { socket.write(success); socket.pipe(upstream); upstream.pipe(socket); });
        upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
      } else { socket.write(success); } // reachability probe and Chrome background traffic stay local
    })().catch(() => socket.destroy());
  });
  await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done));
  const routes = new Map<string, InstanceType<typeof RouteSwitch>>(), allRoutes = new Set<InstanceType<typeof RouteSwitch>>();
  const routeFor = (id: string) => {
    assert.ok(['fixture-a', 'fixture-b'].includes(id));
    if (!routes.has(id)) {
      const route = new RouteSwitch(id, { kind: 'proxy', host: '127.0.0.1', port: (proxy.address() as {port:number}).port,
        auth: { username: 'fixture-user', password: 'fixture-password' } });
      routes.set(id, route); allRoutes.add(route);
    }
    return routes.get(id)!;
  };
  const service = await serveRuns(new RunPool(), {
    browserRoute: async (id, borrowFree) => {
      assert.equal(borrowFree, id === 'fixture-a');
      const route = routeFor(id); await route.check(true);
      const proxyServer = `socks5://127.0.0.1:${await route.port()}`;
      return { proxyServer, args: [`--proxy-server=${proxyServer}`], status: route.status() };
    },
    routeStatus: async id => routeFor(id).status(),
    forgetAccountRoute: async id => { routes.get(id)?.close(); routes.delete(id); },
    retireAccountRoute: async id => { routes.get(id)?.retire(); routes.delete(id); },
  });
  process.once('SIGTERM', () => {
    void service.drain().then(() => {
      for (const route of allRoutes) route.close();
      for (const socket of sockets) socket.destroy();
      website.close(); proxy.close(); process.exit(0);
    });
  });
} else if (branch === '--dashboard') {
  process.env.OWTOMATE_RUN_SERVICE_CLIENT = '1';
  const { browserRoute, routeStatus } = await import('../server/route.js');
  const a = await browserRoute('fixture-a', true), b = await browserRoute('fixture-b');
  assert.notEqual(a.proxyServer, b.proxyServer, 'each account has its own relay');
  assert.equal((await routeStatus('fixture-a')).using, 'proxy');
  writeFileSync(resolve(directory, 'dashboard.json'), JSON.stringify({ pid: process.pid, a, b }));
  setInterval(() => {}, 1000);
} else if (branch === '--browser') {
  const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    proxy: { server: read(resolve(directory, 'dashboard.json')).a.proxyServer },
    args: ['--disable-background-networking', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.goto('http://application.fixture.invalid/form', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Candidate').fill('Fictional Candidate');
    writeFileSync(resolve(directory, 'form-ready'), String(process.pid));
    await wait(() => existsSync(resolve(directory, 'after-graceful-restart')));
    assert.equal(await page.getByLabel('Candidate').inputValue(), 'Fictional Candidate');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('heading', { name: 'Review fictional application', exact: true }).waitFor();
    writeFileSync(resolve(directory, 'review-ready'), 'yes');
    await wait(() => existsSync(resolve(directory, 'after-crash')));
    await page.getByRole('button', { name: 'Submit fixture', exact: true }).click();
    await page.getByRole('heading', { name: 'Fictional application received', exact: true }).waitFor();
    // A later application in the same browser still works after the dashboard crash.
    await page.goto('http://application.fixture.invalid/form');
    await page.getByLabel('Candidate').fill('Fictional Candidate');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Submit fixture', exact: true }).click();
    await page.getByRole('heading', { name: 'Fictional application received', exact: true }).waitFor();
    writeFileSync(resolve(directory, 'browser-finished'), String(process.pid));
  } finally { await browser.close(); }
} else {
  if (process.platform !== 'linux') { console.log('Relay crash-survival integration runs on Linux.'); process.exit(0); }
  const dir = mkdtempSync(resolve(tmpdir(), 'owtomate-relay-survival-'));
  process.env.OWTOMATE_RUN_SERVICE_DIR = dir;
  process.env.OWTOMATE_RUN_SERVICE_CLIENT = '1';
  const children: ChildProcess[] = [];
  const launch = (role: string) => {
    const child = spawn(process.execPath, ['--import', loader, script, role], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); child.stderr?.on('data', data => process.stderr.write(data)); return child;
  };
  try {
    const host = launch('--host');
    await wait(() => existsSync(resolve(dir, 'state.json')));
    let dashboard = launch('--dashboard');
    await wait(() => existsSync(resolve(dir, 'dashboard.json')));
    const original = read(resolve(dir, 'dashboard.json'));
    const browser = launch('--browser');
    await wait(() => existsSync(resolve(dir, 'form-ready')));
    dashboard.kill('SIGTERM'); await wait(() => dashboard.signalCode === 'SIGTERM');
    writeFileSync(resolve(dir, 'after-graceful-restart'), 'yes');
    await wait(() => existsSync(resolve(dir, 'review-ready')));
    rmSync(resolve(dir, 'dashboard.json'));
    dashboard = launch('--dashboard');
    await wait(() => existsSync(resolve(dir, 'dashboard.json')));
    assert.equal(read(resolve(dir, 'dashboard.json')).a.proxyServer, original.a.proxyServer, 'new dashboard reuses the surviving relay');
    dashboard.kill('SIGKILL'); await wait(() => dashboard.signalCode === 'SIGKILL');
    const { forgetAccountRoute, retireAccountRoute, browserRoute, routeStatus } = await import('../server/route.js');
    const { runServiceRequest } = await import('../server/run-service-client.js');
    await forgetAccountRoute('fixture-b');
    assert.equal((await routeStatus('fixture-a')).using, 'proxy', 'another account cleanup leaves the active relay intact');
    await retireAccountRoute('fixture-a');
    assert.notEqual((await browserRoute('fixture-a', true)).proxyServer, original.a.proxyServer,
      'a changed assignment gives the next browser a new relay while the current browser keeps its old connection');
    await assert.rejects(runServiceRequest('browserRoute', ['../fixture-a', true]), /Invalid route account/);
    await assert.rejects(runServiceRequest('browserRoute', ['fixture-a', 'true']), /Invalid route allocation/);
    writeFileSync(resolve(dir, 'after-crash'), 'yes');
    await wait(() => existsSync(resolve(dir, 'browser-finished')));
    await wait(() => browser.exitCode === 0);
    assert.equal(readFileSync(resolve(dir, 'form-ready'), 'utf8'), readFileSync(resolve(dir, 'browser-finished'), 'utf8'));
    const result = read(resolve(dir, 'receipts.json'));
    assert.equal(result.receipts, 2); assert.ok(result.authenticatedConnections > 0);
    host.kill('SIGTERM'); await wait(() => host.exitCode === 0);
    await assert.rejects(browserRoute('fixture-a', true), /reconnecting|unavailable/);
    console.log('PASS: service-owned authenticated SOCKS relay survives dashboard shutdown/reconnect/SIGKILL. Same Chrome preserves filled fields and submits two fictional applications exactly once. Per-account isolation and unavailable-service reporting pass. No real applications sent.');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}
