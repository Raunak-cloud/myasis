import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GmailMcpClient } from './gmail-mcp-client.js';
import { GmailMcpService } from './gmail-mcp-service.js';

test('MCP cancellation identifies one read within one owner capability and drains before reuse',async()=>{
  let aStarted!:()=>void,bStarted!:()=>void,releaseA!:()=>void,releaseB!:()=>void;
  const readyA=new Promise<void>(done=>{aStarted=done;}),readyB=new Promise<void>(done=>{bStarted=done;});
  let signalA:AbortSignal|undefined,signalB:AbortSignal|undefined,latePublications=0,sends=0;
  const service=new GmailMcpService({
    search:async(owner,query,signal)=>{
      assert.equal(owner,'fixture-owner');assert.ok(signal);
      if(query==='cancel-this-read'){
        signalA=signal;aStarted();
        await new Promise<void>((done,reject)=>{releaseA=done;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
        signal.throwIfAborted();latePublications++;return [{id:'late-thread'}];
      }
      signalB=signal;bStarted();await new Promise<void>(done=>{releaseB=done;});signal.throwIfAborted();return [{id:'kept-thread'}];
    },
    thread:async()=>[],send:async()=>{sends++;throw Error('No send is authorized by this read-only fixture');},
  });
  const grant=await service.grant('fixture-owner','candidate@fixture.invalid'),controller=new AbortController();
  // Both fresh SDK clients allocate the same first JSON-RPC tool ID. Their
  // private client namespaces must keep cancellation from crossing requests.
  const a=new GmailMcpClient(grant.connection,undefined,{signal:controller.signal}),b=new GmailMcpClient(grant.connection);
  let pendingA:Promise<unknown>|undefined,pendingB:Promise<unknown>|undefined;
  try{
    pendingA=a.search('cancel-this-read');pendingB=b.search('keep-this-read');await Promise.all([readyA,readyB]);
    const cause=new Error('Fixture polling window ended');controller.abort(cause);
    await assert.rejects(pendingA,error=>error===cause);await a.close();
    assert.equal(signalA?.aborted,true,'the original read receives the MCP cancellation despite its aborted transport lifetime');
    assert.equal(signalB?.aborted,false,'a sibling client with the same JSON-RPC ID retains its read');
    assert.equal(latePublications,0);releaseB();assert.deepEqual(await pendingB,[{id:'kept-thread'}]);
    assert.equal(signalB?.aborted,false,'successful HTTP response completion never cancels the completed read');
    await assert.rejects(b.thread('late-thread'),/Search this mailbox/,'cancelled search cannot add late thread IDs to the capability');
    assert.deepEqual(await b.thread('kept-thread'),[],'the independent client remains usable');assert.equal(sends,0);
  }finally{releaseA?.();releaseB?.();await Promise.allSettled([pendingA,pendingB]);await Promise.all([a.close(),b.close()]);grant.revoke();await service.close();}
});
