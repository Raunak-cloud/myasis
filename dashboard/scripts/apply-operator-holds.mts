import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPool, query } from '../server/db/index.js';
import { holdApplicationReview, applicationsForConfirmation, ApplicationReviewError, reviewSelection } from '../server/application-reviews.js';
import { isAdmin } from '../server/admin-access.js';

// Root explicitly selects a JSON data file. This CLI accepts no commands,
// candidate answer replacements, status changes or release instructions.
const verify = process.argv[2] === '--verify';
const filename = process.argv[verify ? 3 : 2];
if (!filename || process.argv.length !== (verify ? 4 : 3)) throw Error('Usage: apply-operator-holds.mts [--verify] <explicit-plan.json>');
const plan = JSON.parse(readFileSync(resolve(filename), 'utf8'));
if (!plan || plan.version !== 1 || !Array.isArray(plan.holds) || !plan.holds.length || plan.holds.length > 100
  || Object.keys(plan).some(key => !['version', 'holds'].includes(key))) throw Error('Invalid operator hold plan.');
for (const item of plan.holds) {
  if (!item || Object.keys(item).some(key => !['actorUserId', 'userId', 'draftId', 'revision', 'sourceRunId', 'reason'].includes(key))
    || typeof item.actorUserId !== 'string' || typeof item.userId !== 'string' || !/^\d+$/.test(item.actorUserId) || !/^\d+$/.test(item.userId)
    || (item.sourceRunId !== undefined && (typeof item.sourceRunId !== 'string' || !/^\d+$/.test(item.sourceRunId)))
    || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 2000) throw Error('Invalid exact operator hold entry.');
  reviewSelection([{ id: item.draftId, revision: item.revision }]);
}
try {
  for (const item of plan.holds) {
    const selection = { id: item.draftId, revision: item.revision };
    if (!verify) {
      const held = await holdApplicationReview(item.actorUserId, item.userId, selection, item.reason, item.sourceRunId);
      console.log(`Operator hold ${held.id} active for owner ${item.userId}, draft ${item.draftId}.`);
    } else {
      const actor = await query<{ email: string }>('SELECT email FROM users WHERE id=$1 AND blocked_at IS NULL', [item.actorUserId]);
      if (!isAdmin(actor[0]?.email)) throw Error('The operator is no longer an active administrator.');
      const held = await query(`SELECT h.id FROM application_review_operator_holds h JOIN users u ON u.id=h.user_id
        WHERE h.user_id=$1 AND h.draft_id=$2 AND h.revision=$3 AND h.actor_user_id=$4 AND h.reason=$5
          AND h.source_run_id IS NOT DISTINCT FROM $6::bigint AND h.released_at IS NULL AND u.blocked_at IS NULL`,
      [item.userId, item.draftId, item.revision, item.actorUserId, item.reason.trim(), item.sourceRunId ?? null]);
      if (held.length !== 1) throw Error('The exact operator hold is missing or no longer active.');
      let rejected = false;
      try { await applicationsForConfirmation(item.userId, [selection]); }
      catch (error) { if (!(error instanceof ApplicationReviewError)) throw error; rejected = true; }
      if (!rejected) throw Error('The held draft was unexpectedly confirmable.');
      console.log(`Operator hold verified; owner ${item.userId}, draft ${item.draftId} cannot be confirmed.`);
    }
  }
} finally { await getPool().end(); }
