import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepairProposal, traceProvesNoSend } from './repair-validation.js';

const path = 'seek-bot/src/agent/browser-target.ts';
const source = { [path]: 'import { safe } from "./safe.js";\nconst approved = safe;\nconst timeout = 100;\n' };
test('automatic proposals preserve controls and deny new I/O or broad patches', () => {
  const valid = { files: { [path]: source[path].replace('100','200') }, summary:'adjust timeout', costUsd:0 };
  assert.doesNotThrow(() => validateRepairProposal(source,valid));
  for (const content of [source[path].replace('approved = safe','approved = true'), source[path]+'fetch("https://example.com");', source[path]+Array.from({length:101},(_,i)=>`const a${i}=1;`).join('\n')])
    assert.throws(() => validateRepairProposal(source,{...valid,files:{[path]:content}}));
  assert.throws(() => validateRepairProposal(source,{...valid,files:{'../secret': 'changed'}}));
});
const trace = {runStartId:'100',attemptId:'attempt',outcome:{status:'skipped'},sendAudit:{attempted:false},
  steps:[{tool:'browser_action',args:{action:'fill',value:'fixture'},completedAt:'now',label:'fill name'}]};
test('retry evidence rejects missing audits, incomplete actions, scripts and uncertain sends', () => {
  assert.equal(traceProvesNoSend(trace,'100','attempt'),true);
  for (const patch of [{sendAudit:undefined},{sendAudit:{attempted:true}},{outcome:{status:'applied'}},{steps:[]},
    ...[{action:'script'},{action:'press'},{action:'click',sends_application:true},{action:'mouse_click'},{action:'click',x:0}]
      .map(args=>({steps:[{...trace.steps[0],args}]})),{steps:[{...trace.steps[0],completedAt:null}]},
    {steps:[{...trace.steps[0],label:'submit application'}]}])
    assert.equal(traceProvesNoSend({...trace,...patch},'100','attempt'),false,JSON.stringify(patch));
  assert.equal(traceProvesNoSend(trace,'101','attempt'),false);
});
