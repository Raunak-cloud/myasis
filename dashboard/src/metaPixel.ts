/** Meta Pixel browser tracking. Disabled when unconfigured or under automation. */
declare const __META_PIXEL_ID__: string;

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & {
      callMethod?: (...args: unknown[]) => void;
      push?: (...args: unknown[]) => void;
      queue?: unknown[];
      loaded?: boolean;
      version?: string;
    };
    _fbq?: Window['fbq'];
  }
}

const pixelId = typeof __META_PIXEL_ID__ === 'string' ? __META_PIXEL_ID__.trim() : '';
let loaded = false;

function fallbackBeacon(event: string, parameters: Record<string, unknown> = {}, eventId?: string): void {
  try {
    const query = new URLSearchParams({
      id: pixelId,
      ev: event,
      dl: location.href,
      noscript: '1',
    });
    if (eventId) query.set('eid', eventId);
    for (const [key, value] of Object.entries(parameters)) query.set(`cd[${key}]`, String(value));
    const image = new Image(1, 1);
    image.alt = '';
    image.hidden = true;
    image.onload = image.onerror = () => image.remove();
    image.src = `https://www.facebook.com/tr/?${query.toString()}`;
    (document.body ?? document.documentElement).appendChild(image);
  } catch {
    // Advertising measurement must never affect the product.
  }
}

function scheduleBeacon(event: string, parameters: Record<string, unknown> = {}, eventId?: string): void {
  window.setTimeout(() => fallbackBeacon(event, parameters, eventId), 750);
}

function enabled(): boolean {
  return Boolean(pixelId) && !(typeof navigator !== 'undefined' && navigator.webdriver);
}

export function initMetaPixel(): void {
  if (!enabled() || loaded) return;
  loaded = true;
  try {
    if (!window.fbq) {
      const fbq = function (...args: unknown[]) {
        if (fbq.callMethod) fbq.callMethod(...args);
        else fbq.queue?.push(args);
      } as NonNullable<Window['fbq']>;
      // Meta's loader expects the stub to expose itself as `push`, exactly as
      // in the official base-code snippet, before fbevents.js replaces it.
      fbq.push = fbq;
      fbq.queue = [];
      fbq.loaded = true;
      fbq.version = '2.0';
      window.fbq = fbq;
      window._fbq = fbq;
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://connect.facebook.net/en_US/fbevents.js';
      document.head.appendChild(script);
    }
    window.fbq?.('init', pixelId);
    const pageViewId = typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `page:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    window.fbq?.('track', 'PageView', {}, { eventID: pageViewId });
    // Send the standard image beacon too. Meta deduplicates it against the
    // browser event by event ID, so a blocked library loses no measurement.
    scheduleBeacon('PageView', {}, pageViewId);
  } catch (error) {
    console.warn('[meta-pixel] could not initialise:', error);
  }
}

export function trackMetaEvent(
  event: 'CompleteRegistration' | 'Purchase',
  parameters: Record<string, unknown> = {},
  eventId?: string,
): void {
  if (!enabled()) return;
  if (!loaded) initMetaPixel();
  try {
    if (eventId) window.fbq?.('track', event, parameters, { eventID: eventId });
    else window.fbq?.('track', event, parameters);
    scheduleBeacon(event, parameters, eventId);
  } catch (error) {
    console.warn(`[meta-pixel] could not report ${event}:`, error);
  }
}
