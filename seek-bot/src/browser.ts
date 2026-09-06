import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from './config.js';

const attachedBrowsers = new WeakMap<BrowserContext, Browser>();

/**
 * Opens the user's existing, already-logged-in Chrome profile.
 *
 * Deliberate choices:
 *  - persistent context, so we inherit the real session (no credential handling,
 *    no login automation, no stored passwords).
 *  - no stealth/fingerprint patching. If SEEK decides to challenge us we stop
 *    and hand control back rather than trying to look like someone else.
 */
export async function launchBrowser(): Promise<BrowserContext> {
  let ctx: BrowserContext;
  try {
    const cdpHost = process.env.CDP_HOST?.trim();
    const cdpPort = process.env.CDP_PORT?.trim();
    if (process.env.BROWSER_CONNECT_CDP === 'true') {
      if (!cdpHost || !cdpPort) {
        throw new Error('BROWSER_CONNECT_CDP=true requires both CDP_HOST and CDP_PORT.');
      }
      const endpoint = `http://${cdpHost}:${cdpPort}`;
      const browser = await chromium.connectOverCDP(endpoint, {
        isLocal: /^(?:127\.0\.0\.1|localhost|::1)$/.test(cdpHost),
      });
      const defaultContext = browser.contexts()[0];
      if (!defaultContext) {
        await browser.close();
        throw new Error(`Chrome at ${endpoint} has no default browser context.`);
      }
      attachedBrowsers.set(defaultContext, browser);
      defaultContext.setDefaultTimeout(30_000);
      return defaultContext;
    }

    /**
     * Three visibility modes, in increasing order of detectability:
     *
     *  visible    — normal window. You can watch it and solve a CAPTCHA yourself.
     *  background — a real, fully-rendered window parked off-screen. Identical
     *               fingerprint to visible; it just stays out of your way.
     *  headless   — no window at all. Fastest, but headless Chrome is what bot
     *               detection specifically fingerprints, and you cannot see or
     *               clear a challenge when one appears.
     *
     * `background` is the right default for "leave it running": you get the
     * full real-browser fingerprint without the window stealing focus.
     */
    const args: string[] = [];
    if (config.background && !config.headless) {
      args.push('--window-position=-32000,-32000', '--window-size=1440,960');
    }

    ctx = await chromium.launchPersistentContext(config.userDataDir, {
      executablePath: config.chromePath,
      headless: config.headless,
      // Playwright otherwise adds --no-sandbox by default. Keep Chrome's
      // process sandbox enabled so the launched browser does not show the
      // unsupported/security warning and renderer processes stay isolated.
      chromiumSandbox: true,
      viewport: { width: 1440, height: 960 },
      locale: 'en-AU',
      timezoneId: 'Australia/Sydney',
      args,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (/already in use|existing browser session/i.test(msg)) {
      throw new Error(
        `Chrome is already running with this profile, so Playwright cannot attach.\n` +
          `  Close every window of that Chrome instance, then re-run. To force it:\n` +
          `    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |\n` +
          `      Where-Object { $_.CommandLine -like '*${config.userDataDir.split('\\').pop()}*' } |\n` +
          `      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      );
    }
    throw err;
  }
  ctx.setDefaultTimeout(30_000);
  return ctx;
}

/**
 * Close a browser launched by this process, or only disconnect when the VPS
 * worker attached to the long-running Chrome service over CDP.
 */
export async function closeBrowser(ctx: BrowserContext): Promise<void> {
  const attached = attachedBrowsers.get(ctx);
  if (attached) {
    attachedBrowsers.delete(ctx);
    await attached.close();
    return;
  }
  await ctx.close();
}

export async function getPage(ctx: BrowserContext): Promise<Page> {
  const existing = ctx.pages().find((p) => !p.url().startsWith('chrome://'));
  return existing ?? (await ctx.newPage());
}

/** Confirms the SEEK session is still alive without touching credentials. */
export async function assertSignedIn(page: Page): Promise<void> {
  await page.goto(`${config.seekBase}/profile/me`, { waitUntil: 'domcontentloaded' });
  const url = page.url();
  if (/login|signin|oauth/i.test(url)) {
    throw new Error(
      'SEEK session is not signed in. Open the Chrome profile manually, sign in, then re-run. ' +
        'This tool never automates login.',
    );
  }
}

/**
 * Confirms the Indeed session is still alive, without touching credentials.
 *
 * Indeed's homepage hydrates `window.mosaic.initialData.isLoggedIn` client-side
 * regardless of sign-in state, so that flag — not just the URL — is the
 * authoritative signal; a signed-out visitor still gets HTTP 200 on `/`, just
 * with `isLoggedIn: false` and no personalised feed. A redirect to
 * secure.indeed.com is the other, coarser signal SEEK's check already uses.
 *
 * Also checked here: Cloudflare occasionally serves a Turnstile "Additional
 * Verification Required" interstitial on plain navigation to `/` itself, not
 * only on the `/viewjob` deep-link this tool already avoids — reproduced live
 * after sustained traffic in the same session. That page never loads Indeed's
 * own JS, so without this check it would silently read as `isLoggedIn: false`
 * and get reported as "not signed in", which is safe (the run still stops
 * and asks) but points the user at the wrong fix — this names the real cause.
 */
export async function assertIndeedSignedIn(page: Page): Promise<void> {
  await page.goto(`${config.indeedBase}/`, { waitUntil: 'domcontentloaded' });
  const url = page.url();
  if (/secure\.indeed\.com|\/account\/login/i.test(url)) {
    throw new Error(
      'Indeed session is not signed in. Open the Chrome profile manually, sign in to au.indeed.com, then re-run. ' +
        'This tool never automates login.',
    );
  }
  const challenged = await page
    .evaluate(
      () =>
        /additional verification required|checking your browser/i.test(document.title + ' ' + document.body.innerText.slice(0, 500)),
    )
    .catch(() => false);
  if (challenged) {
    throw new Error(
      'Indeed is showing a Cloudflare verification challenge instead of the site. Open the Chrome profile ' +
        'manually, solve the challenge (or wait for it to clear — it usually follows a burst of traffic), then re-run.',
    );
  }
  /**
   * `mosaic.initialData` is set by an inline script that runs after
   * domcontentloaded fires — on a cold, freshly-launched browser this lost
   * the race often enough in testing to read as `undefined` (and therefore
   * "not logged in") on an account that plainly was. Wait for the global to
   * actually exist before trusting its value.
   */
  await page
    .waitForFunction(() => (window as any).mosaic?.initialData !== undefined, { timeout: 10_000 })
    .catch(() => {});
  const loggedIn = await page
    .evaluate(() => Boolean((window as any).mosaic?.initialData?.isLoggedIn))
    .catch(() => false);
  if (!loggedIn) {
    throw new Error(
      'Indeed session is not signed in (mosaic.initialData.isLoggedIn is false). ' +
        'Open the Chrome profile manually, sign in to au.indeed.com, then re-run. This tool never automates login.',
    );
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Jittered human-ish pause. Uniform delays are both rude and a fingerprint. */
export function jitter(minMs: number, maxMs: number): Promise<void> {
  return sleep(Math.floor(minMs + Math.random() * (maxMs - minMs)));
}

export interface InteractivePageState {
  url: string;
  fingerprint: string;
}

/** Capture the URL, visible copy and controls that identify a wizard step. */
export async function captureInteractivePageState(page: Page): Promise<InteractivePageState> {
  return page
    .evaluate(() => {
      const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
      const region = document.querySelector('main, [role="main"], form') ?? document.body;
      const text = compact((region as HTMLElement | null)?.innerText ?? '').slice(0, 8_000);
      const controls = [...document.querySelectorAll('input, textarea, select, button, [role="button"]')]
        .slice(0, 100)
        .map((element) => {
          const input = element as HTMLInputElement;
          return [
            element.tagName,
            input.type ?? '',
            input.name ?? '',
            element.getAttribute('data-automation') ?? '',
            element.getAttribute('data-bot-ref') ?? '',
            element.getAttribute('aria-label') ?? '',
            compact((element as HTMLElement).innerText ?? '').slice(0, 120),
          ].join(':');
        })
        .join('|');
      return { url: location.href, fingerprint: `${text}\n${controls}` };
    })
    .catch(() => ({ url: page.url(), fingerprint: '' }));
}

/** Wait only as long as the site needs to move to its next wizard step. */
export async function waitForInteractivePageChange(
  page: Page,
  previous: InteractivePageState,
  timeout = 6_000,
): Promise<boolean> {
  return page
    .waitForFunction(
      (before) => {
        if (location.href !== before.url) return document.readyState !== 'loading';
        const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
        const region = document.querySelector('main, [role="main"], form') ?? document.body;
        const text = compact((region as HTMLElement | null)?.innerText ?? '').slice(0, 8_000);
        const controls = [...document.querySelectorAll('input, textarea, select, button, [role="button"]')]
          .slice(0, 100)
          .map((element) => {
            const input = element as HTMLInputElement;
            return [
              element.tagName,
              input.type ?? '',
              input.name ?? '',
              element.getAttribute('data-automation') ?? '',
              element.getAttribute('data-bot-ref') ?? '',
              element.getAttribute('aria-label') ?? '',
              compact((element as HTMLElement).innerText ?? '').slice(0, 120),
            ].join(':');
          })
          .join('|');
        return `${text}\n${controls}` !== before.fingerprint;
      },
      previous,
      { polling: 100, timeout },
    )
    .then(() => true)
    .catch(() => false);
}

/** Wait for usable controls instead of sleeping after navigation. */
export async function waitForInteractiveSurface(page: Page, timeout = 8_000): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        const controls = document.querySelectorAll('input, textarea, select, button, [role="button"]');
        const hasVisibleControl = [...controls].some((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
        });
        if (hasVisibleControl) return true;
        return /application (has been |was )?(submitted|sent)|successfully applied|thanks for applying/i.test(
          document.body.innerText,
        );
      },
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}
