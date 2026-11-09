import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { TECHNICAL_RETRY_REQUEST,TECHNICAL_RETRY_RESPONSE } from './technical-retry-types.js';

for(const mode of ['response','disconnect','deadline'])test(`technical retry IPC ${mode} resolves once and removes its listeners`,async()=>{
 const script=`
  globalThis.fetch=async()=>{throw Error('No network permitted');};
  const {runDeadline}=await import(${JSON.stringify(new URL('./run-deadline.js',import.meta.url).href)});
  const {claimTechnicalRetryFallback}=await import(${JSON.stringify(new URL('./technical-retry-client.js',import.meta.url).href)});
  const stop=runDeadline.listen(),before=process.listenerCount('message');
  const rows=await claimTechnicalRetryFallback(3);
  if(process.listenerCount('message')!==before)throw Error('IPC listener was not removed');
  if(rows.length!==${mode==='response'?1:0})throw Error('Unexpected retry result');
  if(process.connected)process.send({type:'test-complete',count:rows.length},()=>{});
  stop();
 `;
 let requests=0,result:number|undefined,errors='';
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe','ipc'],
  env:{...process.env,AUTO_TECHNICAL_RETRIES:'true',OWTOMATE_RUN_DEADLINE_AT:String(Date.now()+(mode==='deadline'?250:5000)),CELERIS_API_KEY:'',OPENROUTER_API_KEY:''}});
 child.stderr!.on('data',chunk=>errors+=String(chunk));
 child.on('message',(message:any)=>{
  if(message.type==='test-complete'){result=message.count;return;}
  if(message.type!==TECHNICAL_RETRY_REQUEST)return;
  requests++;assert.equal(message.shortfall,3);
  if(mode==='disconnect'){child.disconnect();return;}
  if(mode==='response'){
   child.send({type:TECHNICAL_RETRY_RESPONSE,requestId:'wrong-request',candidates:[]});
   child.send({type:TECHNICAL_RETRY_RESPONSE,requestId:message.requestId,candidates:[{key:'seek:saved'}]});
  }
 });
 const timer=setTimeout(()=>child.kill('SIGKILL'),10_000);
 try{
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0,errors);assert.equal(requests,1);
  if(mode!=='disconnect')assert.equal(result,mode==='response'?1:0);
 }finally{clearTimeout(timer);child.stderr?.destroy();}
});
