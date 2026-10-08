import assert from 'node:assert/strict';
import { runDeviceFromHeaders, runDeviceLabel } from '../src/run-device.js';
import { recordRunStart } from './entitlements.js';
import { getPool } from './db/index.js';
import { handleAdminRequest } from './admin.js';

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const android = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/143.0.0.0 Mobile Safari/537.36';
const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36';
for (const [ua, expected] of [[iphone, 'mobile'], [android, 'mobile'], [desktop, 'desktop'], ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/605.1.15', 'tablet'], [android.replace('Mobile ', ''), 'tablet'], ['', null], ['curl/8.0', null], ['unrecognised-client', null]] as const) {
  assert.equal(runDeviceFromHeaders({ 'user-agent': ua }), expected);
}
assert.equal(runDeviceFromHeaders({ 'sec-ch-ua-mobile': '?1' }), 'mobile');
assert.equal(runDeviceFromHeaders({ 'user-agent': iphone, 'sec-ch-ua-mobile': '?0' }), 'desktop', 'browser desktop mode takes precedence');
assert.equal(runDeviceFromHeaders({ 'user-agent': [iphone], 'sec-ch-ua-mobile': ['?1'] }), 'mobile');
assert.equal(runDeviceFromHeaders({ 'sec-ch-ua-mobile': 'true' }), null, 'malformed hint is not a mobile signal');
assert.equal(runDeviceLabel(null, 'onboarding'), 'Not recorded');
assert.equal(runDeviceLabel(null, 'admin'), 'Admin · Not recorded');
assert.equal(runDeviceLabel('mobile', 'admin'), 'Admin · Mobile');
assert.equal(runDeviceLabel('desktop', 'auto'), 'Scheduled', 'never attribute the scheduler to a user device');

// Verify the actual persistence boundary, including starts without an HTTP request.
const pool = getPool();
const originalQuery = pool.query;
const originalAdmins = process.env.ADMIN_EMAILS;
let saved: unknown[] = [];
pool.query = (async (sql: string, params: unknown[]) => {
  assert.match(sql, /INSERT INTO run_starts.*initiator_device/s);
  saved = params;
  return { rows: [{ id: 'device-test' }] };
}) as typeof originalQuery;
try {
  assert.equal(await recordRunStart('108', 'live', 'onboarding', null, 'mobile'), 'device-test');
  assert.deepEqual(saved, ['108', 'live', 'onboarding', null, 'mobile']);
  await recordRunStart('108', 'live', 'admin', '1', 'desktop');
  assert.deepEqual(saved, ['108', 'live', 'admin', '1', 'desktop']);
  await recordRunStart('108', 'live', 'auto', null, 'mobile');
  assert.equal(saved[4], null);
  await recordRunStart('108', 'live', 'admin');
  assert.equal(saved[4], null);

  // The field reaches the authenticated admin response and stays unavailable
  // to an ordinary account, even if it calls the admin endpoint directly.
  process.env.ADMIN_EMAILS = 'device-admin@example.com';
  let admin = true;
  pool.query = (async (sql: string) => {
    if (sql.includes('FROM sessions')) return { rows: [{ id: '1', email: admin ? 'device-admin@example.com' : 'candidate@example.com', name: 'Test', avatar_url: null }] };
    assert.match(sql, /FROM run_starts r/);
    assert.match(sql, /r\.initiator_device/);
    return { rows: [{ id:'1', user_id:'108', email:'candidate@example.com', name:'Test Candidate', mode:'live', trigger:'onboarding', started_by_email:null, initiator_device:'mobile', started_at:new Date(), finished_at:new Date(), exit_code:0, applied:3, log_file:null }] };
  }) as typeof originalQuery;
  const req = { method: 'GET', headers: { cookie: 'myasis_session=device-test' }, on: () => {} };
  const res = { writeHead: () => {}, write: () => {} };
  let response: any;
  let status = 200;
  const send = (body: unknown, code = 200) => { response = body; status = code; };
  await handleAdminRequest(req, res, new URL('https://example.com/api/admin/runs'), send, async () => ({}));
  assert.equal(status, 200);
  assert.equal(response[0].initiatorDevice, 'mobile');
  admin = false;
  await handleAdminRequest(req, res, new URL('https://example.com/api/admin/runs'), send, async () => ({}));
  assert.equal(status, 403);
  assert.deepEqual(response, { error: 'Admins only.' });
} finally {
  pool.query = originalQuery;
  if (originalAdmins === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = originalAdmins;
  await pool.end();
}
console.log('PASS: browser device saved on user/admin starts; scheduled and CLI runs never pretend to be user devices');
