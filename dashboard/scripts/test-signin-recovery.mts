/** Fault-injection against the production desktop lifecycle and React viewer.
 * Local pages, disposable profiles, no real accounts or applications.
 */
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { WebSocketServer } from 'ws';
import { SigninDesktop } from '../server/signin-desktop.js';
import { SigninSessions } from '../server/signin-sessions.js';
import { bridge } from '../server/signin.js';
import { spawn } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
assert.equal(process.platform, 'linux');
if (process.argv[2] === '--orphan-child') {
  const desktop = new SigninDesktop({profileDir: process.argv[3], startUrl: process.argv[4],
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable', routeArgs: [], password: 'fixture1'});
  await desktop.start(); console.log(JSON.stringify({owner: process.pid, pids: desktop.processIds, display: desktop.display}));
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
const directory = mkdtempSync(join(tmpdir(), 'signin-recovery-test-'));
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const rounds = Number(process.env.SIGNIN_RECOVERY_ROUNDS ?? 3);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3);
const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) { if (await check()) return; await wait(100); }
  throw new Error(`Timed out: ${label}`);
}
const fixture = httpServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<style>body{margin:30px;font:24px sans-serif}input{font:24px sans-serif}</style><h1>Recovery sign-in</h1><input id="email" autofocus><input id="otp">');
});
await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
const startUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
const actual = new Map<string, SigninDesktop>();
const profiles = new Map<string, string>();
let invalidBrowser = false;
let preparations = 0;
const sessions = new SigninSessions(async session => {
  preparations++;
  const profileDir = profiles.get(session.userId) ?? mkdtempSync(join(directory, `${session.userId}-`));
  if (!profiles.has(session.userId)) {
    const seed = await chromium.launchPersistentContext(profileDir, { headless: true, executablePath: chromePath });
    await seed.addCookies([{ name: 'saved-signin', value: session.userId, url: startUrl, expires: Date.now() / 1000 + 3600 }]);
    await seed.close(); profiles.set(session.userId, profileDir);
  }
  const desktop = new SigninDesktop({ profileDir, chromePath: invalidBrowser ? '/nonexistent/signin-chrome-fixture' : chromePath,
    startUrl, routeArgs: [], password: session.password, healthIntervalMs: 300,
    log: message => console.log(`[fixture ${session.userId}] ${message}`),
  });
  actual.set(session.userId, desktop); return desktop;
});
let user = 'round1';
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
  import {SeekSignIn} from '/src/components/SeekSignIn.tsx'; import '/src/index.css';
  createRoot(document.getElementById('root')).render(React.createElement(SeekSignIn,{showConnected:true}));`;
const vite = await createServer({ configFile: false, root: join(import.meta.dirname, '..'),
  plugins: [react(), { name: 'recovery-view-fixture',
    resolveId(id) { if (id === '/fixture.tsx') return '\0fixture.tsx'; },
    load(id) { if (id === '\0fixture.tsx') return entry; },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/api/signin/session')) {
        void (async () => {
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'POST') {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            const result = await sessions.start(user, body.target ?? 'seek', false, body.resumeUntil);
            res.statusCode = result.ok ? 200 : 409; res.end(JSON.stringify(result));
          } else if (req.method === 'DELETE') { await sessions.stop(user); res.end(JSON.stringify({session: null})); }
          else res.end(JSON.stringify({supported: true, session: sessions.sessionFor(user), seek: {signedIn: false}}));
        })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({error: error.message})); });
      } else if (req.url === '/') {
        void server.transformIndexHtml('/', '<!doctype html><html data-theme="light"><div id="root"></div><script type="module" src="/fixture.tsx"></script></html>').then(html => res.end(html));
      } else next();
    }); },
  }], server: {host: '127.0.0.1', port: 0} });
const wss = new WebSocketServer({noServer: true});
vite.httpServer!.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws/signin') return;
  const desktop = sessions.desktopFor(user);
  if (!desktop || desktop.state !== 'ready') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => { desktop.closeViewer?.(); desktop.closeViewer = bridge(ws, desktop.vncPort); });
});
const viewerBrowser = await chromium.launch({headless: true, executablePath: chromePath});
const connections: Awaited<ReturnType<typeof chromium.connectOverCDP>>[] = [];
const errors: string[] = [];
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as {port: number}).port}`;
  const viewer = await viewerBrowser.newPage({viewport: {width: 1440, height: 1100}});
  viewer.on('pageerror', error => errors.push(error.message));
  const inspect = async (desktop: SigninDesktop) => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${desktop.debugPort}`);
    connections.push(browser);
    const context = browser.contexts()[0]; const page = context.pages()[0];
    await page.waitForURL(startUrl);
    assert.equal((await context.cookies(startUrl)).find(cookie => cookie.name === 'saved-signin')?.value, user, 'saved profile survives crashes');
    assert.ok(await page.evaluate('innerWidth === outerWidth && innerHeight === outerHeight'), 'recovery keeps URL and tabs hidden');
    return page;
  };
  const orphanProfile = mkdtempSync(join(directory, 'orphan-'));
  const orphan = spawn(join(import.meta.dirname, '../../seek-bot/node_modules/.bin/tsx'),
    [import.meta.filename, '--orphan-child', orphanProfile, startUrl], {stdio: ['ignore', 'pipe', 'inherit']});
  let orphanOutput = '';
  orphan.stdout!.on('data', chunk => { orphanOutput += String(chunk); });
  await eventually(() => orphanOutput.includes('\n'), 'orphan desktop');
  const orphanInfo = JSON.parse(orphanOutput.trim()) as {owner: number; pids: Record<string, number>; display: number};
  const orphanExited = new Promise<void>(done => orphan.once('exit', () => done()));
  // Kill tsx's Node child as well as the CLI wrapper: the actual desktop owner
  // is the process named in the manifest, not necessarily this wrapper PID.
  process.kill(orphanInfo.owner, 'SIGKILL');
  orphan.kill('SIGKILL'); await orphanExited;
  for (let round = 1; round <= rounds; round++) {
    user = `round${round}`;
    const before = preparations;
    const results = await Promise.all([sessions.start(user, 'seek'), sessions.start(user, 'seek')]);
    assert.equal(preparations - before, 1); assert.equal(results[0].session?.id, results[1].session?.id);
    const session = sessions.sessionFor(user)!; let desktop = actual.get(user)!;
    if (round === 1) {
      await eventually(() => Object.values(orphanInfo.pids).every(pid => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }), 'orphan processes reclaimed');
      console.log('PASS hard supervisor crash: orphan desktop reclaimed without touching unrelated sessions');
    }
    await viewer.goto(origin); await viewer.locator('.seek-dot.on').waitFor();
    let page = await inspect(desktop);
    await page.locator('#email').fill('typed-before-screen-crash');
    const browserPid = desktop.processIds.browser;
    const faults: Array<{name: string; inject: () => Promise<void> | void}> = [
      {name: 'VNC SIGKILL', inject: () => { process.kill(desktop.processIds.viewer!, 'SIGKILL'); }},
      {name: 'Chrome SIGKILL', inject: () => { process.kill(desktop.processIds.browser!, 'SIGKILL'); }},
      {name: 'Xvfb SIGKILL', inject: () => { process.kill(desktop.processIds.display!, 'SIGKILL'); }},
      {name: 'renderer crash', inject: async () => {
        const cdp = await page.context().newCDPSession(page); void cdp.send('Page.crash').catch(() => {});
      }},
      {name: 'unresponsive Chrome / forced termination', inject: () => { process.kill(desktop.processIds.browser!, 'SIGSTOP'); }},
    ];
    for (const fault of faults) {
      const revision = desktop.revision; const start = Date.now();
      await fault.inject();
      await eventually(() => desktop.state === 'ready' && desktop.revision > revision, fault.name);
      assert.equal(sessions.sessionFor(user)!.id, session.id); assert.equal(sessions.sessionFor(user)!.expiresAt, session.expiresAt);
      await viewer.locator('.seek-dot.on').waitFor();
      page = await inspect(desktop);
      if (fault.name === 'VNC SIGKILL') {
        assert.equal(desktop.processIds.browser, browserPid, 'screen-only recovery preserves browser');
        assert.equal(await page.locator('#email').inputValue(), 'typed-before-screen-crash');
      }
      console.log(`PASS round ${round}: ${fault.name}, ${Date.now() - start}ms`);
    }
    // Transport-only loss reconnects without a process restart or losing input.
    await page.locator('#otp').fill('987654'); const revision = desktop.revision;
    desktop.closeViewer?.();
    await viewer.locator('.seek-dot:not(.on)').waitFor(); await viewer.locator('.seek-dot.on').waitFor();
    assert.equal(desktop.revision, revision); assert.equal(await page.locator('#otp').inputValue(), '987654');
    // A server restart loses the session; the still-open UI restores it under
    // its original expiry instead of leaving a dead screen or extending access.
    await sessions.stop(user);
    await eventually(() => Boolean(sessions.sessionFor(user)?.state === 'ready'), 'UI restores lost server session');
    desktop = actual.get(user)!;
    assert.notEqual(sessions.sessionFor(user)!.id, session.id);
    assert.equal(sessions.sessionFor(user)!.expiresAt, session.expiresAt);
    await viewer.locator('.seek-dot.on').waitFor(); await inspect(desktop);
    // Close while recovery is underway: it must not silently reopen later.
    process.kill(desktop.processIds.viewer!, 'SIGKILL');
    await viewer.getByRole('button', {name: 'Close', exact: true}).click();
    await viewer.getByRole('dialog').waitFor({state: 'hidden'});
    await wait(2_500); assert.equal(sessions.sessionFor(user), null); assert.deepEqual(desktop.processIds, {});
    console.log(`PASS round ${round}: transport reconnect, saved form, close during recovery, cleanup`);
  }
  // Different accounts reserve distinct displays, including simultaneous starts.
  const concurrent = await Promise.all([sessions.start('parallelA', 'seek'), sessions.start('parallelB', 'seek')]);
  assert.ok(concurrent.every(result => result.ok));
  assert.notEqual(concurrent[0].session?.display, concurrent[1].session?.display);
  await sessions.stop('parallelA'); assert.equal(actual.get('parallelB')?.state, 'ready'); await sessions.stopAll();
  // Permanent misconfiguration stops cleanly, reports the real category and allows retry.
  invalidBrowser = true;
  const failed = await sessions.start('missing', 'seek');
  assert.equal(failed.ok, false); assert.match(failed.error!, /browser executable is unavailable/);
  assert.equal(sessions.count(), 0); invalidBrowser = false;
  assert.equal((await sessions.start('missing', 'seek')).ok, true); await sessions.stopAll();
  user = 'circuit';
  await sessions.start(user, 'seek'); const unstable = actual.get(user)!;
  for (let failure = 1; failure <= 7; failure++) {
    const revision = unstable.revision;
    process.kill(unstable.processIds.viewer!, 'SIGKILL');
    await eventually(() => failure <= 6 ? unstable.state === 'ready' && unstable.revision > revision : unstable.state === 'failed', 'bounded crash recovery');
  }
  assert.deepEqual(unstable.processIds, {});
  await viewer.goto(origin); await viewer.getByRole('button', {name: 'Retry sign-in', exact: true}).click();
  await viewer.locator('.seek-dot.on').waitFor();
  assert.equal(actual.get(user)!.state, 'ready'); await sessions.stopAll();
  console.log('PASS repeated-crash limit stops cleanly; the visible Retry sign-in control restores service');
  assert.deepEqual(errors, []);
  console.log(`PASS ${rounds} recovery rounds, isolated concurrent accounts, permanent failure and retry; no real applications`);
} finally {
  await viewerBrowser.close(); await sessions.stopAll();
  await Promise.allSettled(connections.map(browser => browser.close()));
  await vite.close(); wss.close(); fixture.close();
  rmSync(directory, {recursive: true, force: true});
}
