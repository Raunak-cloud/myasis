import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepairPilotDetector,waitingRepairCheckpoint,repairSourceSite,repairSourceSites,deploymentAllowsLiveRepair } from './repair-pilot.js';

const attemptId = 'e9cf35f9-b0c0-4209-95c6-849c51a774a5';
const event = { id: 'a9cf35f9-b0c0-4209-95c6-849c51a774a5', runStartId: '1081', attemptId, severity: 'warning', category: 'tool_error', tool: 'create_file', message: 'untrusted employer data and private information' };
const next = { ...event, id: 'b9cf35f9-b0c0-4209-95c6-849c51a774a5' };

test('existing workers may recover while deployment drains, but never while shared files change',()=>{
  assert.equal(deploymentAllowsLiveRepair(null),true);
  assert.equal(deploymentAllowsLiveRepair('draining\n'),true);
  for(const marker of ['', 'building', 'unknown', 'draining building'])assert.equal(deploymentAllowsLiveRepair(marker),false);
});

test('repair context retains only the failing internal module and function, never raw stacks or unrelated paths',()=>{
  const error=new Error('private candidate value');
  error.stack='Error: private candidate value\n    at browserTarget (file:///private/account/seek-bot/dist/agent/browser-target.js:50:24)\n    at act (file:///private/account/seek-bot/dist/agent/agent-only.js:90:2)';
  const site=repairSourceSite(error);
  assert.deepEqual(site,{path:'seek-bot/src/agent/browser-target.ts',function:'browserTarget'});
  const incident=new RepairPilotDetector('1','raunak.vision@gmail.com',true).observe('1081',{...event,failureKind:'execution',sourceSite:{...site,stack:error.stack}});
  assert.deepEqual(incident?.sourceSite,site);assert.doesNotMatch(JSON.stringify(incident),/private|account\/|stack/);
  error.stack='Error: private candidate value\n    at locate (file:///private/account/seek-bot/dist/agent/browser-target.js:30:24)\n    at browserTarget (file:///private/account/seek-bot/dist/agent/browser-target.js:80:2)\n    at act (file:///private/account/seek-bot/dist/agent/agent-only.js:90:2)';
  const sourceSites=repairSourceSites(error);
  assert.deepEqual(sourceSites,[{path:'seek-bot/src/agent/browser-target.ts',function:'locate'},site]);
  const chain=new RepairPilotDetector('1','raunak.vision@gmail.com',true).observe('1081',{...event,failureKind:'execution',sourceSites:[...sourceSites,{path:'seek-bot/.env',function:'secret'}]});
  assert.deepEqual(chain?.sourceSites,sourceSites);assert.doesNotMatch(JSON.stringify(chain),/private|secret|account\//);
  error.stack='Error: private\n    at anything (https://employer.test/agent/browser-target.js:1:2)';
  assert.equal(repairSourceSite(error),undefined);
  assert.equal(new RepairPilotDetector('1','raunak.vision@gmail.com',true).observe('1081',{...event,failureKind:'execution',sourceSite:{path:'seek-bot/.env',function:'secret'}})?.sourceSite,undefined);
});

test('the pilot only emits bounded metadata for repeated failures in the exact admin account', () => {
  for (const detector of [new RepairPilotDetector('183', 'raunak.vision@gmail.com', true), new RepairPilotDetector('1', 'other@example.com', true), new RepairPilotDetector('1', 'raunak.vision@gmail.com', false)]) {
    assert.equal(detector.observe('1081', event), null);
    assert.equal(detector.observe('1081', event), null);
  }
  const detector = new RepairPilotDetector('1', 'raunak.vision@gmail.com', true);
  assert.equal(detector.observe('1080', event), null);
  assert.equal(detector.observe('1081', event), null);
  assert.equal(detector.observe('1081', event), null, 'replayed diagnostic ids cannot create a false repeated failure');
  const incident = detector.observe('1081', next);
  assert.deepEqual(incident, { runId: '1081', attemptId, category: 'repeated_tool_failure', tool: 'create_file', count: 2 });
  assert.doesNotMatch(JSON.stringify(incident), /private information|untrusted employer/);
  assert.equal(detector.observe('1081', event), null, 'one incident is emitted per repeated failure');
});

test('coding starts only for the exact live worker checkpoint, with a bounded wait',()=>{
  const now=Date.now(),event={runStartId:'100',relatedAttemptId:attemptId,category:'repair_waiting',at:new Date(now).toISOString()};
  assert.equal(waitingRepairCheckpoint('100',attemptId,[event],now),true);
  for(const events of [[],[{...event,runStartId:'101'}],[{...event,relatedAttemptId:'foreign'}],[{...event,at:'invalid'}],
    [{...event,at:new Date(now-360001).toISOString()}],[event,{...event,category:'repair_expired'}]])
    assert.equal(waitingRepairCheckpoint('100',attemptId,events,now),false);
});

test('a confirmed execution failure yields immediately for snapshots and any registered tool, without a duplicate catalogue',()=>{
  for(const tool of ['take_snapshot','browser_action','new_native_inspector']){
    const detector=new RepairPilotDetector('1','raunak.vision@gmail.com',true);
    const incident=detector.observe('1081',{...event,tool,failureKind:'execution',message:'Observed target is no longer on the page.'});
    assert.equal(incident?.category,'tool_execution_failure');assert.equal(incident?.count,1);assert.equal(incident?.code,'target_missing');
    assert.equal(detector.observe('1081',{...event,tool,failureKind:'execution'}),null,'replayed events remain deduplicated');
  }
  for(const failureKind of ['arguments','validation','external']){
    const detector=new RepairPilotDetector('1','raunak.vision@gmail.com',true);
    assert.equal(detector.observe('1081',{...event,tool:'take_snapshot',failureKind}),null);
    assert.equal(detector.observe('1081',{...next,tool:'take_snapshot',failureKind}),null);
  }
});

test('provider failures, security challenges and malformed identifiers do not trigger code changes', () => {
  const detector = new RepairPilotDetector('1', 'raunak.vision@gmail.com', true);
  for (const category of ['provider_error', 'budget_exhausted', 'captcha', 'stale_target']) {
    assert.equal(detector.observe('1081', { ...event, category }), null);
    assert.equal(detector.observe('1081', { ...event, category }), null);
  }
  assert.equal(detector.observe('1081', { ...event, attemptId: '../../other-account' }), null);
  assert.equal(detector.observe('1081', { ...event, id: 'c9cf35f9-b0c0-4209-95c6-849c51a774a5', category: 'application_exception', severity: 'error' })?.category, 'application_exception');
});
