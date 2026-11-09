import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from './db/index.js';
import { COMPLETED_REVIEWS_FILE, readCompletedReviews, validCompletedReview } from '../../seek-bot/src/completed-reviews.js';

/** Import only this owner's journal. Replays cannot replace their first completed decision. */
export async function syncCompletedJobReviews(userId: string, dir: string): Promise<void> {
  const rows = readCompletedReviews(resolve(dir, COMPLETED_REVIEWS_FILE));
  for (let offset=0;offset<rows.length;offset+=200) {
    await query(`INSERT INTO completed_job_reviews(user_id,review_key,payload,reviewed_at)
      SELECT $1,row->>'key',row,(row->>'reviewedAt')::timestamptz
      FROM jsonb_array_elements($2::jsonb) row
      ON CONFLICT(user_id,review_key) DO NOTHING`,[userId,JSON.stringify(rows.slice(offset,offset+200))]);
  }
}

export async function exportCompletedJobReviews(userId: string, dir: string): Promise<void> {
  // A stopped/crashed run may have finished reviews after its last DB sync.
  await syncCompletedJobReviews(userId,dir);
  const rows=await query<{payload:unknown}>('SELECT payload FROM completed_job_reviews WHERE user_id=$1 ORDER BY reviewed_at,review_key',[userId]);
  const path=resolve(dir,COMPLETED_REVIEWS_FILE),temp=`${path}.${randomUUID()}.tmp`;
  const text=rows.map(row=>row.payload).filter(validCompletedReview).map(row=>JSON.stringify(row)).join('\n');
  // No daily/retention expiry, no model/profile/content invalidation, and no partial exports.
  try{writeFileSync(temp,text ? text+'\n' : '',{flag:'wx',mode:0o600});renameSync(temp,path);}
  finally{if(existsSync(temp))unlinkSync(temp);}
}
