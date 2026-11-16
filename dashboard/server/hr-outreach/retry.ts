import { getPool } from '../db/index.js';
import { adminAddresses } from '../admin-access.js';

export interface HrRetryConnection { query(text:string,params?:any[]):Promise<{rows:any[]}>;release():void }
export interface HrRetryOptions {
  /** Optional exact selection makes an operator retry fail closed if rows changed. */
  expectedIds?:string[];
  connect?:()=>Promise<HrRetryConnection>;
}
const CONTACT_LOOKUP_REASONS=[
  'Public contact lookup is temporarily unavailable. It will retry later.',
  'No publicly listed hiring or recruitment email was found.',
];

/** Requeues existing, never-dispatched contact lookups only. It cannot create an
 * application, charge credits, resend mail or make an uncertain send retryable. */
export async function retryHrOutreachForRun(userId:string,runId:string,options:HrRetryOptions={}) {
  if(!/^[1-9]\d{0,18}$/.test(userId)||!/^[1-9]\d{0,18}$/.test(runId))throw Error('Choose a valid account and application run.');
  if(options.expectedIds&&(!options.expectedIds.length||options.expectedIds.some(id=>!/^[1-9]\d{0,18}$/.test(id))||new Set(options.expectedIds).size!==options.expectedIds.length))throw Error('Choose valid HR email records.');
  const client=await (options.connect??(()=>getPool().connect()))();
  try{
    await client.query('BEGIN');
    const authority=await client.query(`SELECT r.id FROM users u JOIN hr_outreach_preferences p ON p.user_id=u.id
      JOIN run_starts r ON r.user_id=u.id WHERE u.id=$1 AND r.id=$2 AND u.blocked_at IS NULL
      AND lower(trim(u.email))=ANY($3::text[]) AND p.enabled AND r.finished_at IS NOT NULL AND r.hr_ready_at IS NOT NULL
      FOR SHARE OF u,p,r`,[userId,runId,adminAddresses()]);
    if(!authority.rows.length)throw Error('This completed run is not available for an administrator HR retry.');
    const eligible=await client.query(`SELECT h.id::text,h.company_key,h.title,h.company,h.reason FROM hr_outreach h
      JOIN applications a ON a.id=h.application_id AND a.user_id=h.user_id
      JOIN hr_outreach_preferences p ON p.user_id=h.user_id
      WHERE h.user_id=$1 AND a.source_run_id=$2 AND p.enabled AND a.applied_at>=p.enabled_since
      AND a.submitted_by_myasis=true AND a.confirmation_status IS NULL AND a.outcome IS NULL
      AND h.status IN ('error','skipped') AND (h.reason=ANY($3::text[]) OR h.lookup_outcome IN ('no_contact','company_unverified','access_blocked','temporarily_unavailable','incomplete')
        OR h.reason LIKE 'Contact research did not finish. The earlier attempt did not record a specific cause.%')
      AND h.send_started_at IS NULL AND h.message_id IS NULL AND h.thread_id IS NULL AND h.sent_at IS NULL
      AND h.to_email IS NULL AND h.subject IS NULL AND h.body IS NULL
      AND (h.lease IS NULL OR h.lease_until<now()) ORDER BY h.id FOR UPDATE OF h`,[userId,runId,CONTACT_LOOKUP_REASONS]);
    const ids=eligible.rows.map(row=>String(row.id));
    if(options.expectedIds&&(ids.length!==options.expectedIds.length||options.expectedIds.some(id=>!ids.includes(id))))throw Error('The selected HR records changed. Nothing was retried.');
    if(ids.length){
      const companyKeys=[...new Set(eligible.rows.map(row=>row.company_key))];
      await client.query(`UPDATE hr_outreach SET status='queued',phase='queued',attempts=0,retry_allowed=true,available_at=now(),
        lease=NULL,lease_until=NULL,reason='Retrying public hiring contact lookup.',updated_at=now()
        WHERE user_id=$1 AND id=ANY($2::bigint[])`,[userId,ids]);
      // A deliberate lookup retry may bypass an old negative cache entry, but
      // must not discard a still-validated positive public contact.
      await client.query(`UPDATE hr_company_contacts SET next_validation_at=now()
        WHERE company_key=ANY($1::text[]) AND contact IS NULL`,[companyKeys]);
    }
    await client.query('COMMIT');
    return {runId,requeued:ids.length,items:eligible.rows.map(({id,title,company,reason})=>({id:String(id),title,company,previousReason:reason}))};
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
