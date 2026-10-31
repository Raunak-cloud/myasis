import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {getPool} from './db/index.js';
import {handleFormsRequest,formAdminAction} from './form-lab.js';
import {handleAdminRequest} from './admin.js';
import {runner,MAX_CONCURRENT} from './runner.js';
import {userDir,USERS_DIR} from './userdata.js';
import {rmSync} from 'node:fs';
import {dirname} from 'node:path';
const pool=getPool(),original=pool.query,admins=process.env.ADMIN_EMAILS;
process.env.ADMIN_EMAILS='forms-admin@example.invalid';let actor:string|null=null;
pool.query=(async(sql:string)=>({rows:sql.includes('FROM sessions')&&actor?[{id:'forms-access-fixture',email:actor,name:'Fixture',avatar_url:null}]:[]})) as typeof original;
try{
 for(const email of [null,'ordinary@example.invalid','forms-admin@example.invalid']){
  actor=email;
  for(const path of ['/forms','/forms/attempts/11111111-1111-4111-8111-111111111111/page/1','/forms/attempts/11111111-1111-4111-8111-111111111111/screenshot']){
   const req=Object.assign(Readable.from([]),{url:path,method:'GET',headers:{cookie:'myasis_session=fixture'}}) as IncomingMessage;
   let status=0,body='';const res={setHeader:()=>{},writeHead:(code:number)=>{status=code;},end:(text:string)=>{body=text;}} as unknown as ServerResponse;
   assert.equal(await handleFormsRequest(req,res),true);
   assert.equal(status,email===null?401:email==='ordinary@example.invalid'?403:path==='/forms'?200:404);
   if(email==='ordinary@example.invalid')assert.ok(!body.includes('Create your test candidate account'));
  }
  let apiStatus=200;
  await handleAdminRequest({method:'POST',headers:{cookie:'myasis_session=fixture'},on:()=>{}},{writeHead:()=>{},write:()=>{}},new URL('https://example.invalid/api/admin/forms'),(_body,status=200)=>{apiStatus=status;},async()=>({key:'enterprise',model:'celeris',action:'run',confirm:false}));
  assert.equal(apiStatus,email===null?401:email==='ordinary@example.invalid'?403:400);
 }
 const actorInfo={id:'forms-access-fixture',email:'forms-admin@example.invalid',name:'Fixture',avatarUrl:null};
 assert.equal((await formAdminAction(actorInfo,'/forms','POST',{key:'enterprise',action:'run',model:'celeris',confirm:false})).status,400,'API requires deliberate spending confirmation');
 const reservations=Array.from({length:MAX_CONCURRENT},(_,i)=>'forms-capacity-fixture-'+i);
 try{for(const id of reservations)assert.equal(runner.claimStart(id),true);assert.equal((await formAdminAction(actorInfo,'/forms','POST',{key:'enterprise',action:'run',model:'celeris',confirm:true})).status,409,'test launch shares the real capacity reservation');}finally{for(const id of reservations)runner.releaseStart(id);}
 const created=await formAdminAction(actorInfo,'/forms','POST',{key:'enterprise',action:'run',model:'celeris',confirm:true});assert.equal(created.status,201);
 const id=(created.body as {id:string}).id;
 for(let i=0;i<30&&runner.inUse(actorInfo.id);i++)await new Promise(done=>setTimeout(done,10));
 assert.equal(runner.inUse(actorInfo.id),false,'failed account preparation releases the reserved server slot');
 const failed=await formAdminAction(actorInfo,'/forms/'+id,'GET');assert.equal((failed.body as {status:string}).status,'error');
 const req=Object.assign(Readable.from([]),{url:'/forms/attempts/11111111-1111-4111-8111-111111111111/page/1',method:'GET',headers:{'x-owtomate-form-test':'forged'}}) as unknown as IncomingMessage;
 let status=0;await handleFormsRequest(req,{setHeader:()=>{},writeHead:(code:number)=>{status=code;},end:()=>{}} as unknown as ServerResponse);assert.equal(status,403,'forged worker capability cannot bypass admin access');
 console.log('PASS form access: anonymous/customer denial, admin HTML, private screenshots, API authorization, explicit launch confirmation and forged capabilities. No worker, model call, email or real database operation.');
}finally{pool.query=original;if(admins===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=admins;await pool.end();const fixture=userDir('forms-access-fixture');assert.equal(dirname(fixture),USERS_DIR);rmSync(fixture,{recursive:true,force:true});}
