import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleMarketing } from './api.js';

test('marketing routes reject non-admins before reading data or request bodies', async () => {
  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'marketing-admin@example.com';
  try {
    const site = '00000000-0000-4000-8000-000000000001';
    for (const [method, path] of [
      ['GET', 'sites'],
      ['POST', 'sites'],
      ['PATCH', `sites/${site}`],
      ['POST', `sites/${site}/research`],
      ['POST', `sites/${site}/health`],
      ['POST', `sites/${site}/visibility`],
      ['POST', `sites/${site}/results/import`],
      ['POST', `sites/${site}/google/connect`],
      ['GET', 'google/callback'],
      ['POST', `sites/${site}/drafts`],
      ['POST', `sites/${site}/posts/${site}/publish`],
      ['GET', `sites/${site}/posts/${site}/export?format=html`],
    ]) {
      let reply: { body: unknown; status?: number } | undefined;
      await handleMarketing(
        { method } as IncomingMessage,
        { setHeader() {} } as unknown as ServerResponse,
        new URL(`/api/marketing/${path}`, 'https://example.com'),
        { id: 'non-admin', email: 'member@example.com' },
        (body, status) => { reply = { body, status }; },
        async () => { throw new Error('Unauthorized request body was read'); },
      );
      assert.deepEqual(reply, { body: { error: 'Admins only.' }, status: 403 }, `${method} ${path}`);
    }
    let adminStatus: number | undefined;
    await handleMarketing(
      { method: 'GET' } as IncomingMessage,
      { setHeader() {} } as unknown as ServerResponse,
      new URL('/api/marketing/unknown', 'https://example.com'),
      { id: 'admin', email: 'MARKETING-ADMIN@example.com' },
      (_body, status) => { adminStatus = status; },
      async () => { throw new Error('Unexpected request body'); },
    );
    assert.equal(adminStatus, 404, 'Admin reaches routing rather than the access denial');
  } finally {
    if (previous === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
  }
});
