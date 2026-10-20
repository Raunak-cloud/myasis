/** Stops new work while deletion drains existing work, and prevents stale
 * requests from restarting a deleted account in this process. IDs are never reused. */
const unavailable = new Set<string>();

export const accountUnavailable = (userId: string): boolean => unavailable.has(userId);

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
