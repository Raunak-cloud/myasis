import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { VerificationChoices } from './verification-choices.js';
import { GmailMcpService } from '../gmail-mcp-service.js';
import { verificationEmailMatchDecision } from '../verification-email-local.js';
import type { ToolContext } from './context.js';

test('Amazon branding and alternate sender are presented for the applying agent despite old identity rejection', () => {
  const email = { position: 0, sender: 'noreply@portal-na.idprism-auth.amazon.dev', subject: 'Your Amazon A to Z verification code',
    text: 'Hi,\nYour verification code is:\n482913\nThis code expires in 3 minutes.\nAmazon A to Z', links: [] };
  const ask = { site: 'passport.amazon.jobs', hint: 'Amazon Web Services Australia Pty Ltd | Amazon.jobs', purpose: 'account_verification' as const };
  assert.equal(verificationEmailMatchDecision(email, ask).reason, 'identity-unproven', 'Reproduce the production failure.');
  const store = new VerificationChoices(); const packet = store.present([{ email }], 'owner/amazon/verification')[0];
  assert.equal(packet.sender, email.sender); assert.equal(packet.subject, email.subject);
  assert.equal(packet.candidates.length, 1); assert.match(packet.text, /verification code/); assert.doesNotMatch(JSON.stringify(packet), /482913/);
  assert.equal(store.select(packet.candidates[0].credential_id, 'owner/amazon/verification')?.value, '482913');
});

test('credential values, link tokens and private addresses stay local; IDs cannot transfer to another account or flow', () => {
  const store = new VerificationChoices();
  const packet = store.present([{ email: { position: 0, subject: 'Verification', sender: 'noreply@fixture.invalid',
    text: 'Use 123 456 or A8X2K9P4. For candidate@fixture.invalid. https://fixture.invalid/verify/secretlink?token=private-token',
    links: [{ text: 'Verify account', url: 'https://fixture.invalid/verify/secretlink?token=private-token' }] } }], 'owner/flow');
  const text = JSON.stringify(packet);
  for (const secret of ['123 456', 'A8X2K9P4', 'candidate@fixture.invalid', 'secretlink', 'private-token']) assert.ok(!text.includes(secret), secret);
  for (const candidate of packet[0].candidates) {
    assert.equal(store.select(candidate.credential_id, 'other-owner/flow'), null);
    assert.ok(store.select(candidate.credential_id, 'owner/flow'));
  }
  const expired = store.present([{ date: new Date(Date.now() - 16 * 60000).toISOString(), email: { position: 0, subject: 'Old code', text: 'Code: 729184', links: [] } }], 'owner/flow')[0];
  assert.equal(store.select(expired.candidates[0].credential_id, 'owner/flow'), null);
  assert.equal(store.select('invented-id', 'owner/flow'), null);
});

test('the actual private tool waits for the applying agent choice, shows mixed-brand mail and enters only its selected code', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-email-choice-'));
  const names = ['DATA_DIR','CELERIS_API_KEY','GMAIL_MCP_URL','GMAIL_MCP_TOKEN','GMAIL_MCP_ACCOUNT','GMAIL_ACCESS_MODE'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let reads = 0;
  const gateway = new GmailMcpService({ search: async () => [{ id: 'thread' }], thread: async () => {
    reads++;
    return [{ id: 'other', sender: 'noreply@other.invalid', subject: 'Other Company security code', date: new Date().toISOString(), plaintextBody: 'Your verification code is 628731.' },
      { id: 'amazon', sender: 'noreply@portal-na.idprism-auth.amazon.dev', subject: 'Your Amazon A to Z verification code', date: new Date().toISOString(), plaintextBody: 'Your verification code is:\n482913\nThis code expires in 3 minutes.' }];
  }, send: async () => { throw Error('No sends in verification test'); } });
  const grant = await gateway.grant('fixture-owner', 'candidate@fixture.invalid');
  Object.assign(process.env, { DATA_DIR: directory, CELERIS_API_KEY: 'fixture-only', GMAIL_MCP_URL: grant.connection.url,
    GMAIL_MCP_TOKEN: grant.connection.token, GMAIL_MCP_ACCOUNT: grant.connection.account, GMAIL_ACCESS_MODE: 'mcp' });
  const { doEnterEmailedCode } = await import('./authentication.js');
  const { observe, renderObservation } = await import('./observe.js');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Amazon: Verify your email</h1><label>Verification code<input maxlength="6"></label></main>' }));
    await page.goto('https://passport.amazon.jobs/verify');
    const ctx = { page, job: { id: 'fixture', company: 'Amazon Web Services Australia Pty Ltd', url: 'https://www.amazon.jobs/en/jobs/10598233' },
      profile: { email: 'candidate@fixture.invalid' }, observation: await observe(page), actions: [], log: () => {} } as unknown as ToolContext;
    const args = { purpose: 'account_verification', sender_hint: 'Amazon.jobs', ref: ctx.observation.fields[0].ref };
    const inspected = await doEnterEmailedCode(ctx, args);
    assert.equal(inspected.kind, 'ok'); if (inspected.kind !== 'ok') return;
    const packet = JSON.parse(inspected.message);
    assert.equal(packet.messages.length, 2, 'The parent agent sees both messages and decides which belongs to this application.');
    assert.equal(await page.locator('input').inputValue(), '', 'Listing email evidence never consumes a code.');
    assert.doesNotMatch(inspected.message, /482913|628731/);
    const amazon = packet.messages.find((message: { subject: string }) => message.subject.includes('Amazon'));
    const selected = amazon.candidates.find((candidate: { kind: string }) => candidate.kind === 'code');
    const beforeSelection = reads;
    const used = await doEnterEmailedCode(ctx, { ...args, credential_id: selected.credential_id });
    assert.match(JSON.stringify(used), /Entered the emailed code/); assert.equal(reads, beforeSelection, 'The selected private value is used, not another mailbox lookup.');
    assert.equal(await page.locator('input').inputValue(), '482913');
    assert.doesNotMatch(renderObservation(await observe(page)), /482913/);
    assert.equal(ctx.actions.filter(action => action.kind === 'email-code').length, 1);
    const other = { ...ctx, profile: { ...ctx.profile, email: 'other@fixture.invalid' } };
    assert.match(JSON.stringify(await doEnterEmailedCode(other, { ...args, credential_id: selected.credential_id })), /does not match this candidate/);
    assert.equal(reads, beforeSelection);
  } finally {
    await browser.close(); grant.revoke(); await gateway.close();
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    rmSync(directory, { recursive: true, force: true });
  }
});
