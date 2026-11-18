import assert from 'node:assert/strict';
import { employerApplicationAllowance } from './employer-site-access.js';

const free = { allowance: 5, used: 0, remaining: 5, trial: { employerSites: true as const, seekBonusApplications: 6, seekBonusAwarded: false } };
const paid = { hasActivePass: true, hasActiveEssentialPass: true, hasActiveJobSearchPass: false, hasActiveIntensivePass: false, expiresAt: null, remaining: 50, employerSiteRemaining: 10 };
assert.equal(employerApplicationAllowance({ paid, free }), 10);
assert.equal(employerApplicationAllowance({ paid: { ...paid, remaining: 2 }, free }), 2, 'the overall credit balance also applies');
assert.equal(employerApplicationAllowance({ paid: { ...paid, employerSiteRemaining: 0 }, free }), 0, 'a paid pass does not bypass its exhausted employer allowance using Free credits');
assert.equal(employerApplicationAllowance({ paid: { ...paid, hasActivePass: false }, free }), 5, 'Free retains its existing guest offer');

console.log('employer-site access checks passed');
