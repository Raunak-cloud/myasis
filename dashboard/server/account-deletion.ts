import { readdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { PoolClient } from 'pg';
import { getPool } from './db/index.js';
import { USERS_DIR, userChromeDir } from './userdata.js';
import { runner } from './runner.js';
import { stopSignin } from './signin.js';
import { stopSigninChecks } from './seek-check.js';
import { releaseChromeProfile } from './chrome-profile.js';
import { forgetAccountRoute } from './route.js';
import { AccountDeletionError, beginAccountDeletion, waitForAccountRequests } from './account-lifecycle.js';

/** The caller owns the transaction. Files are removed before the account and
 * sessions, so a filesystem failure leaves a signed-in account able to retry. */
export async function purgeAccountData(client: Pick<PoolClient, 'query'>, userId: string, usersRoot = USERS_DIR, removeTree = rm): Promise<void> {
  if (!/^\d+$/.test(userId)) throw new AccountDeletionError('Invalid account.', 400);
  const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!user.rows.length) throw new AccountDeletionError('Account not found.', 404);
  const jobs = await client.query<{ status: string }>('SELECT status FROM marketing_jobs WHERE user_id = $1 FOR UPDATE', [userId]);
  if (jobs.rows.some(job => job.status === 'running')) {
    throw new AccountDeletionError('A website research task is finishing. Please try deleting your account again shortly.');
  }
  // Include earlier anonymous visits linked to this account's visitor IDs,
  // while preserving visits explicitly owned by another signed-in account.
  await client.query(`DELETE FROM page_views WHERE user_id = $1 OR
    (user_id IS NULL AND visitor_id IN (SELECT visitor_id FROM page_views WHERE user_id = $1))`, [userId]);
  const root = resolve(usersRoot);
  const directory = resolve(root, userId);
  if (dirname(directory) !== root) throw new Error('Invalid account directory.');
  await removeTree(directory, { recursive: true, force: true });
  const legacy = resolve(root, '..', 'deleted');
  const entries = await readdir(legacy).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) if (entry.startsWith(`${userId}-`)) {
    await removeTree(resolve(legacy, entry), { recursive: true, force: true });
  }
  // Cascades cover profile, sessions, files' metadata, answers, billing,
  // application history, mail preferences, costs and marketing records.
  await client.query('DELETE FROM users WHERE id = $1', [userId]);
}

/** Shared by self-service and admin deletion. No deletion of external accounts
 * or already-delivered employer applications is attempted. */
export async function deleteAccount(user: { id: string }): Promise<void> {
  const finish = beginAccountDeletion(user.id);
  let success = false;
  try {
    await runner.stopForAccountDeletion(user.id);
    await stopSignin(user.id);
    await stopSigninChecks(user.id);
    await waitForAccountRequests(user.id);
    if (!await releaseChromeProfile(userChromeDir(user.id))) {
      throw new AccountDeletionError('Your browser is still closing. Please try deleting your account again shortly.');
    }
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await purgeAccountData(client, user.id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    forgetAccountRoute(user.id);
    success = true;
  } finally { finish(success); }
}
