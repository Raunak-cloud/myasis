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

test('verification links correlate with the requested employer, not shared reset language', () => {
  const unrelated = { position: 0, subject: 'Indeed: reset your password', text: 'A sign-in link for your account.', links: [{ text: 'Sign in', url: 'https://au.indeed.com/account/login?token=unrelated' }] };
  const expected = { position: 1, subject: 'Reset your password', text: 'Use this link for your account.', links: [{ text: 'Reset password', url: 'https://career10.successfactors.com/reset?token=expected' }] };
  const ask = { site: 'career10.successfactors.com', hint: 'Transport for NSW / SuccessFactors / TfNSW', want: 'link' as const };
  assert.equal(read([unrelated], ask), null);
  assert.equal(read([unrelated, expected], ask)?.value, expected.links[0].url);
  const fragment = { ...unrelated, subject: 'Transport: verify your account' };
  assert.equal(read([fragment], { hint: 'Transport for NSW', want: 'link' }), null, 'one fragment of a multiword sender is insufficient');
  assert.equal(read([unrelated], { hint: 'password reset link for your account', want: 'link' }), null, 'generic authentication text is not a sender identity');
  const newsletter = { ...unrelated, subject: 'Data & Reporting Analyst at Angle Finance. More jobs for you', text: 'Recommended jobs: Transport for NSW, SuccessFactors roles. Sign in to see more opportunities.' };
  assert.equal(read([newsletter], ask), null, 'an employer mention plus a newsletter sign-in footer is not a verification message');
});

test('shared ATS hosts and tracking parameters cannot select another employer code', () => {
  const other = { position: 0, sender: 'Beta <noreply@workday.com>', subject: 'Beta sign-in code', text: 'Your security code is 111222.',
    links: [{ text: 'Help', url: 'https://workday.com/help?campaign=Acme' }] };
  const expected = { position: 1, sender: 'Acme <noreply@accounts.acme.invalid>', subject: 'Your login code', text: 'Your code is A8X2K9P4.', links: [] };
  const ask = { site: 'acme.wd3.myworkdayjobs.com', hint: 'Acme', want: 'code' as const };
  assert.equal(read([other], ask), null);
  assert.equal(read([other], { ...ask, site: 'login.workday.com' }), null);
  assert.equal(read([other, expected], ask)?.value, 'A8X2K9P4', 'sender identity is usable even when the body has no employer name');
});

test('only code-adjacent tokens are OTPs; expiry years and account IDs are not', () => {
  const email = (text: string) => ({ position: 0, subject: 'Fixture verification', text, links: [] });
  assert.equal(read([email('Your verification code expires in 2026. Use 482913 to verify your account.')], { hint: 'Fixture', want: 'code' })?.value, '482913');
  assert.equal(read([email('Verification for account 123456. Your code is A8X2K9P4.')], { hint: 'Fixture', want: 'code' })?.value, 'A8X2K9P4');
  assert.equal(read([email('Your application reference code is 123456. Your security code is 482913.')], { hint: 'Fixture', want: 'code' })?.value, '482913', 'an explicitly identified security code outranks a generic reference code');
  for (const code of ['1234', '123456789', '123456789012', 'A8X2K9P4', 'A8X2-K9P4']) {
    assert.equal(read([email(`Your OTP is ${code}.`)], { hint: 'Fixture', want: 'code' })?.value, code);
  }
  assert.equal(read([email('Your pass code: 1234 5678')], { hint: 'Fixture', want: 'code' })?.value, '12345678');
  assert.equal(read([email('Your verification code expires in 2026.')], { hint: 'Fixture', want: 'code' }), null);
});

test('password recovery cannot consume an activation or sign-in message from the same employer', () => {
  const activation = { position: 0, subject: 'Fixture: account activation', text: 'Activate your Fixture account using this activation link.', links: [{ text: 'Activate account', url: 'https://fixture.invalid/activate?hash=activation' }] };
  const reset = { position: 1, subject: 'Fixture: reset your password', text: 'Use this link to reset your Fixture password.', links: [{ text: 'Reset password', url: 'https://fixture.invalid/reset?hash=reset' }] };
  const ask = { hint: 'Fixture', want: 'link' as const, purpose: 'reset_password' as const };
  assert.equal(read([activation, reset], ask)?.value, reset.links[0].url, 'even a newer activation message must not hide the requested reset');
  assert.equal(read([activation], ask), null, 'an activation link is not evidence that password-reset mail arrived');
  assert.equal(read([{ ...activation, text: 'Your Fixture verification code is 111222.', links: [...activation.links, { text: 'Forgot password?', url: 'https://fixture.invalid/reset' }] }], { ...ask, want: 'code' as const }), null, 'a generic password-reset footer cannot turn an activation code into a reset code');
  assert.equal(read([reset], { ...ask, purpose: 'account_verification' as const }), null);
  assert.equal(read([activation], { ...ask, purpose: 'sign_in' as const }), null);
  assert.equal(read([{ ...activation, subject: 'Fixture: activate your account', text: 'Activate your Fixture account.' }], { ...ask, purpose: 'account_verification' as const })?.value, activation.links[0].url);
  const mixed = { ...reset, links: [activation.links[0], reset.links[0]] };
  assert.equal(read([mixed], ask)?.value, reset.links[0].url, 'filter links as well as messages when one email contains multiple authentication actions');
  const opaque = { ...reset, text: 'To reset your password, click the link below.', links: [{ text: 'Click here', url: 'https://fixture.invalid/career?email=fixture&hash=opaque' }] };
  assert.equal(read([opaque], ask)?.value, opaque.links[0].url, 'explicit password-reset instructions can identify one opaque action URL without guessing from secret tokens');
  assert.equal(read([{ ...opaque, links: [...opaque.links, { text: 'Click here', url: 'https://fixture.invalid/career?hash=another' }] }], ask), null, 'purpose does not override ambiguous action links');
  const code = (subject: string, value: string) => ({ position: 0, subject, text: `Your Fixture security code is ${value}.`, links: [] });
  assert.equal(read([code('Fixture: account verification', '111222'), code('Fixture: reset your password', '482913')], { ...ask, want: 'code' as const })?.value, '482913');
});
