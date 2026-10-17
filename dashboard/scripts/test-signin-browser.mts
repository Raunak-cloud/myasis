/** Real noVNC -> authenticated-bridge input filter -> x11vnc -> kiosk Chrome.
 * Isolated Linux display/profile and local fixture only; no accounts/credentials.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { WebSocketServer } from 'ws';
import { bridge } from '../server/signin.js';
import { signinChromeArgs } from '../server/signin-input.js';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
assert.equal(process.platform, 'linux', 'requires Xvfb and x11vnc');
const directory = mkdtempSync(join(tmpdir(), 'signin-browser-test-'));
const children: ChildProcess[] = [];
let display = 180;
while (existsSync(`/tmp/.X${display}-lock`) || existsSync(`/tmp/.X11-unix/X${display}`)) display++;
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await wait(100); }
  throw new Error(`Timed out: ${label}`);
}
const unused = httpServer();
await new Promise<void>(done => unused.listen(0, '127.0.0.1', done));
const vncPort = (unused.address() as { port: number }).port;
await new Promise<void>(done => unused.close(() => done()));
const password = 'testonly'; const passwordFile = join(directory, 'passwd');
writeFileSync(passwordFile, password); chmodSync(passwordFile, 0o600);
const fixture = httpServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/popup' ? '<h1>OAuth popup</h1><input autofocus id="otp">' : `<!doctype html><style>body{margin:24px;font:24px sans-serif}input,button{display:block;font:24px sans-serif;margin:15px 0}</style>
    <h1>Sign-in fixture</h1><input id="email" autocomplete="off" autofocus><input id="otp" autocomplete="off">
    <button id="next" onclick="document.body.dataset.submitted='true'">Continue</button>
    <a id="link" href="/other" target="_blank">External link</a>
    <button id="popup" onclick="window.open('/popup','oauth','width=600,height=600')">Google-style popup</button>`);
});
await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
const startUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
const wss = new WebSocketServer({ noServer: true });
const entry = `import RFB from '/node_modules/@novnc/novnc/core/rfb.js';
  const rfb = new RFB(document.getElementById('screen'), 'ws://'+location.host+'/ws/fixture', {credentials:{password:'${password}'}});
  rfb.addEventListener('connect',()=>window.connected=true); window.rfb=rfb;`;
const vite = await createServer({ configFile: false, root: join(import.meta.dirname, '..'), plugins: [{
  name: 'signin-browser-fixture',
  resolveId(id) { if (id === '/fixture.js') return '\0fixture.js'; },
  load(id) { if (id === '\0fixture.js') return entry; },
  configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url !== '/') { next(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<style>body{margin:0}#screen{width:1280px;height:900px}</style><div id="screen"></div><script type="module" src="/fixture.js"></script>');
  }); },
}], server: { host: '127.0.0.1', port: 0 } });
let closeViewer: (() => void) | undefined;
vite.httpServer!.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws/fixture') return;
  wss.handleUpgrade(req, socket, head, ws => { closeViewer?.(); closeViewer = bridge(ws, vncPort); });
});
let targetBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
let viewerBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  children.push(spawn('Xvfb', [`:${display}`, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' }));
  await wait(700);
  children.push(spawn(process.env.CHROME_PATH || '/usr/bin/google-chrome-stable', [
    `--user-data-dir=${directory}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--window-position=0,0',
    ...signinChromeArgs(startUrl),
  ], { env: { ...process.env, DISPLAY: `:${display}` }, stdio: 'ignore' }));
  await eventually(() => existsSync(join(directory, 'DevToolsActivePort')), 'Chrome');
  const debugPort = Number(readFileSync(join(directory, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  targetBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = targetBrowser.contexts()[0];
  const page = context.pages()[0]; await page.waitForURL(startUrl);
  children.push(spawn('x11vnc', ['-display', `:${display}`, '-rfbport', String(vncPort), '-localhost', '-passwdfile', passwordFile,
    '-forever', '-shared', '-rfbversion', '3.8', '-input', 'KMB', '-nosel', '-noxdamage', '-quiet'], { stdio: 'ignore' }));
  await wait(700); await vite.listen();
  viewerBrowser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable', headless: true });
  const viewer = await viewerBrowser.newPage({ viewport: { width: 1280, height: 900 } });
  await viewer.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  await viewer.waitForFunction('window.connected === true');
  const viewerCdp = await viewer.context().newCDPSession(viewer);
  const press = async (key: number, down?: boolean) => {
    const result = await viewerCdp.send('Runtime.evaluate', { expression: `window.rfb.sendKey(${key}, undefined, ${down === undefined ? 'undefined' : down})` });
    assert.equal(result.exceptionDetails, undefined);
    await wait(40);
  };
  const click = async (selector: string, button: 'left' | 'right' | 'middle' = 'left') => {
    const box = await page.locator(selector).boundingBox(); assert.ok(box);
    await viewer.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button }); await wait(100);
  };
  console.log('main dimensions', await page.evaluate('({innerWidth, innerHeight, outerWidth, outerHeight})'));
  assert.ok(await page.evaluate('innerHeight >= 890 && innerWidth >= 1270 && innerWidth === outerWidth && innerHeight === outerHeight'), 'kiosk must hide browser chrome');
  await click('#email');
  await press(0xffe1, true); await press(0x52); await press(0xffe1, false);
  for (const char of 'inu@example.test') await press(char.codePointAt(0)!);
  assert.equal(await page.locator('#email').inputValue(), 'Rinu@example.test');
  await press(0xff09); for (const char of '123456') await press(char.codePointAt(0)!);
  assert.equal(await page.locator('#otp').inputValue(), '123456');
  await press(0xffe3, true); await press(0x61); await press(0xffe3, false); await press(0x39);
  assert.equal(await page.locator('#otp').inputValue(), '9', 'Ctrl+A still edits inputs');
  await click('h1');
  for (const symbol of [0x6c, 0x74, 0x6e, 0x6f, 0x77]) {
    await press(0xffe3, true); await press(symbol); await press(0xffe3, false);
  }
  await press(0xffc3); await press(0xffc8); await press(0xffc9); // F6, F11, F12
  await press(0xffe9, true); await press(0x64); await press(0xffe9, false);
  for (const char of 'https://example.invalid/') await press(char.codePointAt(0)!);
  await press(0xff0d); await wait(200);
  assert.equal(page.url(), startUrl); assert.equal(context.pages().length, 1);
  for (const modifier of [0xffe1, 0xffe3]) {
    await press(modifier, true); await click('#link'); await press(modifier, false);
  }
  await click('#link', 'middle'); await click('#link', 'right');
  await page.locator('#link').focus();
  await press(0xffe1, true); await press(0xff0d); await press(0xffe1, false);
  assert.equal(context.pages().length, 1, 'manual new-tab gestures blocked');
  await click('#next'); assert.equal(await page.locator('body').getAttribute('data-submitted'), 'true');
  await click('#popup');
  await eventually(() => context.pages().length === 2, 'OAuth popup');
  const popup = context.pages().find(candidate => candidate !== page)!; await popup.waitForURL(`${startUrl}popup`);
  console.log('popup dimensions', await popup.evaluate('({innerWidth, innerHeight, outerWidth, outerHeight})'));
  assert.ok(await popup.evaluate('innerWidth === outerWidth && innerHeight === outerHeight'), 'popup must hide browser chrome too');
  // OAuth popups must remain available; their Chrome frame must not expose tabs/URL editing either.
  await popup.close();
  await press(0xffe1, true);
  await viewer.reload(); await viewer.waitForFunction('window.connected === true');
  await click('#otp'); await press(0x32);
  assert.equal(await page.locator('#otp').inputValue(), '92', 'reconnection accepts normal input');
  console.log('PASS real Chrome sign-in: kiosk, credentials, OTP, editing, blocked shortcuts/gestures, OAuth popup, reconnect');
} finally {
  closeViewer?.(); await viewerBrowser?.close(); await targetBrowser?.close();
  for (const child of children.reverse()) child.kill('SIGTERM');
  await vite.close(); wss.close(); fixture.close();
  await wait(300); rmSync(directory, { recursive: true, force: true });
}
