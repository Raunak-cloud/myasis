import assert from 'node:assert/strict';
import {confirmationStartRefusal} from './start-run.js';
assert.equal(confirmationStartRefusal('manual','live',undefined,false),null);
assert.equal(confirmationStartRefusal('admin','live','auto',true),null);
assert.equal(confirmationStartRefusal('admin','live','auto',false)?.status,403);
assert.equal(confirmationStartRefusal('auto','live','auto',true)?.status,400);
assert.equal(confirmationStartRefusal('admin','search','auto',true)?.status,400);
assert.equal(confirmationStartRefusal('manual','live','semi-auto',true)?.status,400);
console.log('PASS approved retry policy: manual confirmation and verified operator retries only; scheduler, search, preparation and unverified operators refused.');
