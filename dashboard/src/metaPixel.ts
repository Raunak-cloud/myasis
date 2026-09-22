/** Meta Pixel browser tracking. Disabled when unconfigured or under automation. */
declare const __META_PIXEL_ID__: string;

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { callMethod?: (...args: unknown[]) => void; queue?: unknown[]; loaded?: boolean; version?: string };
    _fbq?: Window['fbq'];
  }
}

const pixelId = typeof __META_PIXEL_ID__ === 'string' ? __META_PIXEL_ID__.trim() : '';
let loaded = false;

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
    window.fbq?.('track', 'PageView');
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
  } catch (error) {
    console.warn(`[meta-pixel] could not report ${event}:`, error);
  }
}
