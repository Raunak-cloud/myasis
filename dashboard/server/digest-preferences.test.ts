import assert from 'node:assert/strict';
import { getPool } from './db/index.js';
import { dailySummaryEnabled, setDailySummaryEnabled, DAILY_SUMMARY_KEY } from './email-preferences.js';
import { alertsEnabled, setAlertsEnabled } from './alerts.js';
import { sendDailyDigests } from './digest.js';

const pool = getPool();
const originalQuery = pool.query;
const originalFetch = globalThis.fetch;
const originalEnv = { RESEND_API_KEY: process.env.RESEND_API_KEY, RESEND_FROM: process.env.RESEND_FROM, DASHBOARD_URL: process.env.DASHBOARD_URL };
Object.assign(process.env, { RESEND_API_KEY: 're_fixture_only', RESEND_FROM: 'Fixture <fixture@example.test>', DASHBOARD_URL: 'https://fixture.invalid' });
const settings = new Map<string, string>();
const claims = new Set<string>();
const users = [{ id: '71001', email: 'one@example.test', name: 'One' }, { id: '71002', email: 'two@example.test', name: 'Two' }];
const delivered: string[] = [];
let optOutDuringGather = false;
let failSend = false;
const key = (id: unknown, setting: unknown) => `${id}:${setting}`;
pool.query = (async (sql: string, params: unknown[] = []) => {
  if (sql.includes('INSERT INTO settings')) { settings.set(key(params[0], params[1]), String(params[2])); return { rows: [] }; }
  if (sql.includes('COALESCE(s.value')) return { rows: users.some(u => u.id === params[0]) ? [{ value: settings.get(key(params[0], DAILY_SUMMARY_KEY)) ?? 'on' }] : [] };
  if (sql.includes('SELECT value FROM settings')) return { rows: settings.has(key(params[0], params[1])) ? [{ value: settings.get(key(params[0], params[1])) }] : [] };
  if (sql.includes('LEFT JOIN daily_digests')) {
    assert.match(sql, /NOT EXISTS.*settings/s);
    assert.equal(params[1], DAILY_SUMMARY_KEY);
    return { rows: users.filter(u => !claims.has(u.id) && settings.get(key(u.id, DAILY_SUMMARY_KEY)) !== 'off') };
  }
  if (sql.includes('count(*)::text AS n FROM run_starts')) {
    if (optOutDuringGather) settings.set(key(params[0], DAILY_SUMMARY_KEY), 'off');
    return { rows: [{ n: '1' }] };
  }
  if (sql.includes('INSERT INTO daily_digests')) {
    if (claims.has(String(params[0]))) return { rows: [] };
    claims.add(String(params[0])); return { rows: [{ user_id: params[0] }] };
  }
  if (sql.includes('DELETE FROM daily_digests')) { claims.delete(String(params[0])); return { rows: [] }; }
  return { rows: [] };
}) as typeof pool.query;
globalThis.fetch = (async (url, init) => {
  assert.equal(new URL(String(url)).hostname, 'api.resend.com', 'only a simulated mail-provider request is allowed');
  if (failSend) return Response.json({ message: 'Fixture outage', name: 'validation_error' }, { status: 503 });
  const body = JSON.parse(String(init?.body));
  delivered.push(...(Array.isArray(body.to) ? body.to : [body.to]));
  return Response.json({ id: 'fixture-email' });
}) as typeof fetch;
try {
  assert.equal(await dailySummaryEnabled('71001'), true, 'existing account defaults to enabled');
  assert.equal(await dailySummaryEnabled('99999'), false, 'deleted accounts cannot receive a summary');
  await setDailySummaryEnabled('71001', false);
  await setAlertsEnabled('71002', false);
  assert.equal(await alertsEnabled('71001'), true, 'summary opt-out does not change attention alerts');
  assert.equal(await dailySummaryEnabled('71002'), true, 'attention opt-out does not change summaries');
  assert.deepEqual(await sendDailyDigests(new Date('2026-10-20T11:00:00Z')), ['two@example.test']);
  assert.deepEqual(delivered, ['two@example.test']);
  assert.deepEqual(await sendDailyDigests(new Date('2026-10-20T11:01:00Z')), [], 'a summary is sent once per day');
  await setDailySummaryEnabled('71001', true);
  optOutDuringGather = true;
  assert.deepEqual(await sendDailyDigests(new Date('2026-10-20T11:02:00Z')), [], 'an opt-out during gathering is honored before delivery');
  assert.equal(claims.has('71001'), false, 'an unsent email does not consume the daily claim');
  optOutDuringGather = false;
  await setDailySummaryEnabled('71001', true);
  failSend = true;
  assert.deepEqual(await sendDailyDigests(new Date('2026-10-20T11:03:00Z')), []);
  assert.equal(claims.has('71001'), false, 'a failed send can retry');
  failSend = false;
  assert.deepEqual(await sendDailyDigests(new Date('2026-10-20T11:04:00Z')), ['one@example.test'], 'opting back in restores delivery');
  console.log('PASS: daily-summary default, independent opt-outs, no delivery after opt-out, in-flight opt-out, once per day and retry; all mail and database calls simulated.');
} finally {
  pool.query = originalQuery; globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await pool.end();
}
