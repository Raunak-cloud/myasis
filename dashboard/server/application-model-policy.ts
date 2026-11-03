import type { ApplicationModel } from '../../seek-bot/src/application-model-catalog.js';

export function applicationModelSettingsError(updates: Record<string, unknown>, admin: boolean): { status: number; error: string } | null {
  if (updates.APPLICATION_AI_MODEL === undefined) return null;
  if (!admin) return { status: 403, error: 'Model routing is managed by the server.' };
  return updates.APPLICATION_AI_MODEL === 'minimax' ? null
    : { status: 400, error: 'Job review uses Magnus; applications and supervision use MiniMax M3.1.' };
}
/** All customer starts, including stale saved/admin settings, use the same architecture.
 * Explicit model comparisons remain confined to the isolated admin form lab. */
export function applicationModelForAccount(_value: unknown, _admin: boolean): ApplicationModel {
  return 'minimax';
}
