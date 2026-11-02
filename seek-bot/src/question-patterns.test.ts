import assert from 'node:assert/strict';
import { test } from 'node:test';
import { questionPatternIssue } from './question-patterns.js';
import { sealQuestionSnapshot } from './question-snapshot-node.js';
const input=(pattern:string,value:string,kind:'text'|'email'|'textarea'='text',multiple=false)=>({snapshot:sealQuestionSnapshot({version:2,source:{origin:'https://employer.test',path:'/apply'},prompt:'Reference',context:[],help:[],completeness:'complete',controls:[{id:'part0',label:'Reference',kind,required:true,multiple,choices:[],constraints:{pattern}}]}),response:{part0:value}});
test('HTML patterns are anchored, Unicode-aware, per-email and ignore malformed/non-applicable attributes',async()=>{
  assert.equal(await questionPatternIssue([input('[0-9]{4}','1234')]),null);
  assert.ok(await questionPatternIssue([input('[0-9]{4}','x1234x')]));
  assert.equal(await questionPatternIssue([input('[','anything')]),null);
  assert.equal(await questionPatternIssue([input('[0-9]{4}','not a number','textarea')]),null);
  assert.equal(await questionPatternIssue([input('[\\p{Letter}&&\\p{ASCII}]+','Alice')]),null);
  assert.ok(await questionPatternIssue([input('[\\p{Letter}&&\\p{ASCII}]+','123')]));
  assert.equal(await questionPatternIssue([input('.+@example\\.com','a@example.com, b@example.com','email',true)]),null);
  assert.ok(await questionPatternIssue([input('.+@example\\.com','a@example.com, b@other.com','email',true)]));
});
test('catastrophic employer regexes cannot stall the server event loop or silently accept an answer',async()=>{
  let heartbeat=false;
  const interval=setTimeout(()=>{heartbeat=true;},30);
  const started=performance.now();
  try {
    const issue=await questionPatternIssue([input('(a+)+','a'.repeat(1000)+'!')],200);
    assert.ok(issue);assert.equal(heartbeat,true);assert.ok(performance.now()-started<2500);
  }finally{clearTimeout(interval);}
});
