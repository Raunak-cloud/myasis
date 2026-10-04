import type { ApplicationAction } from '../../types.js';
import { siteDomain } from '../guards.js';

// Part of the agent loop, split from loop.ts by concern; loop.ts re-exports it.

/**
 * Turns a prepared sign-in or sign-up into a recorded account once the site
 * accepted it. Filling the credential proves nothing — a rejected password
 * or an address already registered looks the same at that moment — but the
 * application carrying on past it on the same site, or being submitted there,
 * does. Only confirmed accounts reach the candidate's list of site accounts.
 */
export function confirmAuthentication(
  actions: ApplicationAction[],
  progress: Array<{ site: string; at: string }>,
  submittedOn: string | null,
): void {
  for (const action of [...actions]) {
    if (action.kind !== 'authentication-prepared' || !action.email || action.purpose === 'reset_password') continue;
    const domain = siteDomain(`https://${action.site}`);
    const accepted = submittedOn === domain || progress.some((event) => event.site === domain && event.at > action.at);
    if (!accepted) continue;
    const kind = action.purpose === 'create_account' ? 'account-created' : 'signed-in';
    if (actions.some((known) => known.kind === kind && known.site === action.site)) continue;
    actions.push({
      kind,
      site: action.site,
      email: action.email,
      at: action.at,
      detail: kind === 'account-created'
        ? `Created an account on ${action.site} with ${action.email}.`
        : `Signed in to ${action.site} with ${action.email}.`,
    });
  }
}
