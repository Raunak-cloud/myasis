import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {FormLab,formCatalog} from './engine.mjs';
const create=key=>new FormLab({key,email:'fixture@example.invalid',id:'11111111-1111-4111-8111-111111111111',seed:21,secret:'test-only-secret'});
const post=async(lab,path,values)=>{const form=new FormData();for(const [key,value]of Object.entries(values)){for(const item of Array.isArray(value)?value:[value])form.append(key,item);}const req=new Request('http://forms.invalid',{method:'POST',body:form});return lab.request({method:'POST',path,body:Buffer.from(await req.arrayBuffer()),contentType:req.headers.get('content-type')},async message=>{lab.outbox=(lab.outbox||[]).concat(message);});};
const get=(lab,path,query='')=>lab.request({method:'GET',path,query},async()=>{});
test('fixture code and browser scripts parse without exposing grading answers',async()=>{
 for(const definition of formCatalog){const lab=create(definition.key);assert.equal(lab.pages.length,15);lab.state.verified=true;
  for(let number=1;number<=15;number++){lab.state.completed=Array.from({length:number-1},(_,i)=>i+1);lab.state.sessionExpired=true;const response=await get(lab,'/page/'+number);assert.equal(response.status,200);assert.ok(!response.body.includes('"expected":'));for(const script of response.body.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);}
 }
});
test('registration binds the recipient, verifies one-time codes and never stores plaintext credentials',async()=>{
 const lab=create('account');assert.equal((await get(lab,'/page/1')).status,302);
 assert.equal((await post(lab,'/register',{name:'Alex Morgan',email:'other@example.invalid',password:'Fictional-password-123',confirm:'Fictional-password-123'})).status,422);assert.equal(lab.state.mailCount,0);
 assert.equal((await post(lab,'/register',{name:'Alex Morgan',email:lab.email,password:'Fictional-password-123',confirm:'Fictional-password-123'})).status,200);
 const code=lab.outbox.at(-1).text.match(/code is: (\d{6})/)[1];assert.ok(!JSON.stringify(lab.state).includes('Fictional-password-123'));assert.ok(!JSON.stringify(lab.state).includes(code));
 assert.equal((await post(lab,'/verify',Object.fromEntries([...code].map((digit,i)=>['digit'+(i+1),digit])))).status,200);assert.equal(lab.state.codeAccepted,1);
 assert.equal((await post(lab,'/verify',Object.fromEntries([...code].map((digit,i)=>['digit'+(i+1),digit])))).status,409);
});
test('wrong codes have a bounded attempt count',async()=>{
 const lab=create('account');await post(lab,'/register',{name:'Alex Morgan',email:lab.email,password:'Fictional-password-123',confirm:'Fictional-password-123'});
 const actual=lab.outbox.at(-1).text.match(/code is: (\d{6})/)[1],wrong=actual==='000000'?'111111':'000000';
 for(let i=0;i<5;i++)assert.equal((await post(lab,'/verify',Object.fromEntries([...wrong].map((digit,n)=>['digit'+(n+1),digit])))).status,422);
 assert.equal((await post(lab,'/verify',Object.fromEntries([...actual].map((digit,n)=>['digit'+(n+1),digit])))).status,410);
});
test('three complete graded flows preserve files, recover faults, reject premature and duplicate sends',{timeout:55000},async()=>{
 await Promise.all(formCatalog.map(async definition=>{
  const lab=create(definition.key);lab.state.verified=true;lab.state.sessionExpired=true;
  assert.equal((await post(lab,'/save/15',{accuracy:'on',processing:'on'})).status,409);
  assert.equal((await post(lab,'/save/1',{fullName:'Wrong'})).status,422);assert.equal(lab.summary().submitted,false);
  for(const [index,spec]of lab.pages.entries()){
   const values={...spec.expected};for(const [key,rule]of Object.entries(spec.textChecks||{}))values[key]=(rule.words.join(' ')+' fictional test evidence. ').repeat(8);
   for(const [key,ids]of Object.entries(spec.uploads||{}))values[key]=ids.map(id=>new File([lab.materials.files[id].bytes],lab.materials.files[id].name));
   if(spec.review){assert.equal((await post(lab,'/save/'+(index+1),values)).status,422);assert.equal(lab.summary().submitted,false);values.processing='on';}
   let response=await post(lab,'/save/'+(index+1),values);if(spec.transient){assert.equal(response.status,503);response=await post(lab,'/save/'+(index+1),values);}assert.equal(response.status,200,response.body);
  }
  assert.equal(lab.summary().pagesCompleted,15);assert.equal(lab.summary().recoveredServiceFailures,3);assert.equal(lab.summary().submitted,true);
  assert.equal((await get(lab,'/receipt')).status,409);lab.state.pendingAt=0;assert.match((await get(lab,'/receipt')).body,/Application submitted successfully/);
  assert.equal((await post(lab,'/save/15',{accuracy:'on',processing:'on'})).status,409);
 }));
});
