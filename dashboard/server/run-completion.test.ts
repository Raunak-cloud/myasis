import assert from 'node:assert/strict';
import { runSucceeded } from './runner.js';

const atApplicationCap = { exitCode:0, stoppedByPerson:false, kind:'run' as const, applied:3, qualifyingJobs:null, applicationErrors:0 };
assert.equal(runSucceeded(atApplicationCap), true, 'three confirmed applications are a completed run even with remaining listings');
assert.equal(runSucceeded({...atApplicationCap,applied:1}), true, 'a clean partial run with a confirmed submission counts as completed');
assert.equal(runSucceeded({...atApplicationCap,applied:0}), false, 'an unfinished search with no submissions must remain retryable');
assert.equal(runSucceeded({...atApplicationCap,applied:0,qualifyingJobs:0}), true, 'a complete search finding no matches is a normal outcome');
assert.equal(runSucceeded({...atApplicationCap,applied:0,qualifyingJobs:2,applicationErrors:1}), false, 'application failures without any submissions remain retryable');
assert.equal(runSucceeded({...atApplicationCap,exitCode:1}), false, 'a crash remains retryable, even after a submission');
assert.equal(runSucceeded({...atApplicationCap,stoppedByPerson:true}), false, 'a stopped run must not consume its scheduled slot');
assert.equal(runSucceeded({...atApplicationCap,applied:0,kind:'scan'}), true);
console.log('PASS: application caps complete a clean run; incomplete empty, stopped and failed runs remain retryable');
