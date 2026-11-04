import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareReplayBaseline} from './replay-baseline.mjs';

const baseline='a'.repeat(40),release='b'.repeat(40);
function fixture(work){
 const root=mkdtempSync(join(tmpdir(),'replay-baseline-'));
 const corpus=join(root,'output','deploy-smoke.fixture','corpus'),original=join(root,'account-record.json');
 mkdirSync(corpus,{recursive:true});mkdirSync(join(root,'seek-bot','node_modules'),{recursive:true});
 writeFileSync(original,'original private record');
 const calls=[],archive=Buffer.from([0,255,128,10]);
 const run=(command,args,options)=>{
  calls.push({command,args,options});
  if(args[0]==='rev-parse')return release+'\n';
  if(args[0]==='archive')return archive;
  if(command==='tar'){assert.deepEqual(options.input,archive);mkdirSync(join(args[2],'seek-bot'),{recursive:true});return '';}
  if(args[0]==='dist/form-replay.js')return 'Replayed 2/2: 1 regression(s), 0 change(s) — current readings accepted as expected.';
  return '';
 };
 try{work({root,corpus,original,calls,run});}finally{rmSync(root,{recursive:true,force:true});}
}

test('production comparison uses an isolated copy, preserves binary archives, and reports old differences',()=>fixture(f=>{
 const result=prepareReplayBaseline({...f,baseline,release},f.run);
 assert.deepEqual(result,{baseline,release,pages:2,historicalRegressions:1,historicalChanges:0});
 assert.equal(readFileSync(f.original,'utf8'),'original private record');
 assert.ok(f.calls.some(x=>x.command==='git'&&x.args.join(' ')==='merge-base --is-ancestor '+baseline+' '+release));
 const reads=f.calls.filter(x=>x.args[0]==='dist/form-replay.js');
 assert.equal(reads.length,1);assert.deepEqual(reads[0].args,['dist/form-replay.js',f.corpus,'--accept']);
 assert.equal(reads[0].options.env.CELERIS_API_KEY,'replay-only');
}));

test('malformed, identical and changed release references cannot establish a baseline',()=>fixture(f=>{
 for(const change of [{baseline:'main'},{baseline:release},{release:'c'.repeat(40)}])assert.throws(()=>prepareReplayBaseline({...f,baseline,release,...change},f.run));
 assert.equal(f.calls.filter(x=>x.args[0]==='archive').length,0);
}));

test('account records and nondeployment paths are refused before any command',()=>fixture(f=>{
 assert.throws(()=>prepareReplayBaseline({...f,corpus:f.root,baseline,release},f.run),/fresh deployment replay copy/);
 assert.equal(f.calls.length,0);
}));

test('ancestry, compilation and incomplete browser reads fail closed',()=>{
 for(const failure of ['merge-base','node_modules/typescript/bin/tsc','dist/form-replay.js'])fixture(f=>{
  const run=(command,args,options)=>{
   if(args[0]===failure){if(failure==='dist/form-replay.js')return 'Replayed 1/2: 1 regression(s), 0 change(s)';throw Error('fixture failure');}
   return f.run(command,args,options);
  };
  assert.throws(()=>prepareReplayBaseline({...f,baseline,release},run));
  assert.equal(readFileSync(f.original,'utf8'),'original private record');
 });
});
