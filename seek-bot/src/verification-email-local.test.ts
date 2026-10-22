import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readVerificationEmailsLocally as read } from './verification-email-local.js';
test('verification parsing stays local, matches the requested site and ignores unrelated messages and marketing links', () => {
  const unrelated = { position: 0, subject: 'Another Company verification', text: 'Your security code is 111222', links: [] };
  const seek = { position: 1, subject: 'Your SEEK sign-in code', text: 'Your one-time code is 938 421. Enter this on SEEK to sign in.', links: [] };
  assert.equal(read([unrelated, seek], { site: 'SEEK', want: 'code' })?.value, '938421');
  assert.equal(read([unrelated], { site: 'SEEK', want: 'code' }), null);
  assert.equal(read([seek], { want: 'code' }), null, 'without a site hint, do not guess whose code to use');
  const employer = { position: 0, subject: 'Fixture account verification', text: 'Your Fixture verification code is A8X2-K9P4.', links: [] };
  assert.equal(read([employer], { hint: 'Fixture', want: 'code' })?.value, 'A8X2-K9P4');
  const email = { position: 0, subject: 'Fixture: confirm your account', text: 'Confirm your Fixture account.', links: [
    { text: 'Unsubscribe', url: 'https://fixture.invalid/unsubscribe' }, { text: 'Verify account', url: 'https://fixture.invalid/verify?token=example' },
  ] };
  assert.equal(read([email], { hint: 'Fixture', want: 'link' })?.value, email.links[1].url);
  assert.equal(read([{ ...email, links: [...email.links, { text: 'Verify account', url: 'https://fixture.invalid/verify?token=another' }] }], { hint: 'Fixture', want: 'link' }), null, 'ambiguous links require help');
});
