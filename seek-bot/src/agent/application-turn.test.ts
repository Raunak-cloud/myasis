import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationTurnCoordinator } from './application-turn.js';

const state = { actionExhausted: false, pendingDialog: false, reviewRequested: false,
  needsAnswer: false, needsCorrection: false, submissionAttempted: false,
  preparations: ['prepare_application'] as ['prepare_application'] };

test('normal tools stay available and canonical review has one mandatory owner', () => {
 const owner = new ApplicationTurnCoordinator();
 assert.equal(owner.next(state).checkpoint, undefined);
 assert.equal(owner.next(state).tools, undefined);
 assert.equal(owner.next({...state,reviewRequested:true}).checkpoint,'record_application_review');
 assert.equal(owner.next({...state,reviewRequested:true,pendingDialog:true}).checkpoint,undefined);
});

test('completion is one-way despite late progress credits and preserves canonical validation', () => {
 const owner=new ApplicationTurnCoordinator();
 assert.deepEqual(owner.next({...state,actionExhausted:true}).tools,['finish','prepare_application']);
 owner.requested();owner.executed('prepare_application');
 const review=owner.next({...state,reviewRequested:true});
 assert.equal(review.completing,true);assert.equal(review.checkpoint,'record_application_review');
 owner.requested();
 assert.deepEqual(owner.next(state).tools,['finish','prepare_application'],'a review credit cannot reopen editing or consult/send tools');
 owner.executed('prepare_application');
 assert.deepEqual(owner.next(state).tools,['finish'],'another local draft retry cannot loop or switch recipients indefinitely');
 owner.executed('finish');assert.equal(owner.next(state).stopped,true);
});

test('unresolved corrections, required facts and uncertain sends cannot spend preparation reserve on actions', () => {
 for(const flags of [{needsAnswer:true},{needsCorrection:true},{submissionAttempted:true}]){
  const owner=new ApplicationTurnCoordinator();
  assert.deepEqual(owner.next({...state,actionExhausted:true,...flags}).tools,['finish']);
 }
});

test('malformed or unoffered tool replies cannot keep a zero-cost completion loop alive',()=>{
 const owner=new ApplicationTurnCoordinator();
 for(let i=0;i<5;i++){assert.equal(owner.next({...state,actionExhausted:true}).stopped,false);owner.requested();}
 assert.equal(owner.next({...state,reviewRequested:true}).stopped,true);
});
