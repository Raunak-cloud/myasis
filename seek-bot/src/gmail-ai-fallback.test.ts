import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GmailMcpService} from './gmail-mcp-service.js';
import type {GmailMessage} from './gmail-mcp-client.js';
import {createVerificationAiFallback} from './verification-email-ai.js';
import type {CostMeter,CelerisReply} from './agent/celeris.js';

test('real mailbox transport preserves fast extraction, freshness and purpose gates around AI code/link fallback',async()=>{
  const {findVerificationInGmail}=await import('./gmail-mailbox.js');
  let body:GmailMessage={id:'synthetic-message',subject:'Suntory Account Verification',sender:'fixture@suntory.com',date:new Date().toISOString(),plaintextBody:'Your security code is 482751.'};
  const service=new GmailMcpService({search:async()=>[{id:'fixture-thread'}],thread:async()=>[body],send:async()=>{throw Error('No sends allowed');}});
  const grant=await service.grant('isolated-fixture-owner','fixture@fixture.invalid');
  const saved={...process.env};let calls=0;
  Object.assign(process.env,{GMAIL_MCP_URL:grant.connection.url,GMAIL_MCP_TOKEN:grant.connection.token,GMAIL_MCP_ACCOUNT:grant.connection.account,GMAIL_ACCESS_MODE:'mcp'});
  const fallback=createVerificationAiFallback({exhausted:false} as CostMeter,async request=>{
    calls++;const packet=JSON.parse(String(request.messages[1].content));
    return {text:JSON.stringify({candidate_id:packet.candidates[0].id,purpose:packet.purpose}),toolCalls:[],message:{role:'assistant',content:''}} as CelerisReply;
  });
  const options={hint:'Suntory',site:'https://career55.sapsf.eu/?company=SBFGROUP',purpose:'account_verification' as const,want:'code' as const,allowAlternative:true,timeoutMs:2000,fallback};
  try{
    const fast=await findVerificationInGmail(options);assert.ok(!('error'in fast)&&fast.value==='482751');assert.equal(calls,0);
    body={...body,htmlBody:'<p>Your passcode for account verification is</p><p>482751</p>',plaintextBody:''};
    const code=await findVerificationInGmail(options);assert.ok(!('error'in code)&&code.kind==='code'&&code.value==='482751',JSON.stringify({code,calls}));assert.equal(calls,1);
    body={...body,plaintextBody:'To finish establishing your candidate identity, use the Continue button.',htmlBody:'<a href="https://career55.sapsf.eu/private/action?company=SBFGROUP&amp;token=fixture">Continue</a>'};
    const link=await findVerificationInGmail(options);assert.ok(!('error'in link)&&link.kind==='link');assert.equal(calls,2,'link alternative works even when caller expected a code');
    body={...body,date:new Date(Date.now()-60*60_000).toISOString()};
    assert.ok('error'in await findVerificationInGmail({...options,timeoutMs:100}));assert.equal(calls,2,'stale mail never reaches AI');
    body={...body,date:new Date().toISOString(),subject:'Suntory Password Reset',plaintextBody:'Reset your password using Continue.'};
    assert.ok('error'in await findVerificationInGmail({...options,timeoutMs:100}));assert.equal(calls,2,'wrong-purpose messages never reach AI');
    body={...body,subject:'Other Employer Account Verification',sender:'other@other.invalid',htmlBody:'',plaintextBody:'Your passcode for account verification is 482751'};
    assert.ok('error'in await findVerificationInGmail({...options,timeoutMs:100}));assert.equal(calls,2,'unrelated mail never reaches AI');
    body={...body,subject:'Suntory Account Verification',sender:'fixture@suntory.com'};
    const controller=new AbortController();const cancelled=await findVerificationInGmail({...options,signal:controller.signal,
      fallback:async()=>{controller.abort();return{kind:'code',value:'482751',subject:body.subject??''};}});
    assert.ok('reason'in cancelled&&cancelled.reason==='cancelled','cancelled AI results cannot escape the mailbox window');
  }finally{
    grant.revoke();await service.close();
    for(const key of ['GMAIL_MCP_URL','GMAIL_MCP_TOKEN','GMAIL_MCP_ACCOUNT','GMAIL_ACCESS_MODE']){
      if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
    }
  }
});
