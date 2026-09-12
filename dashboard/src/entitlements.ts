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
  manualRunsPerDay: number | null;
  manualRunsUsedToday: number;
  manualRunsLeftToday: number | null;
  autoRunsPerDay: number;
  autoRunsUsedToday: number;
  scheduledMinScore: number | null;
  fineTune: boolean;
  rewriteText: boolean;
  window: { startHour: number; endHour: number; timeZone: string };
}

/**
 * Null while unknown, so a caller can wait rather than flashing the wrong
 * interface. Treating "not loaded yet" as "not entitled" would show every
 * account the restricted view for a moment on each load.
 */
export function useEntitlements(): Entitlements | null {
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
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

/** "9am to 9pm" from the window the server reports. */
export function windowLabel(window: Entitlements['window']): string {
  const hour = (h: number) => (h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`);
  return `${hour(window.startHour)} to ${hour(window.endHour)}`;
}
