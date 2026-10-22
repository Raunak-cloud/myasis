import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { isPublicWebsiteRequest, publicWebsiteProxy } from './public-website-proxy.js';
import { publicContentPath } from './public-website-content.js';

test('only public pages reach Next.js; APIs, dashboard links, files and streams keep their current routes', () => {
  for (const path of ['/', '/?utm_source=example', '/blog', '/blog/a-post', '/blog/rss.xml', '/privacy', '/terms/', '/sitemap.xml', '/_next/static/test.js']) assert.equal(isPublicWebsiteRequest(path), true, path);
  for (const path of ['/?tab=run', '/?tab=prepared', '/api/auth/google', '/api/run', '/ws/signin', '/market-research', '/assets/app.js', '/demo/video.mp4', '/platforms/seek.svg', 'http://example.com/', '//example.com/', '/\\example.com/']) assert.equal(isPublicWebsiteRequest(path), false, path);
  for (const path of ['/', '/privacy', '/blog', '/blog/a-post', '/sitemap.xml']) assert.equal(publicContentPath(path), true, path);
  for (const path of ['__proto__', '/api/settings', '../seek-bot/.env', '/blog/../../profile.txt', 'https://example.com', '/privacy?tab=run']) assert.equal(publicContentPath(path), false, path);
  assert.throws(() => publicWebsiteProxy('https://example.com'), /loopback/);
});

test('the public bridge preserves status, query strings, cookies, CSP, caching and HEAD while leaving private routes alone', async () => {
  const seen: string[] = [];
  const website = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.cookie ?? ''}`);
    res.writeHead(req.url?.includes('missing') ? 404 : 200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'self' 'nonce-test'", 'Cache-Control': 'private, no-store' });
    res.end(req.method === 'HEAD' ? undefined : '<h1>Public page</h1>');
  }).listen(0, '127.0.0.1');
  await once(website, 'listening');
  const bridge = publicWebsiteProxy(`http://127.0.0.1:${(website.address() as { port: number }).port}`);
  const backend = createServer((req, res) => bridge(req, res, () => { res.statusCode = 418; res.end('backend'); })).listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const origin = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  try {
    const page = await fetch(`${origin}/?utm_source=test`, { headers: { cookie: 'public=test' } });
    assert.equal(await page.text(), '<h1>Public page</h1>');
    assert.equal(page.headers.get('content-security-policy'), "script-src 'self' 'nonce-test'");
    assert.equal(page.headers.get('cache-control'), 'private, no-store');
    assert.equal((await fetch(`${origin}/blog/missing`)).status, 404);
    assert.equal(await (await fetch(`${origin}/privacy`, { method: 'HEAD' })).text(), '');
    for (const path of ['/?tab=prepared', '/api/run', '/ws/signin']) assert.equal((await fetch(origin + path)).status, 418);
    assert.deepEqual(seen, ['GET /?utm_source=test public=test', 'GET /blog/missing ', 'HEAD /privacy ']);
  } finally { backend.closeAllConnections(); website.closeAllConnections(); backend.close(); website.close(); }
});
