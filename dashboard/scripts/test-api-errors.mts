import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import config from '../vite.config.js';
import { getPool } from '../server/db/index.js';

// Exercise the actual dev API middleware with a stub database. Connect ignores
// returned promises, just as this real HTTP server does. No workers are started.
const pool = getPool();
const originalQuery = pool.query, originalConnect = pool.connect;
let attentionFailure = false, deletes = 0, connects = 0;
pool.query = (async (text: string) => {
  if (text.includes('FROM sessions')) return { rows: [{ id: '9000001', email: 'fixture@example.test', name: 'Fixture', avatarUrl: null }] };
  if (text.includes('run_events') && attentionFailure) throw new Error('private-fixture-database-detail');
  if (text.includes('DELETE FROM saved_answers')) deletes++;
  return { rows: [] };
}) as typeof pool.query;
pool.connect = (async () => { connects++; throw new Error('Invalid requests must not open a write transaction'); }) as typeof pool.connect;
const middleware: Array<(...args: any[]) => any> = [];
const plugin = (config.plugins as any[]).find(item => item?.name === 'seek-bot-data-api');
assert.ok(plugin);
plugin.configureServer({ middlewares: { use(fn: (...args: any[]) => any) { middleware.push(fn); } } });
const server = createServer((req, res) => { middleware[0](req, res, () => { res.statusCode = 404; res.end(); }); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const request = (path: string, method = 'GET', body?: string) => fetch(origin + path, { method, headers: { Cookie: 'myasis_session=fixture', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(3000) });
try {
  for (const body of ['{broken', 'null', '[]', '42', JSON.stringify({ answers: [{ question: 'Street', answer: { value: 'invented' } }] }), JSON.stringify({ answers: [], jobId: 'fixture' })]) {
    const response = await request('/api/answers', 'POST', body);
    assert.equal(response.status, 400, body);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(connects, 0, 'malformed requests cannot create answer transactions');
  assert.equal((await request('/api/answers', 'PUT', '{}')).status, 405);
  assert.equal((await request('/api/attention', 'POST', '{}')).status, 405);
  assert.equal((await request('/api/answers', 'DELETE', '{}')).status, 400);
  assert.equal(deletes, 0);
  assert.equal((await request('/api/answers', 'DELETE', JSON.stringify({ question: 'Fixture question' }))).status, 200);
  assert.equal(deletes, 1);
  attentionFailure = true;
  const failure = await request('/api/attention');
  assert.equal(failure.status, 500, 'an async database rejection returns bounded JSON');
  const payload = await failure.text();
  assert.ok(!payload.includes('private-fixture'));
  assert.equal(typeof JSON.parse(payload).error, 'string');
  attentionFailure = false;
  assert.equal((await request('/api/attention')).status, 200, 'the next request still works after failure');
  console.log('PASS: malformed JSON/answers refused before writes, methods enforced, rejected async API calls respond safely and server continues. Stub DB and localhost only.');
} finally {
  pool.query = originalQuery; pool.connect = originalConnect;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await pool.end();
}
