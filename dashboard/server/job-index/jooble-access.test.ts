import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleAdminRequest } from '../admin.js';
import { getPool } from '../db/index.js';

test('Jooble checks admin access before checking configuration or making a search', async (context) => {
  const pool = getPool();
  const admins = process.env.ADMIN_EMAILS;
  const apiKey = process.env.JOOBLE_API_KEY;
  process.env.ADMIN_EMAILS = 'admin@example.test';
  process.env.JOOBLE_API_KEY = 'fixture-api-key';
  let searches = 0;
  let bodyReads = 0;

  context.mock.method(pool, 'query', async (sql: string, [token]: string[]) => {
    assert.match(sql, /FROM sessions/);
    return { rows: [{ id: '1', email: `${token}@example.test` }] };
  });
  context.mock.method(globalThis, 'fetch', async () => {
    searches++;
    return Response.json({ totalCount: 0, jobs: [] });
  });
  context.after(async () => {
    if (admins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = admins;
    if (apiKey === undefined) delete process.env.JOOBLE_API_KEY;
    else process.env.JOOBLE_API_KEY = apiKey;
    await pool.end();
  });

  async function request(method: string, actor?: 'admin' | 'customer') {
    const headers = actor ? { cookie: `myasis_session=${actor}` } : {};
    let response: { body: unknown; status: number } | undefined;
    await handleAdminRequest(
      { method, headers, on: () => {} },
      { writeHead: () => {}, write: () => {} },
      new URL('https://example.test/api/admin/job-index/jooble'),
      (body, status = 200) => { response = { body, status }; },
      async () => {
        bodyReads++;
        return { keywords: 'chef', location: 'Sydney', page: 1 };
      },
    );
    assert.ok(response);
    return response;
  }

  for (const method of ['GET', 'POST']) {
    assert.equal((await request(method)).status, 401);
    assert.equal((await request(method, 'customer')).status, 403);
  }
  assert.deepEqual(await request('GET', 'admin'), { status: 200, body: { configured: true } });
  assert.equal((await request('DELETE', 'admin')).status, 405);

  process.env.JOOBLE_API_KEY = '';
  assert.deepEqual(await request('GET', 'admin'), { status: 200, body: { configured: false } });
  assert.equal((await request('POST', 'admin')).status, 503);
  assert.equal(bodyReads, 0);
  assert.equal(searches, 0);

  process.env.JOOBLE_API_KEY = 'fixture-api-key';
  assert.deepEqual(await request('POST', 'admin'), { status: 200, body: { jobs: [], page: 1, hasMore: false } });
  assert.equal(bodyReads, 1);
  assert.equal(searches, 1);
});
