/** Stops new work while deletion drains existing work, and prevents stale
 * requests from restarting a deleted account in this process. IDs are never reused. */
const unavailable = new Set<string>();
const requests = new Map<string, Set<Promise<unknown>>>();

export const accountUnavailable = (userId: string): boolean => unavailable.has(userId);

/** Register before reading a request body or starting asynchronous account
 * writes. Deletion excludes new requests and waits for these to settle. */
export async function accountRequest<T>(userId: string, work: () => T | Promise<T>): Promise<T> {
  if (accountUnavailable(userId)) throw new AccountDeletionError('Account deletion is in progress.');
  let active = requests.get(userId);
  if (!active) { active = new Set(); requests.set(userId, active); }
  const task = Promise.resolve().then(work);
  active.add(task);
  try { return await task; }
  finally { active.delete(task); if (!active.size) requests.delete(userId); }
}

export async function waitForAccountRequests(userId: string): Promise<void> {
  while (requests.get(userId)?.size) await Promise.allSettled([...requests.get(userId)!]);
}

export class AccountDeletionError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

export function beginAccountDeletion(userId: string): (success: boolean) => void {
  if (!/^\d+$/.test(userId)) throw new AccountDeletionError('Invalid account.', 400);
  if (unavailable.has(userId)) throw new AccountDeletionError('Account deletion is already in progress.');
  unavailable.add(userId);
  return success => { if (!success) unavailable.delete(userId); };
}
