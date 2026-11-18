import type {PoolClient} from 'pg';
import {query} from './db/index.js';
import {isAdmin} from './admin-access.js';
import {confirmedGuestPreparation,confirmedNativePreparation,confirmedRegistrationPreparation} from '../../seek-bot/src/guest-applications.js';
import {isExternalApplicationUrl,jobBoardForUrl} from '../../seek-bot/src/job-board-url.js';
import type {PreparedApplication} from '../../seek-bot/src/application-review-types.js';

async function preparationOwner(userId:string,client?:PoolClient) {
 const sql=`SELECT u.email,EXISTS(SELECT 1 FROM new_user_trials t WHERE t.user_id=u.id) AS trial,
 EXISTS(SELECT 1 FROM application_credit_grants g JOIN billing_purchases p ON p.id=g.purchase_id AND p.user_id=g.user_id
 WHERE g.user_id=u.id AND p.plan_key IN ('essential-pass','job-search-pass') AND (g.expires_at IS NULL OR g.expires_at>now())) AS paid,
 EXISTS(SELECT 1 FROM application_credit_grants g JOIN billing_purchases p ON p.id=g.purchase_id AND p.user_id=g.user_id
 WHERE g.user_id=u.id AND p.plan_key='intensive-pass' AND (g.expires_at IS NULL OR g.expires_at>now())) AS intensive
 FROM users u WHERE u.id=$1`;
 const rows=client?(await client.query<{email:string;trial:boolean;paid:boolean;intensive:boolean}>(sql,[userId])).rows:await query<{email:string;trial:boolean;paid:boolean;intensive:boolean}>(sql,[userId]);
 return rows[0];
}

export async function paidGuestPlan(userId:string):Promise<boolean> {
 const owner=await preparationOwner(userId);
 return Boolean(owner?.paid&&!owner.intensive&&!isAdmin(owner.email));
}

/** Recheck plan and mailbox access for the exact stored preparation. */
export async function preparationAccessProblem(userId:string,applications:PreparedApplication[],client?:PoolClient):Promise<string|null> {
 const registration=applications.filter(application=>application.preparation?.access==='registration-confirmed');
 const needsGuestProof=applications.some(freePreparationNeedsCheck);
 if(!registration.length&&!needsGuestProof)return null;
 const owner=await preparationOwner(userId,client);
 if(registration.length){
  if(!owner||!owner.intensive&&!isAdmin(owner.email))return 'This application requires employer account creation through Get Owtomated.';
  if(!registration.every(confirmedRegistrationPreparation))return 'Employer registration access could not be confirmed for this application.';
  const {gmailAccess}=await import('./gmail-access.js');
  if(!(await gmailAccess(userId)).connected)return 'Connect the profile Gmail account in Settings before continuing this application.';
 }
 if(needsGuestProof&&owner&&(owner.trial||owner.paid)&&!owner.intensive&&!isAdmin(owner.email))
  return 'Guest application access has not been confirmed on this plan.';
 return null;
}
export function freePreparationNeedsCheck(application:PreparedApplication):boolean {
 const proof=application.preparation;
 if(proof?.version===3&&proof.access==='hosted-confirmed')
  return !confirmedNativePreparation(application)
    ||(application.job.platform??'seek')!==jobBoardForUrl(proof.checkedUrl);
 return (application.job.applicationMode==='external'||isExternalApplicationUrl(application.formUrl))&&!confirmedGuestPreparation(application);
}
