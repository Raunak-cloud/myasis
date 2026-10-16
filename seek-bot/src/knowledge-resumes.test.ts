import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,sep} from 'node:path';
const dir=mkdtempSync(resolve(tmpdir(),'owtomate-resume-evidence-'));
process.env.DATA_DIR=dir;
const {config}=await import('./config.js');
const {buildKnowledgeContext,knowledgeContextFingerprint}=await import('./knowledge.js');
const {reviewContextFingerprint}=await import('./review-cache.js');
mkdirSync(resolve(dir,'resumes'));
writeFileSync(resolve(dir,'knowledge.json'),'[]');
writeFileSync(resolve(dir,'resumes.json'),JSON.stringify([{id:'clinical',label:'Clinical CV',fileName:'clinical.txt',isDefault:true},
 {id:'retail',label:'Retail CV',fileName:'retail.txt'}]));
writeFileSync(resolve(dir,'resumes/clinical.txt'),'Clinical trial documentation and specimen handling.');
writeFileSync(resolve(dir,'resumes/retail.txt'),'Customer service, grocery stock handling and cash register work.');
const previous=config.resume.select;
try {
 config.resume.select='';
 const all=await buildKnowledgeContext('retail customer service');
 assert.match(all,/Clinical trial/);assert.match(all,/grocery stock/);
 const profile={} as Parameters<typeof reviewContextFingerprint>[0];
 const first=knowledgeContextFingerprint(), reviewBefore=reviewContextFingerprint(profile);
 writeFileSync(resolve(dir,'resumes/retail.txt'),'Updated retail evidence: visual merchandising.');
 utimesSync(resolve(dir,'resumes/retail.txt'),new Date(),new Date(Date.now()+1000));
 assert.notEqual(knowledgeContextFingerprint(),first);
 assert.notEqual(reviewContextFingerprint(profile),reviewBefore);
 const updated=await buildKnowledgeContext('retail');assert.match(updated,/visual merchandising/);assert.doesNotMatch(updated,/grocery stock/);
 config.resume.select='clinical';
 assert.notEqual(reviewContextFingerprint(profile),reviewBefore);
 const clinical=await buildKnowledgeContext('retail');assert.match(clinical,/Clinical trial/);assert.doesNotMatch(clinical,/visual merchandising/);
 config.resume.select='Retail CV';
 const retail=await buildKnowledgeContext('retail');assert.match(retail,/visual merchandising/);assert.doesNotMatch(retail,/Clinical trial/);
 console.log('PASS: all selected resumes ground matching; file edits invalidate knowledge and review caches; explicit resume selection is respected.');
}finally{
 config.resume.select=previous;
 assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+'owtomate-resume-evidence-'));
 rmSync(dir,{recursive:true,force:true});
}
