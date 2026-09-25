import type { Frame, Page } from 'patchright';

/**
 * What kind of bot check is on the page, and the parameters a solver needs.
 *
 * Read from the DOM and the frame list only — nothing is injected, so looking
 * costs no detection surface. `host` is the frame the widget lives in: employer
 * forms are often embedded, and both the URL a solver is told and the place the
 * token goes belong to that frame, not the top page. `siteKey` is null when a
 * Turnstile renders without exposing one, which an API solver cannot work with.
 */
export type Challenge =
  | { kind: 'cloudflare-challenge' }
  | { kind: 'turnstile'; host: Frame; siteKey: string | null; action?: string; cData?: string; instance?: string }
  | { kind: 'recaptcha-v2'; host: Frame; siteKey: string; invisible: boolean; enterprise: boolean; apiDomain: string; dataS?: string; instance: string };

export interface Solver {
  name: string;
  supports(challenge: Challenge): boolean;
  /** True only when a solution was applied; the caller re-checks the page. */
  solve(page: Page, challenge: Challenge): Promise<boolean>;
}

const RECAPTCHA_ANCHOR = /^https:\/\/(www\.google\.com|www\.recaptcha\.net)\/recaptcha\/(api2|enterprise)\/anchor\?/;
const TURNSTILE_KEY = /\/(0x[\w-]{18,})(?:\/|$)/;
const TURNSTILE_WIDGET = '.cf-turnstile[data-sitekey], [data-sitekey^="0x"]';
/**
 * Cloudflare's full-page challenge, as opposed to a Turnstile embedded in a
 * real site page.
 *
 * `#challenge-stage` and `#challenge-form` are deliberately not sufficient on
 * their own. Indeed's branded "Additional Verification Required" page uses
 * those generic ids around an ordinary Turnstile widget. Treating that page as
 * a full interstitial makes the full-page solver reload it to intercept
 * `turnstile.render()`, but there is no full-page render call to intercept.
 */
export const INTERSTITIAL = '#challenge-running, form#challenge-form[action*="__cf_chl_"], script[src*="/cdn-cgi/challenge-platform/"][src*="/orchestrate/chl_page"]';

async function readTurnstile(host: Frame, frameUrl?: string): Promise<Challenge | null> {
  const alreadySolved = await host
    .evaluate(() => Boolean(document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')?.value))
    .catch(() => false);
  if (alreadySolved) return null;
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
    instance: frameUrl,
  };
}

export async function detectChallenge(page: Page): Promise<Challenge | null> {
  const interstitial = await page
    .evaluate((selector) =>
      /just a moment|performing security verification/i.test(document.title) || Boolean(document.querySelector(selector)), INTERSTITIAL)
    .catch(() => false);
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
      ? [{ host, siteKey, invisible: params.get('size') === 'invisible', enterprise: match[2] === 'enterprise', apiDomain: match[1], instance: frame.url() }]
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
  const alreadySolved = await anchor.host
    .evaluate((siteKey) => {
      for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe[src*="/recaptcha/"][src*="/anchor?"]')) {
        try {
          if (new URL(frame.src).searchParams.get('k') !== siteKey) continue;
        } catch {
          continue;
        }
        let root: HTMLElement | null = frame.parentElement;
        for (let depth = 0; root && depth < 6; depth += 1, root = root.parentElement) {
          const area = root.querySelector<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"]');
          if (area) return Boolean(area.value);
        }
      }
      return false;
    }, anchor.siteKey)
    .catch(() => false);
  if (alreadySolved) return null;
  const dataS = await anchor.host
    .evaluate(() => document.querySelector('.g-recaptcha[data-s]')?.getAttribute('data-s') ?? undefined)
    .catch(() => undefined);
  return { kind: 'recaptcha-v2', ...anchor, dataS };
}

/**
 * True for any visible CAPTCHA/security surface, including providers this
 * integration cannot yet parameterise. Unknown challenges are still kept away
 * from the browser agent: only CapMonster may interact with them, and a type it
 * cannot solve ends safely instead of becoming an AI click target.
 */
export async function hasCaptchaSurface(page: Page): Promise<boolean> {
  if (await detectChallenge(page)) return true;
  if (page.frames().some(frame =>
    /(?:hcaptcha\.com|arkoselabs\.com|funcaptcha\.com|geetest\.com|captcha-delivery\.com|awswaf\.com|imperva\.com)/i.test(frame.url()))) {
    return true;
  }
  return page
    .evaluate(() => {
      if (/captcha|additional verification required|verify (?:that )?you are human/i.test(document.title)) return true;
      const selector = '.h-captcha, [data-hcaptcha-widget-id], [class*="geetest" i], [id*="funcaptcha" i], [data-captcha-provider]';
      return [...document.querySelectorAll(selector)].some(element => {
        const box = (element as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(element as HTMLElement);
        return box.width > 80 && box.height > 30 && style.display !== 'none' && style.visibility !== 'hidden';
      });
    })
    .catch(() => false);
}
