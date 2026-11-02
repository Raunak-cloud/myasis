import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRequestedVerificationEmail, readVerificationEmailsLocally as read, verificationSenderHint } from './verification-email-local.js';

test('explicit multiword identity-provider aliases match their sender DNS label within the active authentication realm', () => {
  const email = {position:0,sender:'Identity service <noreply@login.fixtureidentity.invalid>',subject:'Your one-time code',
    text:'482913 is your one-time code. This code expires in ten minutes.',links:[]};
  const ask = {hint:'Example Employer | Fixture Identity',site:'employer-identity.login.fixtureidentity.invalid',purpose:'sign_in' as const,want:'code' as const};
  assert.equal(read([email],ask)?.value,'482913');
  assert.equal(read([email],{...ask,site:'login.fixtureidentity.invalid'})?.value,'482913');
  assert.equal(read([email],{...ask,hint:'Example Employer'}),null,'a shared provider never overrides an employer-only hint');
  for(const sender of ['FixtureIdentity <noreply@other.invalid>','noreply@login.fixtureidentity.invalid.attacker.invalid','noreply@other.fixtureidentity.invalid']) {
    assert.equal(read([{...email,sender}],ask),null,'a compact display name, sibling realm, or suffix lookalike cannot establish the sender identity');
  }
  assert.equal(read([email],{...ask,site:'otheridentity.invalid'}),null);
  assert.equal(read([email],{...ask,site:'employer-identity.login.fixtureidentity.invalid.attacker.invalid'}),null);
  assert.equal(read([{...email,sender:'noreply@other.invalid',links:[{text:'Help',url:'https://login.fixtureidentity.invalid/help'}]}],ask),null,'links cannot stand in for the sender domain');
  assert.equal(read([{...email,subject:'Reset your password'}],ask),null,'sender normalization cannot change the requested authentication purpose');
});

test('a decorated login-page sender hint retains the specific employer as an independent identity', () => {
  const site = 'tenant-identity.login.vendor.invalid';
  const supplied = 'Vendor Identity - Example Employer';
  const email = { position: 0, sender: 'noreply@login.vendor.invalid', subject: 'Example Employer verification',
    text: 'Your verification code is 482913.', links: [] };
  assert.equal(read([email], { site, hint: supplied, purpose: 'account_verification', want: 'code' }), null);
  const hint = verificationSenderHint('Example Employer', 'https://careers.vendor.invalid/job/42', supplied);
  assert.equal(read([email], { site, hint, purpose: 'account_verification', want: 'code' })?.value, '482913');
  assert.equal(read([{ ...email, subject: 'Other Employer verification' }], { site, hint, purpose: 'account_verification', want: 'code' }), null,
    'the shared hosting platform cannot establish another employer identity');
});

test('hosting names and generic corporate labels cannot become broad independent aliases', () => {
  for (const company of ['jobs.vendor.invalid', 'Vendor', 'Vendor Identity', 'Group Ltd']) {
    const hint = verificationSenderHint(company, 'https://jobs.vendor.invalid/job/42', 'Example Employer');
    assert.equal(hint, 'Example Employer');
    assert.equal(read([{ position: 0, subject: 'Vendor verification', text: 'Your code is 482913.', links: [] }],
      { hint, site: 'tenant-identity.login.vendor.invalid', purpose: 'sign_in', want: 'code' }), null);
  }
});

test('omitted or identical sender hints preserve the existing employer identity', () => {
  for (const hint of [undefined, '', ' Example Employer ']) {
    assert.equal(verificationSenderHint('Example Employer', 'https://careers.vendor.invalid/job/42', hint), 'Example Employer');
  }
});

test('an explicit reset action takes priority over an unrelated footer website', () => {
  const action = 'https://careers.fixture.invalid/Careers/passwordreset/fixture-token/?username=fixture-user';
  const email = { position: 0, subject: 'Fixture password reset', sender: 'noreply@fixture.invalid',
    text: 'To reset your password, use the link below. Visit our website for more information.', links: [
      { text: 'Reset your password', url: action },
      { text: 'Sidekick', url: 'https://sidekick.fixture.invalid/' },
    ] };
  const ask = { hint: 'Fixture', site: 'careers.fixture.invalid', purpose: 'reset_password' as const, want: 'link' as const };
  assert.equal(read([email], ask)?.value, action, 'the footer is only an opaque fallback, not a second reset action');
  assert.equal(read([{ ...email, links: [...email.links, { text: 'Reset password', url: action.replace('fixture-token', 'other-token') }] }], ask), null,
    'multiple explicit reset actions remain ambiguous');
  assert.equal(read([email], { ...ask, purpose: 'account_verification' }), null, 'a reset cannot become an activation');
});

test('opaque query values cannot turn a footer into an explicit action', () => {
  const action = 'https://fixture.invalid/opaque?hash=fixture-token';
  const email = { position: 0, subject: 'Fixture password reset', text: 'To reset your password, click the link below.', links: [
    { text: 'Click here', url: action },
    { text: 'Website', url: 'https://fixture.invalid/?token=reset-private-marker' },
  ] };
  assert.equal(read([email], { hint: 'Fixture', purpose: 'reset_password', want: 'link' }), null,
    'secret token contents cannot resolve two otherwise opaque destinations');
});

test('code labels accept independent linking words, punctuation and layout whitespace', () => {
  for (const separator of [' ', ': ', ' is ', ' is: ', ' is :\n', '\n:\n', ' = ', ' - ', ' – ', ' — ', ' is\u00a0—\u00a0']) {
    for (const label of ['verification code', 'security PIN', 'passcode', 'OTP', 'code', 'PIN']) {
      for (const [token, expected] of [['482913', '482913'], ['482 913', '482913'], ['A8X2-K9P4', 'A8X2-K9P4']]) {
        const email = { position: 0, subject: 'Fixture sign-in verification', text: `Your ${label}${separator}${token}. Expires in 2026.`, links: [] };
        assert.equal(read([email], { hint: 'Fixture', want: 'code', purpose: 'sign_in' })?.value, expected, `${label}${separator}[private code]`);
      }
    }
  }
  const email = { position: 0, subject: 'Fixture sign-in verification', text: 'Your security code is not available. Account 123456 expires in 2026.', links: [] };
  assert.equal(read([email], { hint: 'Fixture', want: 'code' }), null);
  assert.equal(isRequestedVerificationEmail(email, { hint: 'Fixture', purpose: 'sign_in' }), true);
  assert.equal(isRequestedVerificationEmail({ ...email, subject: 'Beta verification' }, { hint: 'Fixture' }), false);
  assert.equal(isRequestedVerificationEmail({ ...email, subject: 'Fixture reset your password' }, { hint: 'Fixture', purpose: 'sign_in' }), false);
});
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
