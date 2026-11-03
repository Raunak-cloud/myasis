import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gmailApiReader } from './gmail-api-reader.js';
import { GmailMcpService } from '../../seek-bot/src/gmail-mcp-service.js';
import { GmailMcpClient } from '../../seek-bot/src/gmail-mcp-client.js';
import { verificationMailboxQuery } from '../../seek-bot/src/gmail-verification-policy.js';

const raw = (id: string, labels: string[], subject = 'Fixture account activation', age = 1000) => ({
  id, labelIds: labels, internalDate: String(Date.now() - age),
  payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'noreply@fixture.invalid' }, { name: 'Subject', value: subject }],
    body: { data: Buffer.from(`<p>Activate your Fixture account.</p><a href="https://fixture.invalid/activate?token=${id}">Activate account</a>`).toString('base64url') } },
});

test('OAuth search includes Spam while mixed-thread filtering excludes deleted, sent, draft and old mail', async () => {
  const calls: Array<{ owner: string; path: string; options: unknown }> = [];
  const reader = gmailApiReader((async (owner: string, path: string, options: unknown) => {
    calls.push({ owner, path, options });
    if (path === 'threads') {
      const params = (options as { params: Record<string, unknown> }).params;
      assert.equal(params.includeSpamTrash, 'true');
      assert.match(String(params.q), /^in:anywhere -in:trash -in:sent -in:draft after:\d+ \(after:123 activate\)$/);
      return { threads: [{ id: 'spam-thread' }] };
    }
    return { messages: [raw('spam', ['SPAM']), raw('inbox', ['INBOX']), raw('trash-spam', ['SPAM', 'TRASH']), raw('sent', ['SENT']), raw('draft', ['DRAFT']), raw('old-spam', ['SPAM'], undefined, 3 * 60 * 60_000)] };
  }) as Parameters<typeof gmailApiReader>[0]);
  assert.deepEqual(await reader.search('fixture-owner', 'after:123 activate'), [{ id: 'spam-thread' }]);
  const messages = await reader.thread('fixture-owner', 'spam/thread');
  assert.deepEqual(messages.map(message => message.id), ['spam', 'inbox']);
  assert.deepEqual(messages[0].labelIds, ['SPAM']);
  assert.match(messages[0].htmlBody!, /Activate your Fixture account/);
  assert.ok(calls.every(call => call.owner === 'fixture-owner'));
  assert.equal(calls[1].path, 'threads/spam%2Fthread');
  assert.equal(verificationMailboxQuery('verification', 10 * 60 * 60_000), 'in:anywhere -in:trash -in:sent -in:draft after:28800 (verification)', 'the outer mailbox window is exactly two hours');
});

test('Spam activation passes through the API adapter and real MCP without weakening purpose or candidate isolation', async () => {
  // The worker has its own TypeScript build. Exercise that release boundary
  // instead of pulling the entire worker source into the dashboard compiler.
  const { findVerificationInGmail } = await import(new URL('../../seek-bot/dist/gmail-mailbox.js', import.meta.url).href);
  const names = ['GMAIL_MCP_URL', 'GMAIL_MCP_TOKEN', 'GMAIL_MCP_ACCOUNT', 'GMAIL_ACCESS_MODE'] as const;
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const reads: string[] = [];
  const reader = gmailApiReader((async (owner: string, path: string, options: any) => {
    assert.ok(['spam-owner-a', 'spam-owner-b'].includes(owner));
    if (path === 'threads') {
      assert.equal(options.params.includeSpamTrash, 'true');
      assert.match(options.params.q, /in:anywhere/);
      assert.match(options.params.q, /\bactivate\b/);
      return { threads: [{ id: `${owner}-thread` }] };
    }
    assert.equal(path, `threads/${owner}-thread`); reads.push(owner);
    return { messages: [raw(`${owner}-activation`, ['SPAM']), raw('wrong-purpose', ['SPAM'], 'Fixture: reset your password'), raw('deleted-activation', ['TRASH'])] };
  }) as Parameters<typeof gmailApiReader>[0]);
  const service = new GmailMcpService({ ...reader, send: async () => { throw Error('Read-only fixture cannot send email'); } });
  const a = await service.grant('spam-owner-a', 'a@fixture.invalid'), b = await service.grant('spam-owner-b', 'b@fixture.invalid');
  const client = new GmailMcpClient(a.connection);
  try {
    for (const grant of [a, b]) {
      Object.assign(process.env, { GMAIL_MCP_URL: grant.connection.url, GMAIL_MCP_TOKEN: grant.connection.token, GMAIL_MCP_ACCOUNT: grant.connection.account, GMAIL_ACCESS_MODE: 'mcp' });
      const result = await findVerificationInGmail({ hint: 'Fixture', purpose: 'account_verification', want: 'link', timeoutMs: 2000 });
      assert.ok(!('error' in result) && result.value.includes(grant === a ? 'spam-owner-a-activation' : 'spam-owner-b-activation'), 'the correct candidate activation wins over same-employer reset and deleted messages');
    }
    await client.search('activate');
    const count = reads.length;
    await assert.rejects(client.thread('spam-owner-b-thread'), /Search this mailbox/);
    assert.equal(reads.length, count, 'foreign-thread denial happens before any API read');
  } finally {
    await client.close(); a.revoke(); b.revoke(); await service.close();
    for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
  }
});

test('read cancellation stays scoped through the OAuth adapter and refuses a late response',async()=>{
  const controller=new AbortController(),cause=new Error('Fixture read cancelled');let calls=0,release!:()=>void;
  const reader=gmailApiReader((async(_owner:string,_path:string,options:any)=>{
    calls++;assert.equal(options.signal,controller.signal);await new Promise<void>(done=>{release=done;});return {threads:[{id:'late'}]};
  }) as Parameters<typeof gmailApiReader>[0]);
  const read=reader.search('fixture-owner','verification',controller.signal);controller.abort(cause);release();
  await assert.rejects(read,error=>error===cause);
  await assert.rejects(reader.search('fixture-owner','verification',controller.signal),error=>error===cause);
  assert.equal(calls,1,'an already cancelled read issues no OAuth request');
});
