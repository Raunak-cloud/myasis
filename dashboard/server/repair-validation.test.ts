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
  assert.doesNotThrow(()=>validateRepairProposal({[path]:source[path].replaceAll('\n','\r\n')},valid));
  assert.throws(()=>validateRepairProposal(source,{...valid,files:{[path]:source[path].replaceAll('\n','\r\n')}}),'line-ending-only changes are not a repair');
  const contract='function inspect(page: Page) {\n assertBrowserPage(page);\n return page.locator("input");\n}\n';
  assert.throws(()=>validateRepairProposal({[path]:contract},{...valid,files:{[path]:contract.replace(' assertBrowserPage(page);','')}}),/protected/,'automatic coding cannot remove the argument contract');
});

test('browser ownership references are distinguished from account ownership by their bindings',()=>{
  const baseline='import type { Page } from "patchright";\nfunction inspect(page: Page) {\n const ownerFrame = page.frames().at(-1)!;\n return (ownerFrame as unknown as { page: Page }).page;\n}\n';
  assert.doesNotThrow(()=>validateRepairProposal({[path]:baseline},{files:{[path]:baseline.replace('(ownerFrame as unknown as { page: Page }).page','ownerFrame.page()')},summary:'invoke browser API',costUsd:0}));
  const browserMember='function documentFor(node: Element) {\n return node.ownerDocument;\n}\n';
  assert.doesNotThrow(()=>validateRepairProposal({[path]:browserMember},{files:{[path]:browserMember.replace('node.ownerDocument','node.ownerDocument ?? document')},summary:'DOM inspection',costUsd:0}));
  for(const declaration of ['const ownerFrame = account.owner;','const ownerId = "183";','const ownerFrame: any = account.owner;']){
    const original=declaration+'\nif (ownerFrame) check();\n';
    assert.throws(()=>validateRepairProposal({[path]:original},{files:{[path]:original.replace('check()','bypass()')},summary:'forbidden',costUsd:0}),/protected/);
  }
  assert.throws(()=>validateRepairProposal({[path]:baseline},{files:{[path]:baseline+'\nconst ownerId = "different-account";'},summary:'new account access',costUsd:0}),/protected/);
  const forged='import type { Frame } from "patchright";\nfunction inspect(account:any) {\n const ownerFrame:Frame=account.owner;\n return ownerFrame;\n}\n';
  assert.throws(()=>validateRepairProposal({[path]:forged},{files:{[path]:forged.replace('return ownerFrame','return null')},summary:'not a proven browser binding',costUsd:0}),/protected/);
  assert.throws(()=>validateRepairProposal({[path]:baseline},{files:{[path]:baseline.replace('page.frames().at(-1)!','account.owner')},summary:'cannot turn a browser binding into account access',costUsd:0}),/protected/);
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
  assert.equal(traceProvesNoSend({...trace,steps:[],sendAudit:{attempted:false,phase:'before-tools'}},'100','attempt'),true);
  assert.equal(traceProvesNoSend({...trace,steps:[{...trace.steps[0],completedAt:null}],sendAudit:{attempted:false,phase:'before-tools'}},'100','attempt'),false);
  const rejected={...trace.steps[0],tool:'browser_action',args:{action:'click'},execution:'not-started',disposition:'failed'};
  assert.equal(traceProvesNoSend({...trace,steps:[rejected]},'100','attempt'),true,'a completed pre-dispatch rejection did not touch the browser');
  for(const patch of [{execution:'started'},{execution:undefined},{completedAt:null}])assert.equal(traceProvesNoSend({...trace,steps:[{...rejected,...patch}]},'100','attempt'),false,'an uncertain or incomplete operation remains unsafe');
  assert.equal(traceProvesNoSend({...trace,steps:[rejected],sendAudit:{attempted:true}},'100','attempt'),false,'the send audit always overrides a rejected later call');
});
