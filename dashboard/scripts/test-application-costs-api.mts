import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin, ViteDevServer } from 'vite';
import config from '../vite.config.js';
import { getPool } from '../server/db/index.js';
import { syncCostJournal } from '../server/application-costs.js';

const pool = getPool();
const originalQuery = pool.query;
const originalAdmins = process.env.ADMIN_EMAILS;
process.env.ADMIN_EMAILS = 'admin-cost-fixture@example.test';
const dir = mkdtempSync(resolve(tmpdir(), 'cost-api-'));
const runId = randomUUID();
const fixture = { id: randomUUID(), runId, at: new Date().toISOString(), kind: 'usage', jobId: 'fixture-job', provider: 'Celeris', amountUsd: 0.12, basis: 'estimated' };
const retiredFixture = { ...fixture, id: randomUUID(), provider: 'Anthropic', model: 'claude-haiku-5-5', amountUsd: 4 };
const stored = new Map<string, unknown>();
let costReads = 0;
pool.query = (async (sql: string, params: unknown[] = []) => {
  if (sql.includes('FROM sessions')) return { rows: params[0] === 'admin-fixture' ? [{ id: '9000000000000', email: 'admin-cost-fixture@example.test' }] : params[0] === 'user-fixture' ? [{ id: '9000000000001', email: 'user-cost-fixture@example.test' }] : [] };
  if (sql.includes('INSERT INTO application_cost_events')) {
    assert.equal(params[0], 'fixture-owner');
    for (const e of JSON.parse(String(params[1]))) stored.set(e.id, e);
    assert.match(sql, /ON CONFLICT \(user_id, event_id\) DO NOTHING/);
    return { rows: [] };
  }
  if (sql.includes('FROM application_cost_events')) {
    costReads++; assert.equal(params[0], '9000000000000', 'cost query owner is the session, not the supplied userId');
    assert.match(sql, /WHERE user_id = \$1/);
    return { rows: [{ payload: fixture }, { payload: retiredFixture }] };
  }
  throw new Error(`Unexpected database access: ${sql}`);
}) as typeof pool.query;

const plugins = (config as { plugins: Plugin[] }).plugins;
const plugin = plugins.find(p => p.name === 'seek-bot-data-api')!;
let handler: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
const configure = plugin.configureServer as (server: ViteDevServer) => void;
configure({ middlewares: { use(value: typeof handler) { handler ??= value; } }, httpServer: null } as unknown as ViteDevServer);
const server = createServer((req, res) => handler!(req, res, () => { res.statusCode = 404; res.end(); }));
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  writeFileSync(resolve(dir, 'cost-ledger.jsonl'), `${JSON.stringify(fixture)}\n{"partial"`);
  await syncCostJournal('fixture-owner', dir); await syncCostJournal('fixture-owner', dir);
  assert.equal(stored.size, 1, 'repeated sync imports each usage event once');
  for (const [cookie, status] of [['', 401], ['myasis_session=user-fixture', 403], ['myasis_session=admin-fixture', 200]] as const) {
    const response = await fetch(`${origin}/api/applications/costs?userId=someone-else`, { headers: cookie ? { cookie } : {} });
    assert.equal(response.status, status);
    const body = await response.json() as Record<string, { totalUsd: number }>;
    if (status === 200) {
      assert.equal(body['fixture-job'].totalUsd, 0.12);
      assert.doesNotMatch(JSON.stringify(body), /haiku|anthropic/i, 'retired-provider data never reaches the UI');
    }
    else assert.equal(body['fixture-job'], undefined);
  }
  assert.equal(costReads, 1, 'signed-out and normal users cannot even query cost data');
  assert.equal((await fetch(`${origin}/api/applications/costs`, { method: 'POST' })).status, 405);
  console.log('Application-cost API: 401/403 admin boundary, session-owned query, method guard and idempotent journal sync passed.');
} finally {
  await new Promise<void>(done => server.close(() => done()));
  pool.query = originalQuery; await pool.end();
  if (originalAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = originalAdmins;
  rmSync(dir, { recursive: true, force: true });
}
