import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { publicWebsiteProxy } from '../../dashboard/server/public-website-proxy.js';
import { applyPagePatch } from '../../dashboard/server/marketing/page-edits.js';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright');
const root = resolve(import.meta.dirname, '../..');
const portReservation = createServer().listen(0, '127.0.0.1');
await once(portReservation, 'listening');
const nextPort = (portReservation.address() as { port: number }).port;
await new Promise<void>(done => portReservation.close(() => done()));
const nextOrigin = `http://127.0.0.1:${nextPort}`;
let patch: Record<string, unknown> = {};
const files: Record<string, string> = { '/': 'index.html', '/privacy': 'privacy.html', '/terms': 'terms.html', '/automate-job-applications-australia': 'automate-job-applications-australia.html' };
const bridge = publicWebsiteProxy(nextOrigin);
const fixture = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://fixture');
  if (url.pathname === '/api/public/website') {
    const path = url.searchParams.get('path')!;
    let status = 200, html = '';
    if (files[path]) html = await readFile(resolve(root, 'dashboard', files[path]), 'utf8');
    else if (path === '/blog' || path === '/blog/fixture-post') html = (await readFile(resolve(root, 'dashboard/blog.html'), 'utf8'))
      .replace('<!--blog:head-->', `<title>Fixture job market brief | Owtomate</title><meta name="description" content="Fixture published article"/><link rel="canonical" href="https://owtomate.com${path}"/><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Fixture job market brief"}</script>`)
      .replace('<!--blog:body-->', '<h1>Fixture job market brief</h1><p>This published content comes from the existing blog backend.</p><a href="/blog/fixture-post">Read the brief</a>');
    else if (path === '/sitemap.xml' || path === '/blog/rss.xml') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 200, text: path === '/sitemap.xml' ? '<urlset><url><loc>https://owtomate.com/</loc></url></urlset>' : '<rss><channel><title>Owtomate</title></channel></rss>' })); return;
    } else status = 404;
    if (path === '/' && Object.keys(patch).length) html = applyPagePatch(html, patch, 'https://owtomate.com/');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status, html, patch: path === '/' ? patch : {}, googleConfigured: true })); return;
  }
  if (url.pathname === '/' && (req.headers.cookie?.includes('myasis_session=') || url.searchParams.has('tab'))) { res.end('<h1>Existing dashboard</h1>'); return; }
  if (url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ backend: true })); return; }
  bridge(req, res, () => {
    const file = resolve(root, 'dashboard/public', `.${url.pathname}`);
    if (!file.startsWith(resolve(root, 'dashboard/public') + sep)) { res.statusCode = 404; res.end(); return; }
    void readFile(file).then(data => { res.setHeader('Content-Type', file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.jpg') ? 'image/jpeg' : 'text/plain'); res.end(data); }).catch(() => { res.statusCode = 404; res.end('Not found'); });
  });
}).listen(0, '127.0.0.1');
await once(fixture, 'listening');
const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const child = spawn(process.execPath, ['scripts/start.mjs'], { cwd: resolve(root, 'public-site'), env: { ...process.env, PUBLIC_SITE_USE_BUILD: '1', PORT: String(nextPort), DASHBOARD_ORIGIN: origin, NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(origin)).status === 200) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 250));
  }
  assert.ok(ready, output);
  for (const path of ['/', '/privacy', '/terms', '/automate-job-applications-australia', '/blog', '/blog/fixture-post']) {
    const response = await fetch(origin + path);
    const html = await response.text();
    assert.equal(response.status, 200, `${path}: ${html.slice(0, 200)}\n${output}`);
    assert.equal(response.headers.get('x-public-site'), 'nextjs');
    assert.ok(/<h1\b/.test(html), `${path}: content is server-rendered`);
    assert.ok(/<link[^>]+rel="canonical"/.test(html), `${path}: canonical retained`);
    assert.ok(!/src="\/assets\//.test(html), 'no dashboard bootstrap on public pages');
    const nonce = response.headers.get('content-security-policy')!.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    assert.ok(html.includes(`nonce="${nonce}"`), 'framework scripts match the CSP nonce');
  }
  assert.equal((await fetch(origin + '/blog/not-published')).status, 404, 'unpublished posts stay 404');
  for (const path of ['/privacy.html', '/terms.html', '/blog.html', '/index.html']) assert.equal((await fetch(origin + path, { redirect: 'manual' })).status, 301);
  assert.equal((await fetch(origin + '/blog/', { redirect: 'manual' })).status, 308);
  assert.ok((await (await fetch(origin + '/sitemap.xml')).text()).includes('<urlset>'));
  assert.ok((await (await fetch(origin + '/blog/rss.xml')).text()).includes('<rss>'));
  assert.ok((await (await fetch(origin + '/?tab=prepared')).text()).includes('Existing dashboard'));
  assert.ok((await (await fetch(origin, { headers: { cookie: 'myasis_session=fixture' } })).text()).includes('Existing dashboard'));
  assert.deepEqual(await (await fetch(origin + '/api/auth/me')).json(), { backend: true });
  patch = { title: 'Updated public title', h1: 'Updated public heading', summary: 'A saved website improvement.', links: [{ href: '/blog', text: 'Read the job brief' }], structuredData: true };
  const patched = await (await fetch(origin)).text();
  assert.ok(patched.includes('<title>Updated public title</title>'));
  assert.ok(patched.includes('Updated public heading'));
  patch = {};
  await mkdir(resolve(root, 'output/public-next'), { recursive: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [], csp: string[] = [], api: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (/Content Security Policy|hydration|hydrated|did not match/i.test(message.text())) csp.push(message.text()); });
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) api.push(new URL(request.url()).pathname); });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    await page.getByRole('heading', { name: /Land more job interviews/ }).waitFor();
    await page.waitForTimeout(300);
    if (width === 390) { await page.getByRole('button', { name: 'Menu', exact: true }).click(); await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Automation guide', exact: true }).waitFor(); await page.keyboard.press('Escape'); }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.getByRole('link', { name: 'Start applying', exact: true }).first().getAttribute('href'), '/api/auth/google');
    assert.ok(api.every(path => path === '/api/visit' || path.startsWith('/api/visit/')), `public pages initialize only public analytics, not dashboard hooks: ${api}`);
    await page.screenshot({ path: resolve(root, `output/public-next/home-${width}.png`), fullPage: true });
    await page.goto(origin + '/blog/fixture-post');
    await page.getByRole('heading', { name: 'Fixture job market brief', exact: true }).waitFor();
    await page.screenshot({ path: resolve(root, `output/public-next/blog-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, [], output);
    assert.deepEqual(csp, [], 'no CSP or hydration failures');
    await page.close();
  }
  console.log('PASS: Next.js public HTML, metadata, CSP/nonces, publishing updates, blog/404s, redirects, feeds, auth/dashboard routing and desktop/mobile interactions.');
} finally { await browser.close(); child.kill(); fixture.closeAllConnections(); fixture.close(); }
