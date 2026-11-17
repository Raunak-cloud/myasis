import type {PoolClient} from 'pg';
import {query} from './db/index.js';
import {isAdmin} from './admin-access.js';
import {confirmedGuestPreparation,confirmedNativePreparation} from '../../seek-bot/src/guest-applications.js';
import {isExternalApplicationUrl} from '../../seek-bot/src/job-board-url.js';
import type {PreparedApplication} from '../../seek-bot/src/application-review-types.js';

/** Applies the no-account employer offer. Active paid plans and legacy accounts
 * outside that offer retain their existing preparation policy. */
export async function freeGuestPreparationRequired(userId:string,client?:PoolClient):Promise<boolean> {
 const sql=`SELECT u.email,EXISTS(SELECT 1 FROM new_user_trials t WHERE t.user_id=u.id) AS trial,
 EXISTS(SELECT 1 FROM application_credit_grants g JOIN billing_purchases p ON p.id=g.purchase_id AND p.user_id=g.user_id
 WHERE g.user_id=u.id AND p.plan_key IN ('essential-pass','job-search-pass','intensive-pass') AND (g.expires_at IS NULL OR g.expires_at>now())) AS paid
 FROM users u WHERE u.id=$1`;
 const rows=client?(await client.query<{email:string;trial:boolean;paid:boolean}>(sql,[userId])).rows:await query<{email:string;trial:boolean;paid:boolean}>(sql,[userId]);
 const owner=rows[0];return Boolean(owner?.trial&&!owner.paid&&!isAdmin(owner.email));
}
export function freePreparationNeedsCheck(application:PreparedApplication):boolean {
 if(application.job.platform==='jora'&&application.preparation?.version===3&&application.preparation.access==='hosted-confirmed')return true;
 return (application.job.applicationMode==='external'||isExternalApplicationUrl(application.formUrl))&&!confirmedGuestPreparation(application)&&!confirmedNativePreparation(application);
}
