import assert from 'node:assert/strict';
import test from 'node:test';
import {applicationCompletionInstruction, applicationSuitabilityAuthority} from './application-policy.js';
test('selected and approved applications have one suitability authority; only unreviewed work gets matching policy',()=>{
 for(const args of [[true,false,false],[false,true,false],[false,false,true]] as const){
  const policy=applicationSuitabilityAuthority(args[0],args[1],args[2]);
  assert.doesNotMatch(policy,/Judge the actual work against|Do not widen the candidate|Assess suitability using/);
  assert.match(policy,/actual form/);
  assert.match(policy,/Truthful answers|answer truthfully/);
 }
 const fallback=applicationSuitabilityAuthority(false,false,false);
 assert.match(fallback,/Assess suitability/);assert.match(fallback,/Judge the actual work against/);
});

test('MiniMax receives the completion goal while Semi auto and truthful answers remain protected', () => {
 const instruction = applicationCompletionInstruction('minimax');
 assert.match(instruction, /complete and submit this application/);
 assert.match(instruction, /Semi auto.*candidate's confirmation/);
 assert.match(instruction, /Never invent candidate facts/);
 assert.equal(applicationCompletionInstruction('celeris'), '');
 assert.doesNotMatch(instruction,/target_mode/,'the explicit-target trial instruction is opt-in');
 assert.match(applicationCompletionInstruction('minimax',true),/target_mode.*Main-document fields have no iframe scope/);
 assert.equal(applicationCompletionInstruction('celeris',true),'');
 assert.equal(applicationCompletionInstruction('retired'), '');
});
