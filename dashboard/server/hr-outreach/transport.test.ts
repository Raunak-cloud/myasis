import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHrTransport, hrEmailMessage, hrMessageId, hrDeliveredBody, type HrMail, type HrTransportDependencies } from './transport.js';
import { hrBrowserStep, hrBrowserFailure } from '../../../seek-bot/src/hr-browser-diagnostics.js';

const mail: HrMail = { id: 'outreach-owner-job', to: 'hiring@example.invalid', subject: 'Developer application', body: 'Hello hiring team,\n\nI applied for the Developer role.\n\nTaylor', createdAt: '2026-11-16T00:00:00Z' };
function fixture(overrides: Partial<HrTransportDependencies> = {}): HrTransportDependencies {
  return { allowed: async () => true, access: async () => ({ connected: true, admin: false, account: 'candidate@example.invalid', provider: 'mcp' } as any), owner: async () => ({ email: 'candidate@example.invalid' }),
    request: async () => { throw Error('Unexpected request'); }, sendBrowser: async () => { throw Error('Unexpected browser'); }, reconcileBrowser: async () => null, ...overrides };
}

test('MIME is plain text, one recipient, deterministic message ID and visible reference; injection rejected', () => {
  const raw = Buffer.from(hrEmailMessage(mail, 'candidate@example.invalid'), 'base64url').toString();
  assert.match(raw, /To: <hiring@example.invalid>/); assert.ok(raw.includes(`Message-ID: ${hrMessageId(mail.id)}`));
  assert.doesNotMatch(raw, /multipart|Bcc:|Cc:/);
  const body = Buffer.from(raw.split('\r\n\r\n')[1], 'base64').toString();
  assert.equal(body, hrDeliveredBody(mail));
  assert.equal(hrDeliveredBody({ ...mail, body }), body, 'reference is not appended twice');
  assert.throws(() => hrEmailMessage({ ...mail, to: 'hiring@example.invalid\r\nBcc: other@x.invalid' }, 'candidate@example.invalid'));
  assert.throws(() => hrEmailMessage({ ...mail, subject: 'role\nBcc: x@y.com' }, 'candidate@example.invalid'));
});

test('send uses owner mailbox and requires actual receipt', async () => {
  const sender = createHrTransport(fixture({ request: (async (userId, path, options) => {
    assert.equal(userId, 'owner'); assert.equal(path, 'messages/send');
    const raw = Buffer.from((options?.data as any).raw, 'base64url').toString();
    assert.match(raw, /From: <candidate@example.invalid>/); return { id: 'sent-id', threadId: 'thread' };
  }) as HrTransportDependencies['request'] }));
  assert.deepEqual(await sender.send('owner', mail), { messageId: 'sent-id', threadId: 'thread' });
  await assert.rejects(createHrTransport(fixture({ request: (async () => ({})) as HrTransportDependencies['request'] })).send('owner', mail), (error: any) => error.code === 'uncertain');
});
test('accounts without current access cannot send or reconcile even with a connected mailbox',async()=>{
  const transport=createHrTransport(fixture({allowed:async()=>false}));
  await assert.rejects(transport.send('ordinary',mail),(error:any)=>error.code==='unapproved');
  await assert.rejects(transport.reconcile('ordinary',mail),(error:any)=>error.code==='unapproved');
});

test('disconnected or mismatched mailboxes cannot send or reconcile', async () => {
  for (const overrides of [{ owner: async () => ({ email: 'other@example.invalid' }) }, { access: async () => ({ connected: false, admin: true, account: null } as any) }]) {
    const transport = createHrTransport(fixture(overrides));
    await assert.rejects(transport.send('owner', mail), (error: any) => error.code === 'reconnect');
    await assert.rejects(transport.reconcile('owner', mail), (error: any) => error.code === 'reconnect');
  }
});

test('uncertain provider errors are never reported as success; definite rejection is distinguished', async () => {
  await assert.rejects(createHrTransport(fixture({ request: (async () => { throw Error('socket lost'); }) as HrTransportDependencies['request'] })).send('owner', mail), (error: any) => error.code === 'uncertain');
  await assert.rejects(createHrTransport(fixture({ request: (async () => { throw Object.assign(Error(), { providerStatus: 429 }); }) as HrTransportDependencies['request'] })).send('owner', mail), (error: any) => error.definitiveRejection === true);
});

test('OAuth reconciliation requires Sent and exact reference header, never subject alone', async () => {
  for (const match of [false, true]) {
    const transport = createHrTransport(fixture({ request: (async (_owner, path) => {
      if (path === 'messages') return { messages: [{ id: 'previous' }] };
      return { id: 'previous', labelIds: ['SENT'], payload: { headers: [match ? { name: 'Message-ID', value: hrMessageId(mail.id) } : { name: 'Subject', value: mail.subject }] } };
    }) as HrTransportDependencies['request'] }));
    assert.equal(Boolean(await transport.reconcile('owner', mail)), match);
  }
  const notSent = createHrTransport(fixture({ request: (async (_owner, path) => path === 'messages' ? { messages: [{ id: 'draft' }] } : { id: 'draft', labelIds: ['DRAFT'], payload: { headers: [{ name: 'Message-ID', value: hrMessageId(mail.id) }] } }) as HrTransportDependencies['request'] }));
  assert.equal(await notSent.reconcile('owner', mail), null);
});

test('browser transport uses selected provider without falling through to another account', async () => {
  let count = 0;
  const transport = createHrTransport(fixture({ access: async () => ({ connected: true, admin: true, account: 'candidate@example.invalid', provider: 'browser' } as any),
    sendBrowser: async (userId, actual, account) => { assert.equal(userId, 'owner'); assert.equal(actual, mail); assert.equal(account, 'candidate@example.invalid'); count++; return { id: 'browser-confirmed' }; },
    reconcileBrowser: async () => ({ id: 'browser-confirmed', threadId: 'thread' }),
  }));
  assert.equal((await transport.send('owner', mail)).messageId, 'browser-confirmed');
  assert.equal((await transport.reconcile('owner', mail))?.alreadySent, true); assert.equal(count, 1);
});

test('private browser failures before opening the composer are safely retryable', async () => {
  const original=new Error('browserType.launchPersistentContext: Profile is in use');
  const transport = createHrTransport(fixture({ access: async () => ({ connected: true, admin: true, account: 'candidate@example.invalid', provider: 'browser' } as any),
    withBrowser: async () => hrBrowserStep('launch',async()=>{throw original;}),
  }));
  await assert.rejects(transport.send('owner', mail), (error: any) => {
    assert.equal(error.cause,original);assert.equal(hrBrowserFailure(error)?.category,'profile_in_use');
    return error.definitiveRejection === true && error.code !== 'uncertain';
  });
});
