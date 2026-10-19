import assert from 'node:assert/strict';
import { getPool } from './db/index.js';
import { handleAdminRequest } from './admin.js';
const pool = getPool();
const original = pool.query;
const admins = process.env.ADMIN_EMAILS;
process.env.ADMIN_EMAILS = 'admin@example.test';
let actor: null | string = null;
let analyticsRead = false;
pool.query = (async (sql: string) => {
  if (sql.includes('FROM sessions'))
    return {
      rows: actor
        ? [{ id: '1', email: actor, name: 'Fixture', avatar_url: null }]
        : [],
    };
  analyticsRead = true;
  if (sql === 'SELECT id::text AS id, email FROM users')
    return { rows: [{ id: '1', email: 'admin@example.test' }] };
  return { rows: [] };
}) as typeof original;
try {
  for (const email of [null, 'customer@example.test', 'admin@example.test']) {
    actor = email;
    for (const path of ['/visitors/live', '/visitors?admins=1']) {
      analyticsRead = false;
      let status = 200;
      let response: any;
      await handleAdminRequest(
        {
          method: 'GET',
          headers: { cookie: 'myasis_session=fixture' },
          on: () => {},
        },
        { writeHead: () => {}, write: () => {} },
        new URL(`https://example.test/api/admin${path}`),
        (body, code = 200) => {
          response = body;
          status = code;
        },
        async () => ({}),
      );
      assert.equal(
        status,
        email === 'admin@example.test' ? 200 : email ? 403 : 401,
      );
      assert.equal(
        analyticsRead,
        email === 'admin@example.test',
        'private visitor data is queried only for admins',
      );
      if (email === 'admin@example.test' && path.endsWith('/live'))
        assert.equal(response.count, 0);
    }
  }
  console.log(
    'PASS visitor endpoints: signed-out and ordinary users denied, admins allowed; fixture database responses only',
  );
} finally {
  pool.query = original;
  if (admins === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = admins;
  await pool.end();
}
