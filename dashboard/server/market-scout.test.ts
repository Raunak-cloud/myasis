import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { marketScoutProxy } from './market-scout.js';

async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}

test('production research checks every request and streams only authorized traffic', async () => {
  const received: Array<{ url?: string; cookie?: string; origin?: string; body: string }> = [];
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, cookie: req.headers.cookie, origin: req.headers.origin, body });
      res.writeHead(200, { 'content-type': req.url?.endsWith('/events') ? 'text/event-stream' : 'application/json' });
      res.end(req.url?.endsWith('/events') ? 'data: {"line":"ready"}\n\n' : '{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = marketScoutProxy(async (req) => req.headers.cookie === 'admin' ? 'admin' : req.headers.cookie === 'user' ? 'user' : null,
    (req) => req.headers.origin === 'https://owtomate.com', upstreamPort);
  const front = createServer((req, res) => { void proxy(req, res); });
  const frontPort = await listen(front);
  const base = `http://127.0.0.1:${frontPort}/market-research`;
  try {
    for (const path of ['/', '/app.js', '/api/runs', '/runs/example/report.html', '/api/runs/example/events']) {
      assert.equal((await fetch(base + path)).status, 401);
      assert.equal((await fetch(base + path, { headers: { cookie: 'user' } })).status, 403);
    }
    assert.equal(received.length, 0);
    assert.equal((await fetch(base + '/api/runs', { method: 'POST', headers: { cookie: 'admin', origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/api/runs', { method: 'POST', headers: { cookie: 'admin' }, body: '{}' })).status, 403);
    assert.equal(received.length, 0);
    const post = await fetch(base + '/api/runs', { method: 'POST', headers: { cookie: 'admin', origin: 'https://owtomate.com' }, body: '{"product":"clothes"}' });
    assert.equal(post.status, 200);
    assert.deepEqual(received[0], { url: '/api/runs', cookie: undefined, origin: `http://127.0.0.1:${upstreamPort}`, body: '{"product":"clothes"}' });
    const events = await fetch(base + '/api/runs/example/events', { headers: { cookie: 'admin' } });
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    assert.equal(await events.text(), 'data: {"line":"ready"}\n\n');
    assert.equal(events.headers.get('x-robots-tag'), 'noindex, nofollow');
  } finally {
    await close(front);
    await close(upstream);
  }
});
