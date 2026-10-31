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

const VISITOR_KEY = 'owtomate_visitor';
const SESSION_KEY = 'owtomate_session_v2';
const SESSION_IDLE_MS = 30 * 60 * 1000;
const ATTRIBUTION_KEY = 'owtomate_attribution';
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

interface Attribution {
  source: string;
  medium: string;
  campaign: string;
}

function cleanAttributionValue(value: string | null, max: number): string {
  return [...(value ?? '').trim()]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .slice(0, max);
}

/** Capture campaign data before auth or an in-app navigation can replace the landing URL. */
function landingAttribution(): Attribution | null {
  let current: Attribution | null = null;
  try {
    const params = new URLSearchParams(window.location.search);
    const source = cleanAttributionValue(params.get('utm_source'), 80)
      || (params.has('rdt_cid') ? 'reddit' : '');
    current = source ? {
      source: source.toLowerCase(),
      medium: cleanAttributionValue(params.get('utm_medium'), 80),
      campaign: cleanAttributionValue(params.get('utm_campaign'), 160),
    } : null;
    if (current) sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(current));
    const stored = current ?? JSON.parse(sessionStorage.getItem(ATTRIBUTION_KEY) ?? 'null');
    return stored && typeof stored.source === 'string' ? stored as Attribution : null;
  } catch {
    return current;
  }
}

const attribution = landingAttribution();

function freshId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

const fallback = { visitor: freshId(), session: freshId() };
interface BrowserSession { id: string; lastActiveAt: number }
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
      && Number.isFinite(saved.lastActiveAt)) session = saved;
  } catch { /* Blocked storage keeps a session in this page's memory. */ }
  if (now - session.lastActiveAt >= SESSION_IDLE_MS || session.lastActiveAt > now) {
    session = { id: freshId(), lastActiveAt: now };
  }
  fallbackSession = { id: session.id, lastActiveAt: now };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(fallbackSession)); } catch { /* private storage */ }
  return { visitorId: stored(() => localStorage, VISITOR_KEY, fallback.visitor), sessionId: session.id };
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
  visibleMs: number;
  visibleSince: number | null;
  ready: Promise<void>;
}

let current: View | null = null;
let listening = false;
let referrerReported = false;
let attributionReported = false;

/** Retry the same event ID so a lost response cannot create a second page view. */
function createView(view: View): void {
  view.failed = false;
  view.ready = fetch('/api/visit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(8_000) } : {}),
    body: JSON.stringify(view.payload),
  }).then(response => {
    if (!response.ok) throw new Error('Visit recording unavailable');
    return response.json();
  }).then((body: { id?: unknown; ignored?: boolean }) => {
    if (typeof body?.id === 'string' && /^\d{1,18}$/.test(body.id)) {
      view.id = body.id;
      referrerReported = true;
      attributionReported = true;
    } else if (body?.ignored !== true) throw new Error('Visit recording was not acknowledged');
  }).catch(() => { view.failed = true; });
}

function elapsed(view: View): number {
  return Math.max(0, Math.round(view.visibleMs + (view.visibleSince === null ? 0 : performance.now() - view.visibleSince)));
}

/** Sequence numbers keep delayed network requests from reviving a hidden tab. */
function report(view: View, visible: boolean): void {
  const message = { visitorId: view.visitorId, durationMs: elapsed(view), visible, sequence: ++view.sequence };
  const send = () => {
    if (!view.id) return;
    const body = JSON.stringify({ ...message, id: view.id });
    const url = visible ? '/api/visit/pulse' : '/api/visit/leave';
    try {
      if (navigator.sendBeacon?.(url, body)) return;
    } catch { /* Some browsers throw when the beacon queue is full. */ }
    void fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {});
  };
  if (view.id) send();
  else void view.ready.then(send);
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
  // Back/forward cache restores do not remount React.
  window.addEventListener('pageshow', () => {
    if (current && document.visibilityState !== 'hidden') show(current);
  });
  window.setInterval(() => {
    if (current && current.visibleSince !== null && document.visibilityState !== 'hidden') {
      trackPage(current.page, current.identity);
      if (current) report(current, true);
    }
  }, 20_000);
}

/** Authentication changes rotate the row too, so account identity stays accurate. */
export function trackPage(page: string, identity: string | null = null): void {
  if (navigator.webdriver) return;
  const { visitorId, sessionId } = ids();
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
      referrer: referrerReported ? '' : document.referrer,
      attribution: attributionReported ? null : attribution,
      screen: `${window.screen.width}x${window.screen.height}`, language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  };
  createView(view);
  current = view;
}
