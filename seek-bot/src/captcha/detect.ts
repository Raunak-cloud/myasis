import type { Frame, Page } from 'patchright';

/**
 * What kind of bot check is on the page, and the parameters a solver needs.
 *
 * Read from the DOM and the frame list only — nothing is injected, so looking
 * costs no detection surface. `host` is the frame the widget lives in: employer
 * forms are often embedded, and both the URL a solver is told and the place the
 * token goes belong to that frame, not the top page. `siteKey` is null when a
 * Turnstile renders without exposing one: the click solver does not need it,
 * an API solver does.
 */
export type Challenge =
  | { kind: 'cloudflare-challenge' }
  | { kind: 'turnstile'; host: Frame; siteKey: string | null; action?: string; cData?: string }
  | { kind: 'recaptcha-v2'; host: Frame; siteKey: string; invisible: boolean; enterprise: boolean; apiDomain: string; dataS?: string };

export interface Solver {
  name: string;
  supports(challenge: Challenge): boolean;
  /** True only when a solution was applied; the caller re-checks the page. */
  solve(page: Page, challenge: Challenge): Promise<boolean>;
}

const RECAPTCHA_ANCHOR = /^https:\/\/(www\.google\.com|www\.recaptcha\.net)\/recaptcha\/(api2|enterprise)\/anchor\?/;
const TURNSTILE_KEY = /\/(0x[\w-]{18,})(?:\/|$)/;
const TURNSTILE_WIDGET = '.cf-turnstile[data-sitekey], [data-sitekey^="0x"]';
/** Cloudflare's full-page challenge, as opposed to a Turnstile inside a real page. */
export const INTERSTITIAL = '#challenge-running, #challenge-stage, #challenge-form, script[src*="/cdn-cgi/challenge-platform/"][src*="/orchestrate/chl_page"]';

async function readTurnstile(host: Frame, frameUrl?: string): Promise<Challenge | null> {
  const widget = await host
    .evaluate((selector) => {
      const element = document.querySelector(selector);
      return element
        ? {
            siteKey: element.getAttribute('data-sitekey'),
            action: element.getAttribute('data-action') ?? undefined,
            cData: element.getAttribute('data-cdata') ?? undefined,
          }
        : null;
    }, TURNSTILE_WIDGET)
    .catch(() => null);
  if (!widget && !frameUrl) return null;
  return {
    kind: 'turnstile',
    host,
    siteKey: widget?.siteKey ?? frameUrl?.match(TURNSTILE_KEY)?.[1] ?? null,
    action: widget?.action,
    cData: widget?.cData,
  };
}

export async function detectChallenge(page: Page): Promise<Challenge | null> {
  const interstitial = await page.locator(INTERSTITIAL).count().catch(() => 0);
  if (interstitial) return { kind: 'cloudflare-challenge' };

  const frames = page.frames();
  const cloudflare = frames.find(frame => frame.url().startsWith('https://challenges.cloudflare.com/'));
  const turnstile = await readTurnstile(cloudflare?.parentFrame() ?? page.mainFrame(), cloudflare?.url());
  if (turnstile) return turnstile;

  const anchors = frames.flatMap((frame) => {
    const match = RECAPTCHA_ANCHOR.exec(frame.url());
    const host = frame.parentFrame();
    if (!match || !host) return [];
    const params = new URL(frame.url()).searchParams;
    const siteKey = params.get('k');
    return siteKey
      ? [{ host, siteKey, invisible: params.get('size') === 'invisible', enterprise: match[2] === 'enterprise', apiDomain: match[1] }]
      : [];
  });
  /**
   * A checkbox widget is a wall on sight. An invisible one is only a wall once
   * its image challenge has opened — and that opens after the form's own
   * submit, so completing it finishes a submit the guards already allowed.
   */
  let anchor = anchors.find(candidate => !candidate.invisible);
  for (const candidate of anchor ? [] : anchors) {
    const open = await candidate.host
      .evaluate(() => {
        for (const frame of document.querySelectorAll('iframe[src*="/recaptcha/"][src*="/bframe"]')) {
          const box = frame.getBoundingClientRect();
          if (box.width > 0 && box.height > 0 && box.top > -1000 && getComputedStyle(frame).visibility !== 'hidden') return true;
        }
        return false;
      })
      .catch(() => false);
    if (open) {
      anchor = candidate;
      break;
    }
  }
  if (!anchor) return null;
  const dataS = await anchor.host
    .evaluate(() => document.querySelector('.g-recaptcha[data-s]')?.getAttribute('data-s') ?? undefined)
    .catch(() => undefined);
  return { kind: 'recaptcha-v2', ...anchor, dataS };
}
