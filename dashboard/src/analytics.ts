/**
 * First-party page analytics.
 *
 * A beacon when a page is shown and another when it is left, carrying how
 * long the page was actually in front of the visitor — time in a background
 * tab does not count. Nothing goes to a third party: the server turns the
 * connection's address into a place itself.
 *
 * Browser storage can be blocked or empty (a private window, cleared data),
 * so every access is guarded and the beacons still go out with ids that live
 * only as long as this page load.
 */

import { captureVisitSource, type VisitSource } from './visitor-source';

const VISITOR_KEY = 'owtomate_visitor';
const SESSION_KEY = 'owtomate_session_v2';
const SESSION_IDLE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 10_000;
const MAX_UNOBSERVED_MS = 2 * HEARTBEAT_MS;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Capture before sign-in and pixel code can replace the landing URL. Reuse it
// only for this document's first visit, never for an idle return hours later.
const entry:VisitSource = typeof window==='undefined' ? {source:'',medium:'',campaign:'',referrer:''}
  : captureVisitSource(window.location.search, document.referrer, window.location.hostname ?? '');
let entryConsumed = false;

function freshId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

const fallback = { visitor: freshId(), session: freshId() };
interface BrowserSession { id: string; lastActiveAt: number; acquisition?: VisitSource }
let fallbackSession: BrowserSession = { id: fallback.session, lastActiveAt: Date.now() };

function stored(storage: () => Storage, key: string, fallbackId: string): string {
  try {
    const store = storage();
    const current = store.getItem(key);
    if (current && ID_PATTERN.test(current)) return current;
    store.setItem(key, fallbackId);
    return fallbackId;
  } catch {
    return fallbackId;
  }
}

/** Tabs share a browser visit; returning after 30 minutes starts a new visit. */
function ids() {
  const now = Date.now();
  let session = fallbackSession;
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as BrowserSession | null;
    if (saved && typeof saved.id === 'string' && ID_PATTERN.test(saved.id)
      && Number.isFinite(saved.lastActiveAt)) {
      const acquisition=saved.acquisition;
      session={id:saved.id,lastActiveAt:saved.lastActiveAt,...(acquisition && ['source','medium','campaign','referrer'].every(key=>typeof acquisition[key as keyof VisitSource]==='string')?{acquisition}:{})};
    }
  } catch { /* Blocked storage keeps a session in this page's memory. */ }
  if (now - session.lastActiveAt >= SESSION_IDLE_MS || session.lastActiveAt > now) {
    session = { id: freshId(), lastActiveAt: now };
  }
  const acquisition = session.acquisition ?? (entryConsumed ? {source:'',medium:'',campaign:'',referrer:''} : entry);
  entryConsumed = true;
  fallbackSession = { id: session.id, lastActiveAt: now, acquisition };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(fallbackSession)); } catch { /* private storage */ }
  return { visitorId: stored(() => localStorage, VISITOR_KEY, fallback.visitor), sessionId: session.id, acquisition };
}

interface View {
  id: string | null;
  page: string;
  identity: string | null;
  visitorId: string;
  sessionId: string;
  payload: Record<string, unknown>;
  sequence: number;
  startedAt: number;
  failed: boolean;
  ignored?: boolean;
  visibleMs: number;
  visibleSince: number | null;
  ready: Promise<void>;
}

let current: View | null = null;
let listening = false;

/** Retry the same event ID so a lost response cannot create a second page view. */
function createView(view: View): void {
  view.failed = false;
  view.ready = fetch('/api/visit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(8_000) } : {}),
    body: JSON.stringify({ ...view.payload, startedAgoMs: Math.max(0,Math.round(performance.now()-view.startedAt)) }),
  }).then(response => {
    if (!response.ok) throw new Error('Visit recording unavailable');
    return response.json();
  }).then((body: { id?: unknown; ignored?: boolean }) => {
    if (typeof body?.id === 'string' && /^\d{1,18}$/.test(body.id)) {
      view.id = body.id;
      // Checkpoint short visits immediately, rather than waiting for a timer.
      report(view, current === view && view.visibleSince !== null && document.visibilityState !== 'hidden');
    } else if (body?.ignored === true) view.ignored=true;
    else throw new Error('Visit recording was not acknowledged');
  }).catch(() => { view.failed = true; });
}

function elapsed(view: View): number {
  if (view.visibleSince !== null) {
    const now = performance.now();
    // A suspended computer or frozen browser is not hours of observed viewing.
    view.visibleMs += Math.max(0, Math.min(MAX_UNOBSERVED_MS, now - view.visibleSince));
    view.visibleSince = now;
  }
  return Math.max(0, Math.round(view.visibleMs));
}

/** Sequence numbers keep delayed network requests from reviving a hidden tab. */
function report(view: View, visible: boolean): void {
  if(view.ignored)return;
  // The stable client event ID lets an exit checkpoint arrive before the
  // initial request/response, without inventing another page view.
  const body = JSON.stringify({ ...view.payload, ...(view.id ? {id:view.id} : {}),
    startedAgoMs:Math.max(0,Math.round(performance.now()-view.startedAt)),durationMs:elapsed(view),visible,sequence:++view.sequence });
  const url = visible ? '/api/visit/pulse' : '/api/visit/leave';
  try {
    if (navigator.sendBeacon?.(url, body)) return;
  } catch { /* Some browsers throw when the beacon queue is full. */ }
  void fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {});
}

function hide(view: View): void {
  view.visibleMs = elapsed(view);
  view.visibleSince = null;
  report(view, false);
}

function show(view: View): void {
  // Renew very long-lived tabs so duration caps and the server write window stay accurate.
  trackPage(view.page, view.identity);
  if (current !== view) return;
  if (view.visibleSince === null) view.visibleSince = performance.now();
  report(view, true);
}

function listen(): void {
  if (listening) return;
  listening = true;
  document.addEventListener('visibilitychange', () => {
    if (!current) return;
    if (document.visibilityState === 'hidden') hide(current);
    else show(current);
  });
  window.addEventListener('pagehide', () => { if (current) hide(current); });
  document.addEventListener('freeze', () => { if (current) hide(current); });
  // Back/forward cache restores do not remount React.
  window.addEventListener('pageshow', () => {
    if (current && document.visibilityState !== 'hidden') show(current);
  });
  window.setInterval(() => {
    if (current && current.visibleSince !== null && document.visibilityState !== 'hidden') {
      trackPage(current.page, current.identity);
      if (current) report(current, true);
    }
  }, HEARTBEAT_MS);
}

/** Authentication changes rotate the row too, so account identity stays accurate. */
export function trackPage(page: string, identity: string | null = null): void {
  if (navigator.webdriver) return;
  const { visitorId, sessionId, acquisition } = ids();
  if (current?.page === page && current.identity === identity && current.sessionId === sessionId
    && performance.now() - current.startedAt < 6 * 60 * 60 * 1000) {
    if (current.failed) createView(current);
    return;
  }
  listen();
  if (current) hide(current);
  const view: View = {
    id: null, page, identity, visitorId, sessionId, sequence: 0, startedAt: performance.now(), failed: false, visibleMs: 0,
    visibleSince: document.visibilityState === 'hidden' ? null : performance.now(),
    ready: Promise.resolve(),
    payload: { visitorId, sessionId, viewId: freshId(), page, visible: document.visibilityState !== 'hidden',
      referrer: acquisition.referrer,
      attribution: acquisition.source || acquisition.medium || acquisition.campaign ? acquisition : null,
      screen: `${window.screen.width}x${window.screen.height}`, language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  };
  createView(view);
  current = view;
}
