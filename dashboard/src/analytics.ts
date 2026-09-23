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
const SESSION_KEY = 'owtomate_session';
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
  try {
    const params = new URLSearchParams(window.location.search);
    const source = cleanAttributionValue(params.get('utm_source'), 80)
      || (params.has('rdt_cid') ? 'reddit' : '');
    const current = source ? {
      source: source.toLowerCase(),
      medium: cleanAttributionValue(params.get('utm_medium'), 80),
      campaign: cleanAttributionValue(params.get('utm_campaign'), 160),
    } : null;
    if (current) sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(current));
    const stored = current ?? JSON.parse(sessionStorage.getItem(ATTRIBUTION_KEY) ?? 'null');
    return stored && typeof stored.source === 'string' ? stored as Attribution : null;
  } catch {
    return null;
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

/** The same person across days, and this sitting of theirs. */
const ids = () => ({
  visitorId: stored(() => localStorage, VISITOR_KEY, fallback.visitor),
  sessionId: stored(() => sessionStorage, SESSION_KEY, fallback.session),
});

interface View {
  id: string | null;
  page: string;
  /** Time on the page while it was visible, so far. */
  visibleMs: number;
  /** When it last became visible, or null while hidden. */
  visibleSince: number | null;
  /** The server's id arrives after the first beacon; a leave before then waits for it. */
  ready: Promise<void>;
}

let current: View | null = null;
let listening = false;
/**
 * document.referrer is the page load's, not the tab's: it stays the same
 * through every in-app page change. Reported once, with the first page, and
 * the visit carries it from there — otherwise a Google search that brought
 * someone here counted once for every tab they opened.
 */
let referrerReported = false;
let attributionReported = false;

function elapsed(view: View): number {
  return Math.round(view.visibleMs + (view.visibleSince === null ? 0 : performance.now() - view.visibleSince));
}

/** Reports the time on the page so far. Sent as text so a beacon needs no preflight; the server parses it as JSON. */
function report(view: View, durationMs: number): void {
  if (!view.id) return;
  const body = JSON.stringify({ id: view.id, visitorId: ids().visitorId, durationMs });
  if (!navigator.sendBeacon?.('/api/visit/leave', body)) {
    void fetch('/api/visit/leave', { method: 'POST', body, keepalive: true }).catch(() => {});
  }
}

function leave(view: View): void {
  const duration = elapsed(view);
  view.visibleSince = null;
  view.visibleMs = duration;
  if (view.id) report(view, duration);
  else void view.ready.then(() => report(view, duration));
}

function listen(): void {
  if (listening) return;
  listening = true;
  document.addEventListener('visibilitychange', () => {
    if (!current) return;
    if (document.visibilityState === 'hidden') {
      // Phones often never fire pagehide; what is known now is reported now, and the server keeps the longest.
      current.visibleMs = elapsed(current);
      current.visibleSince = null;
      report(current, current.visibleMs);
    } else if (current.visibleSince === null) {
      current.visibleSince = performance.now();
    }
  });
  window.addEventListener('pagehide', () => {
    if (current) leave(current);
  });
}

/**
 * The visitor is now looking at `page`. Idempotent for the page already
 * shown; a change closes the previous page's row and opens a new one.
 */
export function trackPage(page: string): void {
  // A browser under automation says so; a scanner is not a visitor.
  if (navigator.webdriver) return;
  if (current?.page === page) return;
  listen();
  if (current) leave(current);

  const { visitorId, sessionId } = ids();
  const view: View = {
    id: null,
    page,
    visibleMs: 0,
    visibleSince: document.visibilityState === 'hidden' ? null : performance.now(),
    ready: Promise.resolve(),
  };
  view.ready = fetch('/api/visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({
      visitorId,
      sessionId,
      page,
      referrer: referrerReported ? '' : document.referrer,
      attribution: attributionReported ? null : attribution,
      screen: `${window.screen.width}x${window.screen.height}`,
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  })
    .then((response) => response.json())
    .then((body: { id?: unknown }) => {
      if (typeof body?.id === 'string') view.id = body.id;
    })
    .catch(() => {});
  referrerReported = true;
  attributionReported = true;
  current = view;
}
