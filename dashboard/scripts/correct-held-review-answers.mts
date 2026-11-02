import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {getPool} from '../server/db/index.js';
import {correctHeldReviewAnswers,heldAnswerCorrectionPlan} from '../server/application-review-answer-correction.js';

if(process.argv.length!==3)throw Error('Usage: correct-held-review-answers.mts <explicit-plan.json>');
const file=resolve(process.argv[2]);
if(!statSync(file).isFile()||statSync(file).size>1_000_000)throw Error('Invalid bounded correction plan file.');
const input=JSON.parse(readFileSync(file,'utf8'));
if(!input||typeof input!=='object'||Array.isArray(input)||input.version!==1||Object.keys(input).length!==2
  ||Object.keys(input).some(key=>!['version','revisions'].includes(key))||!Array.isArray(input.revisions)||!input.revisions.length||input.revisions.length>20)
  throw Error('Provide one closed held-answer correction plan.');
const entries=input.revisions.map(heldAnswerCorrectionPlan);
try{
  for(const entry of entries){const result=await correctHeldReviewAnswers(entry);
    console.log(JSON.stringify({owner:entry.userId,draftId:result.application.id,previousRevision:entry.currentRevision,currentRevision:result.application.revision,
      auditId:result.auditId,alreadyCurrent:result.alreadyCurrent,holdId:entry.holdId,holdReleased:false}));
  }
}finally{await getPool().end();}
