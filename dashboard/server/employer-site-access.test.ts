import assert from 'node:assert/strict';
import { mayRunEmployerSiteApplications } from './employer-site-access.js';

assert.equal(mayRunEmployerSiteApplications({ targetIsAdmin: true, initiatedByAdmin: false, hasIntensiveAllowance: false }), true);
assert.equal(mayRunEmployerSiteApplications({ targetIsAdmin: false, initiatedByAdmin: true, hasIntensiveAllowance: true }), true);
assert.equal(mayRunEmployerSiteApplications({ targetIsAdmin: false, initiatedByAdmin: false, hasIntensiveAllowance: true }), false);
assert.equal(mayRunEmployerSiteApplications({ targetIsAdmin: false, initiatedByAdmin: true, hasIntensiveAllowance: false }), false);

console.log('employer-site access checks passed');
