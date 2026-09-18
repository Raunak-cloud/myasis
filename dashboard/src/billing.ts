import { useEffect, useState } from 'react';

/**
 * The account's plan and application allowance, as the server counts them.
 *
 * Shown in the menu foot on every screen, so an account never has to open
 * the pricing page to learn how many applications it has left. The server
 * is the authority; this only keeps the number on screen current.
 */
export interface BillingStatus {
  configured: boolean;
  free: { allowance: number; used: number; remaining: number };
  paid: {
    remaining: number;
    expiresAt: string | null;
    hasActivePass: boolean;
    hasActiveJobSearchPass: boolean;
    hasActiveIntensivePass: boolean;
  };
  totalRemaining: number;
}

/** Fired by anything that changes the allowance — a purchase confirmed, a pass granted — so every copy refreshes. */
export const BILLING_CHANGED = 'billing-changed';

export function useBillingStatus(): BillingStatus | null {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/billing/status')
        .then((response) => (response.ok ? response.json() : null))
        .then((value) => {
          if (!cancelled && value && typeof value.totalRemaining === 'number') setStatus(value as BillingStatus);
        })
        .catch(() => {});
    };
    load();
    // A run submits applications while this sits in the corner; coming back to the tab is when the number is looked at.
    const onFocus = () => document.visibilityState === 'visible' && load();
    window.addEventListener(BILLING_CHANGED, load);
    window.addEventListener('entitlements-changed', load);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener(BILLING_CHANGED, load);
      window.removeEventListener('entitlements-changed', load);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);
  return status;
}

/** The plan's name as the pricing page calls it. */
export function planName(status: BillingStatus, admin: boolean): string {
  if (admin) return 'Admin';
  if (status.paid.hasActiveIntensivePass) return 'Intensive Pass';
  if (status.paid.hasActiveJobSearchPass) return 'Job Search Pass';
  if (status.paid.hasActivePass) return 'Free plan + top-up';
  return 'Free plan';
}

export function shortDate(value: string): string {
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' }).format(new Date(value));
}
