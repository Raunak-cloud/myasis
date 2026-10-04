import assert from 'node:assert/strict';
import { runner } from './runner.js';

/**
 * A second Start for an account is refused before it reaches the profile
 * clean-up, so it can never close the browser the first start is using.
 */
const account = 'claim-test-account';

assert.equal(runner.inUse(account), false);
assert.equal(runner.claimStart(account), true, 'the first start claims the account');
assert.equal(runner.inUse(account), true, 'a starting run holds the account');
assert.equal(runner.claimStart(account), false, 'a second start is refused while the first prepares');
assert.equal(runner.claimStart('another-account'), true, 'other accounts are unaffected');
runner.releaseStart('another-account');
runner.releaseStart(account);
assert.equal(runner.inUse(account), false);
assert.equal(runner.claimStart(account), true, 'the account can start again once released');
runner.releaseStart(account);

console.log('PASS: one start per account at a time; a second start is refused before any browser clean-up');
