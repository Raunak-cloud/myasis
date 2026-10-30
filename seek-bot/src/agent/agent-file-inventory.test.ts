import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('the evidence inventory distinguishes readable documents from actual upload capabilities',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'owtomate-upload-inventory-'));
 const prior=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 try{
  mkdirSync(join(dir,'resumes'));mkdirSync(join(dir,'knowledge'));
  writeFileSync(join(dir,'resumes','CV.txt'),'Original CV bytes');
  writeFileSync(join(dir,'knowledge','Letter.txt'),'Exact supporting letter text');
  writeFileSync(join(dir,'resumes.json'),JSON.stringify([{id:'30',label:'CV',fileName:'CV.txt'}]));
  writeFileSync(join(dir,'knowledge.json'),JSON.stringify([{id:'10',label:'Letter',kind:'file',enabled:true,fileName:'Letter.txt'},
    {id:'hidden',label:'Disabled',kind:'file',enabled:false,fileName:'Letter.txt'},{id:'note',label:'Note',kind:'note',enabled:true,text:'Evidence only'}]));
  const {agentOnlyEvidence}=await import('./agent-only-evidence.js');
  const {AgentFiles}=await import('./agent-files.js');
  const inventory=await agentOnlyEvidence('document-inventory');
  assert.match(inventory,/"file_id":"30","uploadable":true/);
  assert.match(inventory,/"id":"10"[^\n]*"file_id":"supporting:10"/);
  assert.match(inventory,/"id":"note"[^\n]*"uploadable":false/);
  const files=new AgentFiles('inventory-fixture');
  assert.equal(readFileSync(files.resolve('30').path,'utf8'),'Original CV bytes');
  assert.equal(readFileSync(files.resolve('supporting:10').path,'utf8'),'Exact supporting letter text');
  assert.throws(()=>files.resolve('10'),/supporting:<id>/);
  assert.throws(()=>files.resolve('supporting:hidden'),/file ID/);
  assert.throws(()=>files.resolve('supporting:note'),/file ID/);
  assert.throws(()=>files.resolve('supporting:../another-owner'),/file ID/);
  const approved=new AgentFiles('approved-inventory-fixture',{resumeId:'30',coverLetter:'Exact supporting letter text'} as never);
  assert.equal(readFileSync(approved.resolve('30').path,'utf8'),'Original CV bytes');
  assert.throws(()=>approved.resolve('supporting:10'),/candidate-approved/, 'new original attachments cannot bypass the approved document boundary');
  assert.match(await agentOnlyEvidence('10'),/Exact supporting letter text/);
  const rendered=await files.create('Letter','Exact supporting letter text','txt');
  assert.equal(readFileSync(files.resolve(rendered.file_id).path,'utf8'),'Exact supporting letter text');
 }finally{prior===undefined?delete process.env.DATA_DIR:process.env.DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
});
