/** Explicit operator correction. Dry run unless --apply is supplied. */
import {readFileSync} from 'node:fs';
import {getPool,query} from '../server/db/index.js';
import {restoreFailedPreparationCredit} from '../server/application-reviews.js';
const file=process.argv.find(arg=>arg.startsWith('--request='))?.slice(10);
if(!file)throw Error('Supply --request=/path/to/approved-refund.json [--apply].');
const request=JSON.parse(readFileSync(file,'utf8')) as {actorUserId:string;userId:string;id:string;revision:string;reason:string};
try{
 const before=await query("SELECT id::text,status,credit_consumed,payload->'creditRestoration' AS restoration FROM application_reviews WHERE user_id=$1 AND id=$2",[request.userId,request.id]);
 console.log('Before',JSON.stringify(before));
 if(process.argv.includes('--apply'))console.log('Result',JSON.stringify(await restoreFailedPreparationCredit(request.actorUserId,request.userId,request,request.reason)));
 else console.log('Dry run. No credit or account data changed.');
 console.log('Free usage',JSON.stringify(await query('SELECT month_start,successful_applications FROM monthly_application_usage WHERE user_id=$1 ORDER BY month_start',[request.userId])));
}finally{await getPool().end();}
