import { useSyncExternalStore } from 'react';
import type { BillingStatus } from './billing';
import { BILLING_CHANGED } from './billing';
import type { Entitlements } from './entitlements';

/**
 * Previewing the dashboard as a customer in a given state.
 *
 * An admin has no limits, so their own dashboard never shows what running out
 * looks like. A preview swaps the two things every screen reads — the plan
 * status and the entitlements — for ones the server worked out for an invented
 * account (server/simulate.ts), and the whole app follows: the admin tab
 * disappears, limits apply, the menu counts down.
 *
 * It is done at `fetch` because that is the one seam every component shares.
 * While a preview is on:
 *  - the status and entitlement reads return the scenario's;
 *  - nothing that changes anything leaves the browser. The admin is still
 *    signed in as themselves, so a real "start" would start a real, unlimited
 *    run. Starting a run gets the answer the server would give that customer;
 *    every other write is answered locally and not sent.
 * It lives in memory only: a reload ends it.
 */

type Verdict = { status: number; error: string } | null;

export interface Simulation {
  key: string;
  group: string;
  label: string;
  description: string;
  billing: BillingStatus;
  entitlements: Entitlements;
  manualStart: Verdict;
  scheduledStart: Verdict;
}

let active: Simulation | null = null;
const listeners = new Set<() => void>();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function answer(simulation: Simulation, path: string, method: string): Response | null {
  if (method === 'GET') {
    if (path === '/api/billing/status') return json(simulation.billing);
    if (path === '/api/entitlements') return json(simulation.entitlements);
    return null; // every other read is the admin's own data, shown as it is
  }
  // The run review saves settings before it starts; let it believe it did so the start is reached.
  if (path === '/api/settings') return json({ ok: true });
  if (path === '/api/run') {
    const verdict = simulation.manualStart;
    return verdict
      ? json({ ok: false, error: verdict.error }, verdict.status)
      : json({ ok: false, error: 'Preview: a real account would start its run here. Nothing was started.' }, 409);
  }
  return json({ ok: false, error: 'Preview: nothing was sent. Exit the preview to make changes.' }, 409);
}

// The landing page is also rendered under Node, where there is no window to patch.
const realFetch = typeof window === 'undefined' ? fetch : window.fetch.bind(window);
if (typeof window !== 'undefined') window.fetch = (input, init) => {
  if (active) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin === window.location.origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/admin/')) {
      const simulated = answer(active, url.pathname, method);
      if (simulated) return Promise.resolve(simulated);
    }
  }
  return realFetch(input, init);
};

async function announce(): Promise<void> {
  listeners.forEach((listener) => listener());
  // Both hooks refresh on these; with a preview on, the refresh reads the scenario.
  const entitlements = await fetch('/api/entitlements').then((response) => response.json()).catch(() => null);
  if (entitlements?.tier) window.dispatchEvent(new CustomEvent('entitlements-changed', { detail: entitlements }));
  window.dispatchEvent(new Event(BILLING_CHANGED));
}

export function startSimulation(simulation: Simulation): void {
  active = simulation;
  void announce();
}

export function stopSimulation(): void {
  active = null;
  void announce();
}

export function useSimulation(): Simulation | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => active,
  );
}
