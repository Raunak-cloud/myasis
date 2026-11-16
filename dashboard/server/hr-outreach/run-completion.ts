import { query } from '../db/index.js';

export interface HrRunCompletion {
  browserReleased: boolean;
  descendantsReleased: boolean;
  resultsSaved: boolean;
  recorded: boolean;
}
interface CompletionDependencies {
  write: typeof query;
  wake: () => void | Promise<void>;
}

/** Caller has already released its post-processing account slot. A run ending,
 * or a row merely appearing in applications, cannot make outreach eligible. */
export async function completeHrRun(userId: string, runId: string | null, completion: HrRunCompletion,
  deps: CompletionDependencies = { write: query, wake: async () => { (await import('./worker.js')).wakeHrOutreach(); } }): Promise<boolean> {
  if (!runId || ![completion.browserReleased,completion.descendantsReleased,completion.resultsSaved,completion.recorded].every(value => value === true)) return false;
  const rows = await deps.write(`UPDATE run_starts SET hr_ready_at=now()
    WHERE id=$1 AND user_id=$2 AND finished_at IS NOT NULL AND hr_ready_at IS NULL RETURNING id`, [runId, userId]);
  if (!rows.length) return false;
  await deps.wake();
  return true;
}
