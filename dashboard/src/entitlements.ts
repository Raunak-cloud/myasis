import { useEffect, useState } from 'react';

/**
 * What this account may do, as the server decided it.
 *
 * The server is the authority — every gate is enforced there — so this exists
 * only to keep the interface honest: an account that cannot start a run
 * should not be shown a start button that would fail.
 */
export interface Entitlements {
  tier: 'admin' | 'intensive' | 'standard';
  manualRuns: boolean;
  autoRunsPerDay: number;
  /** Automatic runs are switched off for this account. */
  autoApplyPaused: boolean;
  /** May switch automatic runs off and on (every account with a schedule). */
  canPauseAutoApply: boolean;
  autoRunsUsedToday: number;
  scheduledMinScore: number | null;
  scheduledJobsPerDay: number | null;
  /** Listings each run reviews. For an admin, non-null only where an operator set one. */
  evaluationsPerRun: number | null;
  /** Applications per run forced by an operator, whatever this account saves; null when none is set. */
  maxApplicationsPerRunOverride: number | null;
  fineTune: boolean;
  advancedFilters: boolean;
  rewriteText: boolean;
  runScopes: boolean;
  indeedApplications: boolean;
  humanizer: boolean;
  /** Suggestions from résumés left; null means no limit. */
  searchTermSuggestionsLeft: number | null;
  timeZone: string;
}

/**
 * Null while unknown, so a caller can wait rather than flashing the wrong
 * interface. Treating "not loaded yet" as "not entitled" would show every
 * account the restricted view for a moment on each load.
 */
export function useEntitlements(): Entitlements | null {
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  // The auto-apply switch hands back fresh entitlements; every hook on the page takes them.
  useEffect(() => {
    const update = (event: Event) => setEntitlements((event as CustomEvent<Entitlements>).detail);
    window.addEventListener('entitlements-changed', update);
    return () => window.removeEventListener('entitlements-changed', update);
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/entitlements')
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (!cancelled && value && typeof value.tier === 'string') setEntitlements(value as Entitlements);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return entitlements;
}
