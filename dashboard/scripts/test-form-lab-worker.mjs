import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {FormLab} from '../server/form-lab/engine.mjs';
const id='22222222-2222-4222-8222-222222222222',lab=new FormLab({key:'enterprise',email:'fixture@example.invalid',seed:21,id,secret:'worker-test-only'}),token='fixture-worker-capability';
let calls=0,portalReads=0;
const server=createServer(async(req,res)=>{try{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 if(req.url.endsWith('/chat/completions')){calls++;assert.ok(calls<=3);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'fixture-'+calls,type:'function',function:{name:'finish',arguments:JSON.stringify({status:'skipped',reason:'Controlled worker smoke check complete.',evidence:'Inspected the isolated fictional portal.'})}}]}}],usage:{prompt_tokens:100,completion_tokens:20}}));return;}
 assert.equal(req.headers['x-owtomate-form-test'],token);portalReads++;
 const url=new URL(req.url,'http://fixture.invalid'),response=await lab.request({method:req.method,path:url.pathname.slice(lab.base.length),query:url.search,body:Buffer.concat(chunks),contentType:req.headers['content-type']},async()=>{throw Error('No email is allowed.');});res.writeHead(response.status,response.headers);res.end(response.body);
}catch(error){res.writeHead(500);res.end(error.message);}});
const output=resolve(import.meta.dirname,'../../output/form-lab-worker-check');mkdirSync(output,{recursive:true});let child;
const deadline=setTimeout(()=>{child?.kill();console.error('Worker check exceeded one minute');process.exit(1);},55000);deadline.unref();
try{
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 child=spawn(process.execPath,[resolve(import.meta.dirname,'../server/form-lab/worker.mjs')],{stdio:['ignore','pipe','pipe'],env:{...process.env,CELERIS_API_KEY:'fixture-not-a-real-key',CELERIS_BASE_URL:origin,OPENROUTER_API_KEY:'',CELERIS_QUEUE_FILE:resolve(output,'queue.json'),APPLICATION_AI_MODEL:'celeris',CHROME_PATH:process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':process.env.CHROME_PATH||'/usr/bin/google-chrome-stable',FORM_LAB_ID:id,FORM_LAB_KEY:'enterprise',FORM_LAB_EMAIL:lab.email,FORM_LAB_OUTPUT:output,FORM_LAB_TOKEN:token,FORM_LAB_BACKEND:origin,GMAIL_MCP_URL:'',GMAIL_MCP_TOKEN:'',GMAIL_MCP_ACCOUNT:''}});
 let logs='';child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
 assert.equal(code,0,logs.slice(-1200));const result=JSON.parse(readFileSync(resolve(output,'result.json'),'utf8'));assert.equal(result.error,undefined);assert.equal(result.result.outcome.status,'rehearsed');assert.match(result.result.outcome.stoppedAt,/Agent judgement: skipped\. Inspected the isolated fictional portal/);assert.ok(calls>=1&&calls<=3);assert.ok(portalReads>0);assert.equal(lab.state.receipt,null);
 console.log(JSON.stringify({workerPassed:true,isolatedPortalReached:true,productionAgentLoaded:true,mockedModelCalls:calls,realModelCalls:0,emails:0,submitted:0}));
}finally{clearTimeout(deadline);child?.kill();server.closeAllConnections();await new Promise(done=>server.close(done));}
