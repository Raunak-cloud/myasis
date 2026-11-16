import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { GmailMcpService } from './gmail-mcp-service.js';
import { GmailMcpClient } from './gmail-mcp-client.js';
import type { PreparedApplication } from './application-review-types.js';

test('server-owned source run metadata remains separate from approved and Auto send permissions', async () => {
  const approval = randomUUID(), revision = 'a'.repeat(64), sources: Array<string | undefined> = [], autos: string[] = [];
  const service = new GmailMcpService({ search: async () => [], thread: async () => [],
    send: async (_owner, id, version, source) => { assert.equal(id, approval); assert.equal(version, revision); sources.push(source); return { messageId: 'approved-receipt' }; },
    sendAutomatic: async (_owner, run) => { autos.push(run); return { messageId: 'auto-receipt' }; },
  });
  const approved = await service.grant('owner', 'candidate@fixture.invalid', [approval], undefined, '2002');
  const readOnly = await service.grant('owner', 'candidate@fixture.invalid', [], undefined, '2003');
  const automatic = await service.grant('owner', 'candidate@fixture.invalid', [], '2004', 'forged-different-source');
  const tamperingNetwork: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'tools/call') body.params.arguments.sourceRunId = '999999';
    return fetch(url, { ...init, body: JSON.stringify(body) });
  };
  const clients = [new GmailMcpClient(approved.connection, tamperingNetwork), new GmailMcpClient(readOnly.connection), new GmailMcpClient(automatic.connection)];
  const draft = { job: { id: 'fixture' } } as PreparedApplication;
  try {
    await clients[0].sendApproved(approval, revision);
    assert.deepEqual(sources, ['2002'], 'client/model fields cannot override the private grant');
    await assert.rejects(clients[0].sendAutomatic(draft));
    await assert.rejects(clients[1].sendApproved(approval, revision));
    await assert.rejects(clients[1].sendAutomatic(draft));
    assert.equal(sources.length, 1); assert.equal(autos.length, 0, 'source metadata alone grants no send permission');
    await clients[2].sendAutomatic(draft);
    assert.deepEqual(autos, ['2004'], 'Auto uses its separately authorized live run, not the metadata field');
    approved.revoke(); await assert.rejects(clients[0].sendApproved(approval, revision));
    assert.equal(sources.length, 1);
  } finally { for (const client of clients) await client.close(); await service.close(); }
});
