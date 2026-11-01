import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { query } from './db/index.js';
import { isAdmin } from './admin-access.js';
import { loadRepairRelease, repairId, repairPilotEnabled } from './repair-release.js';

export async function repairRuntime(caseId: string, userId: string, app: string): Promise<string> {
  if (!repairId(caseId) || userId !== '1' || !repairPilotEnabled()) throw Error('Invalid or paused admin repair case.');
  const [row] = await query<{ email: string; base_sha: string; artifact_hash: string }>(
    `SELECT u.email,c.base_sha,c.artifact_hash FROM repair_pilot_cases c JOIN users u ON u.id=c.user_id
     WHERE c.id=$1 AND c.user_id=$2 AND c.status='retry_claimed' AND u.blocked_at IS NULL`,[caseId,userId]);
  if (!row || !isAdmin(row.email)) throw Error('Admin repair is not authorized.');
  const { stdout } = await promisify(execFile)('git',['rev-parse','HEAD'],{cwd:app,timeout:5000});
  return loadRepairRelease(caseId,{ownerId:userId,email:row.email,activeAdmin:true,expectedBaseSha:row.base_sha,
    currentBaseSha:stdout.trim(),expectedDistHash:row.artifact_hash,lockFile:resolve(app,'seek-bot/package-lock.json')});
}

/** Repaired workers receive application runtime configuration only. Their
 * immutable release contains no .env or database/billing/admin credentials. */
export function repairedWorkerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/DATABASE|STRIPE|GOOGLE_CLIENT|RESEND|SMTP|SESSION|COOKIE|SSH_|GITHUB|ADMIN_EMAILS|WEBSHARE/i.test(key)));
}

export async function liveRepairEnvironment(userId:string,app:string):Promise<Record<string,string>> {
  const off={OWTOMATE_LIVE_REPAIR:'',OWTOMATE_OWNER_ID:'',OWTOMATE_OWNER_EMAIL:'',OWTOMATE_DEPLOY_SHA:''};
  if(userId!=='1'||!repairPilotEnabled())return off;
  const [owner]=await query<{email:string}>('SELECT email FROM users WHERE id=1 AND blocked_at IS NULL');
  if(owner?.email!=='raunak.vision@gmail.com'||!isAdmin(owner.email))return off;
  const {stdout}=await promisify(execFile)('git',['rev-parse','HEAD'],{cwd:app,timeout:5000});
  if(!/^[a-f0-9]{40}$/.test(stdout.trim()))return off;
  return {OWTOMATE_LIVE_REPAIR:'1',OWTOMATE_OWNER_ID:'1',OWTOMATE_OWNER_EMAIL:owner.email,OWTOMATE_DEPLOY_SHA:stdout.trim()};
}
