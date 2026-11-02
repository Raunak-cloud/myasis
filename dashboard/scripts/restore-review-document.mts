import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {getPool} from '../server/db/index.js';
import {documentRestorationPlan,restoreReviewDocument} from '../server/application-review-document-restore.js';

// An explicit JSON data plan only: no paths/text overrides, commands, status
// mutations or hold-release capability are accepted by restoration entries.
if(process.argv.length!==3)throw Error('Usage: restore-review-document.mts <explicit-plan.json>');
const plan=JSON.parse(readFileSync(resolve(process.argv[2]),'utf8'));
if(!plan||typeof plan!=='object'||Array.isArray(plan)||plan.version!==1||Object.keys(plan).some(key=>!['version','restorations'].includes(key))
  ||!Array.isArray(plan.restorations)||!plan.restorations.length||plan.restorations.length>20)throw Error('Invalid closed document restoration plan.');
const entries=plan.restorations.map(documentRestorationPlan);
try{
 for(const entry of entries){const result=await restoreReviewDocument(entry);
  console.log(JSON.stringify({owner:entry.userId,draftId:result.application.id,originalRevision:entry.originalRevision,
    currentRevision:result.application.revision,alreadyCurrent:result.alreadyCurrent,holdId:entry.holdId,holdReleased:false}));
 }
}finally{await getPool().end();}
