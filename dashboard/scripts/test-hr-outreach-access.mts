/** Actual application API middleware and guards, with fictional database rows only. */
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { Plugin, UserConfig } from 'vite';
import { getPool } from '../server/db/index.js';

const pool = getPool();
const originalQuery = pool.query;
const originalAdmins = process.env.ADMIN_EMAILS;
process.env.ADMIN_EMAILS = 'admin-1@example.test,admin-3@example.test';
const emailFor = (id: string) => id === '2' ? 'ordinary-2@example.test' : `admin-${id}@example.test`;
const preferences = new Map([['1', false], ['2', true], ['3', true]]);
let hrReads = 0, hrWrites = 0;
const mutations: Array<{ userId: string; enabled: boolean }> = [];
pool.query = (async (sql: string, values: unknown[] = []) => {
  if (sql.includes('FROM sessions')) {
    const id = values[0] === 'first-session' ? '1' : values[0] === 'second-session' ? '2' : values[0] === 'third-session' ? '3' : null;
    return { rows: id ? [{ id, email: emailFor(id), name: `Fixture ${id}`, avatarUrl: null }] : [] };
  }
  if (sql.startsWith('SELECT email FROM users WHERE id=')) {
    const id = String(values[0]); return { rows: preferences.has(id) ? [{ email: emailFor(id) }] : [] };
  }
  if(sql.startsWith('WITH source AS')){
    assert.match(sql,/h\.user_id=\$1/);assert.match(sql,/r\.user_id=\$1/);hrReads++;
    return {rows:[{run_id:String(100+Number(values[0])),finished_at:new Date(),hr_ready_at:new Date(),status:'sent',phase:null,title:'Owner role',company:'Fixture',leased:false,contact_review_required:String(values[0])==='1',delivery_status:String(values[0])==='1'?'bounced':'unknown'}]};
  }
  if (sql.includes('FROM hr_outreach h')) {
    assert.match(sql, /WHERE h\.user_id=\$1/, 'History query must scope rows to the authenticated owner');
    assert.match(sql, /h\.id<\$2/); assert.match(sql, /h\.job_id=\$3 AND h\.platform=\$4/);
    assert.match(sql, /h\.lookup_outcome AS "lookupOutcome"/);
    assert.match(sql, /h\.lookup_checked_at AS "lookupCheckedAt"/);
    assert.match(sql, /h\.contact->>'sourceKind' AS "sourceKind"/);
    assert.match(sql, /h\.contact->>'validatedAt' AS "sourceCheckedAt"/);
    assert.match(sql, /h\.contact_review_required AS "contactReviewRequired"/);
    for (const [column, field] of [['delivery_status', 'deliveryStatus'], ['delivery_reason', 'deliveryReason'], ['delivery_checked_at', 'deliveryCheckedAt'], ['delivery_failed_at', 'deliveryFailedAt']]) assert.match(sql, new RegExp(`h\\.${column} AS "${field}"`));
    assert.match(sql,/h\.outreach_attempt AS "outreachAttempt"/);
    assert.match(sql,/h\.retry_of::text AS "retryOfId"/);
    assert.doesNotMatch(sql.split(/FROM hr_outreach h/)[0], /\bh\.(?:lookup_(?:diagnostics|details|trace)|diagnostics)\b/, 'Raw lookup diagnostics must not be projected into customer history');
    assert.doesNotMatch(sql.split(/FROM hr_outreach h/)[0], /(?:job_description|jobDescription|sourceText|cover_letter)/, 'Raw vacancy and candidate evidence must not be projected into email history');
    hrReads++;
    const userId = String(values[0]);
    let rows = Array.from({ length: userId === '1' ? 55 : 1 }, (_, i) => ({ id: String(100 - i), jobId: i ? `archived-${userId}-${i}` : `job-${userId}`, platform: i === 54 ? 'external' : 'seek', title: `Role ${userId}`, company: 'Fixture Company', status: 'sent', toEmail: `hiring-${userId}@example.test`, subject: `Private subject ${userId}`, body: `Private body ${userId}`,
      sourceKind:'stored_vacancy',sourceCheckedAt:'2026-11-09T01:00:00.000Z',lookupOutcome:'found',lookupCheckedAt:'2026-11-16T01:00:00.000Z',lookupRetryAt:null,contactReviewRequired:userId==='1'&&i===0,contactReviewReason:userId==='1'&&i===0?'The contact’s relevance to this employer needs review.':null,
      deliveryStatus:userId==='1'&&i===0?'bounced':'unknown',deliveryReason:userId==='1'&&i===0?'The recipient address does not exist.':null,deliveryCheckedAt:'2026-11-16T02:00:00.000Z',deliveryFailedAt:userId==='1'&&i===0?'2026-11-16T01:59:00.000Z':null,
      outreachAttempt:i===1?2:1,retryOfId:i===1?'100':null }));
    if (values[1]) rows = rows.filter(row => BigInt(row.id) < BigInt(String(values[1])));
    if (values[2]) rows = rows.filter(row => row.jobId === values[2] && row.platform === values[3]);
    return { rows: rows.slice(0, 51) };
  }
  if (sql.startsWith('SELECT enabled FROM hr_outreach_preferences')) {
    assert.match(sql, /WHERE user_id=\$1/); hrReads++;
    return { rows: [{ enabled: preferences.get(String(values[0])) }] };
  }
  if (sql.startsWith('INSERT INTO hr_outreach_preferences')) {
    const userId = String(values[0]);
    assert.ok(preferences.has(userId)); assert.equal(typeof values[1], 'boolean');
    preferences.set(userId, values[1] as boolean); hrWrites++; mutations.push({ userId, enabled: values[1] as boolean });
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE hr_outreach SET status=')) {
    assert.match(sql, /WHERE user_id=\$1/); assert.ok(preferences.has(String(values[0]))); hrWrites++; return { rows: [] };
  }
  throw new Error('Unexpected fixture database operation: ' + sql.slice(0, 100));
}) as typeof originalQuery;

let server: ReturnType<typeof createServer> | null = null;
try {
  // Only the development middleware hook is used. Preview hooks, migrations,
  // scheduled runs and background email workers are never started by this test.
  const config = (await import('../vite.config.js')).default as UserConfig;
  const plugin = (config.plugins as Plugin[]).find(item => item.name === 'seek-bot-data-api')!;
  assert.ok(plugin);
  let handle: RequestListener | null = null;
  const hook = plugin.configureServer;
  assert.equal(typeof hook, 'function');
  await (hook as Function)({
    middlewares: { use(fn: Function) { if (!handle) handle = ((req, res) => fn(req, res, () => { res.statusCode = 404; res.end(); })) as RequestListener; } },
    httpServer: null, transformIndexHtml: async (_url: string, html: string) => html,
  });
  assert.ok(handle);
  server = createServer(handle!);
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, session?: string, body?: unknown, crossSite = false, method?: string) => {
    const result = await fetch(origin + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { ...(session ? { cookie: `myasis_session=${session}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(crossSite ? { 'sec-fetch-site': 'cross-site', origin: 'https://unrelated.example.test' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: result.status, body: await result.json() };
  };
  for (const path of ['/api/hr-outreach', '/api/hr-outreach?activity=1', '/api/hr-outreach/settings']) {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, 'invalid-session')).status, 401);
  }
  assert.equal((await request('/api/hr-outreach/settings', undefined, { enabled: true })).status, 401);
  assert.equal(hrReads, 0); assert.equal(hrWrites, 0, 'Signed-out requests must not access private HR data');
  for (const path of ['/api/hr-outreach', '/api/hr-outreach?activity=1', '/api/hr-outreach?userId=1', '/api/hr-outreach/settings']) {
    assert.equal((await request(path, 'second-session')).status, 403);
  }
  assert.equal((await request('/api/hr-outreach/settings', 'second-session', { enabled: true, userId: '1' })).status, 403);
  assert.equal((await request('/api/hr-outreach/settings', 'second-session', { enabled: 'invalid' })).status, 403, 'Admin guard precedes body validation');
  assert.equal((await request('/api/hr-outreach?cursor=invalid', 'second-session')).status, 403, 'Admin guard precedes private request processing');
  assert.equal(hrReads, 0); assert.equal(hrWrites, 0, 'Ordinary accounts cannot read or mutate HR data even with an old enabled preference');
  const first = await request('/api/hr-outreach?userId=2', 'first-session');
  assert.equal(first.status, 200); assert.equal(first.body.items[0].body, 'Private body 1');
  assert.doesNotMatch(JSON.stringify(first.body), /Private body 2|hiring-2/);
  assert.equal(first.body.items[0].status,'sent','Contact review preserves the recorded delivery status');
  assert.equal(first.body.items[0].toEmail,'hiring-1@example.test');
  assert.equal(first.body.items[0].subject,'Private subject 1');
  assert.equal(first.body.items[0].lookupOutcome,'found');
  assert.equal(first.body.items[0].lookupCheckedAt,'2026-11-16T01:00:00.000Z');
  assert.equal(first.body.items[0].sourceKind,'stored_vacancy');
  assert.equal(first.body.items[0].sourceCheckedAt,'2026-11-09T01:00:00.000Z');
  assert.notEqual(first.body.items[0].sourceCheckedAt,first.body.items[0].lookupCheckedAt,'A lookup does not refresh the saved source observation date');
  assert.equal(Object.hasOwn(first.body.items[0],'jobDescription'),false);
  assert.equal(Object.hasOwn(first.body.items[0],'sourceText'),false);
  assert.equal(first.body.items[0].lookupRetryAt,null);
  assert.equal(first.body.items[0].contactReviewRequired,true);
  assert.match(first.body.items[0].contactReviewReason,/needs review/);
  assert.equal(first.body.items[0].deliveryStatus,'bounced');
  assert.equal(first.body.items[0].deliveryReason,'The recipient address does not exist.');
  assert.equal(first.body.items[0].deliveryCheckedAt,'2026-11-16T02:00:00.000Z');
  assert.equal(first.body.items[0].deliveryFailedAt,'2026-11-16T01:59:00.000Z');
  assert.equal(first.body.items[0].status,'sent','Delivery failure never erases the send ledger');
  assert.equal(first.body.items[0].outreachAttempt,1);
  assert.equal(first.body.items[0].retryOfId,null);
  assert.equal(first.body.items[1].outreachAttempt,2);
  assert.equal(first.body.items[1].retryOfId,'100');
  assert.doesNotMatch(JSON.stringify(first.body),/lookup_diagnostics|selector:|stack:|model:/);
  assert.equal(first.body.items.length, 50); assert.equal(first.body.nextCursor, '51');
  assert.equal(first.body.progress.runId,'101');
  assert.equal(first.body.progress.contactReviewRequiredCount,1);
  assert.equal(first.body.progress.deliveryFailedCount,1);
  const beforeActivity=hrReads;
  const activity=await request('/api/hr-outreach?activity=1&userId=3','first-session');
  assert.equal(activity.status,200);assert.deepEqual(activity.body.items,[]);assert.equal(activity.body.progress.runId,'101');assert.equal(hrReads,beforeActivity+1,'status polls never download email history');
  assert.equal(activity.body.progress.contactReviewRequiredCount,1,'Activity reports contact review separately from sent delivery');
  assert.equal(activity.body.progress.deliveryFailedCount,1,'Activity reports failed delivery separately from recorded sends');
  const older = await request('/api/hr-outreach?cursor=51&userId=2', 'first-session');
  assert.equal(older.status, 200); assert.equal(older.body.items.length, 5); assert.equal(older.body.nextCursor, null);
  assert.equal(new Set([...first.body.items, ...older.body.items].map(item => item.id)).size, 55, 'History pages include every owner record without duplicates');
  assert.doesNotMatch(JSON.stringify(older.body), /Private body 2|hiring-2/);
  const historical = await request('/api/hr-outreach?jobId=archived-1-54&platform=external', 'first-session');
  assert.equal(historical.status, 200); assert.equal(historical.body.items.length, 1); assert.equal(historical.body.items[0].id, '46');
  assert.equal((await request('/api/hr-outreach?jobId=archived-2-54&platform=external', 'first-session')).body.items.length, 0);
  const readsBeforeInvalid = hrReads;
  for (const query of ['cursor=garbage', 'cursor=-1', 'cursor=9999999999999999999', 'jobId=one', 'platform=seek', 'jobId=one&platform=INVALID']) assert.equal((await request('/api/hr-outreach?' + query, 'first-session')).status, 400);
  assert.equal(hrReads, readsBeforeInvalid, 'Invalid pagination filters never reach the database');
  const second = await request('/api/hr-outreach?userId=1', 'third-session');
  assert.equal(second.status, 200); assert.equal(second.body.items[0].body, 'Private body 3');
  assert.equal(second.body.items[0].contactReviewRequired,false,'Another admin does not receive the first owner’s review marker');
  assert.equal(second.body.items[0].deliveryStatus,'unknown','Another admin does not receive the first owner’s bounce result');
  assert.equal(second.body.items[0].deliveryReason,null);
  assert.equal(second.body.progress.deliveryFailedCount??0,0);
  assert.deepEqual((await request('/api/hr-outreach/settings', 'first-session')).body, { enabled: false });
  assert.deepEqual((await request('/api/hr-outreach/settings', 'third-session')).body, { enabled: true });
  const writesBeforeBad = hrWrites;
  assert.equal((await request('/api/hr-outreach/settings', 'first-session', { enabled: true }, true)).status, 403);
  for (const enabled of [undefined, null, 'true', 1, [], {}]) assert.equal((await request('/api/hr-outreach/settings', 'first-session', { enabled })).status, 400);
  assert.equal(hrWrites, writesBeforeBad, 'Rejected writes leave both accounts unchanged');
  const save = await request('/api/hr-outreach/settings?userId=2', 'first-session', { enabled: true, userId: '2' });
  assert.equal(save.status, 200); assert.deepEqual(save.body, { enabled: true });
  assert.deepEqual(mutations, [{ userId: '1', enabled: true }], 'Query/body owner spoofing cannot write another account');
  await request('/api/hr-outreach/settings?userId=1', 'third-session', { enabled: false, userId: '1' });
  assert.equal(preferences.get('1'), true); assert.equal(preferences.get('3'), false); assert.equal(preferences.get('2'), true);
  assert.deepEqual(mutations, [{ userId: '1', enabled: true }, { userId: '3', enabled: false }]);
  process.env.ADMIN_EMAILS = 'admin-3@example.test';
  const readsBeforeRevocation = hrReads, writesBeforeRevocation = hrWrites;
  assert.equal((await request('/api/hr-outreach', 'first-session')).status, 403);
  assert.equal((await request('/api/hr-outreach/settings', 'first-session', { enabled: false })).status, 403);
  assert.equal(hrReads, readsBeforeRevocation); assert.equal(hrWrites, writesBeforeRevocation, 'Admin revocation takes effect on the next request');
  assert.equal((await request('/api/hr-outreach', 'first-session', undefined, false, 'DELETE')).status, 405);
  assert.equal((await request('/api/hr-outreach/settings', 'first-session', undefined, false, 'DELETE')).status, 405);
  console.log('PASS: admin-only HR API rejects ordinary and signed-out users before HR access, respects current admin revocation, rejects cross-site and invalid writes/filters, and scopes admin pagination/settings to their own account; fixture database only, no workers or email sends.');
} finally {
  try {
    if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
  } finally {
    pool.query = originalQuery;
    if (originalAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = originalAdmins;
    await pool.end();
  }
}
