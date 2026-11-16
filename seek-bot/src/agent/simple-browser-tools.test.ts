import assert from 'node:assert/strict';
import test from 'node:test';
import { agentOnlyTools } from './agent-only.js';
import { browserToolCall } from './browser-tools.js';
import { minimaxToolSchema } from './provider-tool-schema.js';
import { toolInputIssue } from './tool-input.js';
import { ApplicationMemory } from './application-memory.js';
import type { FormField } from '../types.js';
import { traceProvesNoSend } from '../repair-safety.js';

const tool = (name: string) => agentOnlyTools.find(item => item.name === name)!;
test('common tools advertise small ref-based inputs while advanced operations retain full capability', () => {
  for (const [name, keys] of Object.entries({ browser_fill: ['ref','value'], browser_click: ['ref','sends_application'],
    browser_select_dropdown: ['ref','option'], browser_choose_radio: ['ref'], browser_set_checkbox: ['ref','checked'],
    browser_inspect: ['ref'], browser_snapshot: ['screenshot'] })) {
    assert.deepEqual(Object.keys(tool(name).parameters.properties as object).sort(),keys.sort());
  }
  for (const schema of [tool('browser_run_script').parameters,minimaxToolSchema(tool('browser_run_script')).parameters]) {
    assert.ok(toolInputIssue({},schema)); assert.ok(toolInputIssue({script:''},schema));
    assert.equal(toolInputIssue({script:'return document.title',script_intent:'inspect'},schema),null);
  }
  const advanced = tool('browser_action').parameters;
  for (const args of [
    {action:'fill',locator:{by:'label',value:'Name',frame:'frame1',within:'#application'},value:'Alex'},
    {action:'fill',selector:'[contenteditable=true]',value:'Letter'},
    {action:'click',x:20,y:30,target_mode:'coordinates',sends_application:false},
    {action:'set_input_files',selector:'#attach',file_ids:['cv'],file_chooser:true},
    {action:'wait',wait:{url:'**/next',timeout_ms:30000}},
    {action:'take_snapshot',locator:{by:'css',value:'#questions'},screenshot:true},
    {action:'select_page',page_index:1}, {action:'dialog',value:'accept'},
    {action:'type',ref:'f0',value:'Search'}, {action:'scroll',ref:'a0',value:'down'},
  ]) assert.equal(toolInputIssue(args,advanced),null,JSON.stringify(args));
  const account=tool('fill_authentication_fields');
  assert.equal(toolInputIssue({purpose:'sign_in',refs:['f0','f1']},account.parameters),null);
  assert.match(account.description,/Ordinary application answers/);
});

test('named batches preserve exact values, unchecked state, file IDs and send intent without changing legacy calls', () => {
  const calls=[{tool:'browser_fill',args:{ref:'f0',value:'Exact answer'}},
    {tool:'browser_select_dropdown',args:{ref:'f1',option:'Other'}},
    {tool:'browser_set_checkbox',args:{ref:'f2',checked:false}},
    {tool:'browser_upload',args:{ref:'f3',file_ids:['cv'],file_chooser:true}},
    {tool:'browser_press_key',args:{key:'Enter',sends_application:true}}];
  const original=structuredClone(calls),batch=tool('browser_batch');
  assert.equal(toolInputIssue({actions:calls},batch.parameters),null);
  const canonical=browserToolCall('browser_batch',{actions:calls});
  assert.deepEqual(canonical.args.actions,[{action:'fill',ref:'f0',value:'Exact answer'},
    {action:'select',ref:'f1',value:'Other'},{action:'check',ref:'f2',value:'false'},
    {action:'set_input_files',ref:'f3',file_ids:['cv'],file_chooser:true},{action:'press',value:'Enter',sends_application:true}]);
  assert.deepEqual(calls,original);
  assert.deepEqual(browserToolCall('browser_batch',canonical.args),canonical);
  const trace={runStartId:'1',attemptId:'fixture',outcome:{status:'skipped'},sendAudit:{attempted:false},job:{url:'https://fixture.invalid/apply'}};
  const audit=(actions:unknown[])=>traceProvesNoSend({...trace,steps:[{tool:'browser_batch',args:{actions},execution:'started',completedAt:new Date().toISOString()}]},'1','fixture');
  assert.equal(audit(calls),false,'named batches retain the keyboard send marker');
  assert.equal(audit(calls.slice(0,4)),true,'ordinary edits are still provably before any send');
});

test('application memory keeps repeated failures visible without stopping retries or exposing private values', () => {
  const memory=new ApplicationMemory();memory.remember('Resume attached. Next resolve School.');
  for(let i=0;i<5;i++)memory.failed('fill_authentication_fields',{refs:['f1'],value:'PRIVATE_ANSWER'},'https://fixture.invalid/apply?token=PRIVATE_TOKEN','Wrong tool: ordinary application field. Use browser_fill.');
  const fields=[{ref:'f0',label:'Name',currentValue:'PRIVATE_NAME',required:true},
    {ref:'f1',label:'School',currentValue:'',required:true},
    {ref:'f2',label:'Password',currentValue:'PRIVATE_PASSWORD',sensitive:true}] as FormField[];
  const rendered=memory.render(fields);
  assert.match(rendered,/Resume attached/); assert.match(rendered,/f0: Name/);assert.match(rendered,/f1: School/);
  assert.match(rendered,/"count":5/); assert.match(rendered,/browser_fill/);assert.doesNotMatch(rendered,/PRIVATE_|Password/);
  const resumed=new ApplicationMemory();resumed.restore(memory.checkpoint());assert.equal(resumed.render(fields),rendered);
  assert.doesNotMatch(memory.render([]),/f0: Name/,'fresh page evidence replaces old completed-field labels');
  assert.equal('blocked' in memory.checkpoint(),false);
});
