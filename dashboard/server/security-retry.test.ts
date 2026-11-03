import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSiteSecurityFailure, securityRetryAt, securityRetryRemaining, securityRetryCountdown, SECURITY_RETRY_DELAY_MS } from '../src/securityRetry.js';

test('only reported site security failures receive the eight-hour delay', () => {
  for (const reason of [
    'Technical access blocker: anti-bot "Access is temporarily restricted" page instead of the application form.',
    'The CAPTCHA challenge persists and the application could not continue.',
    'The site security check could not be completed.',
    'Cloudflare security verification failed.',
  ]) assert.equal(isSiteSecurityFailure(reason),true,reason);
  for (const reason of ['Missing NV2 security clearance.', 'Candidate must answer security questions.',
    'Password was rejected.', 'Reset email could not be found.', 'The application spending budget was reached.',
    'Frame was detached.', 'Security check completed successfully.',
    'CAPTCHA completed successfully; password was rejected.',
    'Security check passed, but the email could not be retrieved.']) assert.equal(isSiteSecurityFailure(reason),false,reason);
  const blocked = '2026-11-03T09:06:43.000Z', deadline = securityRetryAt(blocked)!;
  assert.equal(deadline,'2026-11-03T17:06:43.000Z');
  const retry = { reason:'site-security' as const,retryAt:deadline };
  assert.equal(securityRetryRemaining(retry,Date.parse(blocked)),SECURITY_RETRY_DELAY_MS);
  assert.equal(securityRetryCountdown(SECURITY_RETRY_DELAY_MS),'8h 00m');
  assert.equal(securityRetryCountdown(1),'0h 01m');
  assert.equal(securityRetryRemaining(retry,Date.parse(deadline)-1),1);
  assert.equal(securityRetryRemaining(retry,Date.parse(deadline)),0);
  assert.equal(securityRetryRemaining(retry,Date.parse(deadline)+1),0);
  assert.equal(securityRetryAt('invalid'),null);
  assert.equal(securityRetryRemaining({reason:'site-security',retryAt:'invalid'}),0);
});
