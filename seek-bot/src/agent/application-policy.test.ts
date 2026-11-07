import assert from 'node:assert/strict';
import test from 'node:test';
import {AGENT_ONLY_PROMPT,applicationCompletionInstruction, applicationSuitabilityAuthority} from './application-policy.js';
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


test('the browser-owner prompt cannot reinstate a mandatory recovery report',()=>{
 assert.doesNotMatch(AGENT_ONLY_PROMPT,/required specialist recovery obligation/);
 assert.match(AGENT_ONLY_PROMPT,/structured recovery reports are optional/);
 assert.match(AGENT_ONLY_PROMPT,/finish error with the observed technical blocker/);
});


test('the applying agent owns recovery, supported inference and application consent',()=>{
 assert.doesNotMatch(AGENT_ONLY_PROMPT,/ask consult_application_specialist|may consult a read-only specialist/);
 assert.match(AGENT_ONLY_PROMPT,/Australian citizenship supports Australian nationality/);
 assert.match(AGENT_ONLY_PROMPT,/answer No unless other candidate evidence contradicts/);
 assert.match(AGENT_ONLY_PROMPT,/Accept all terms and conditions/);
 assert.match(AGENT_ONLY_PROMPT,/Only request user input for a genuinely required personal question/);
});
