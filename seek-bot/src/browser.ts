import { chromium, type Browser, type BrowserContext, type Page } from 'patchright';
import { config } from './config.js';
import { captchaEnabled, trySolveCaptcha } from './captcha.js';

const attachedBrowsers = new WeakMap<BrowserContext, Browser>();

/**
 * Makes `page.evaluate` callbacks work under `npm run dev`.
 *
 * tsx compiles with esbuild's `keepNames`, which wraps every *named* function
 * in a `__name(fn, "…")` helper. That helper is defined in the Node module
 * scope, but a page.evaluate callback is serialised and re-evaluated inside the
 * browser, where nothing defines it — so any evaluate containing a named inner
 * function throws "__name is not defined". It affects dom.ts's `extractFields`
 * and every apply flow that depends on it, on both engines.
 *
 * The compiled build (`tsc`, which is what production runs) emits no such call,
 * so the shim is only installed when this module itself is running from a
 * `.ts` source. Patchright injects init scripts by rewriting every HTML
 * response — Cloudflare's challenge page included — so an unneeded script is
 * pure detection surface. Cheaper and far less risky than rewriting those
 * evaluate bodies to avoid named functions.
 */
async function installEsbuildNameShim(ctx: BrowserContext): Promise<void> {
  if (!import.meta.url.endsWith('.ts')) return;
  await ctx
    .addInitScript(() => {
      const scope = globalThis as unknown as Record<string, unknown>;
      if (typeof scope.__name !== 'function') scope.__name = (fn: unknown) => fn;
    })
    .catch(() => {});
}

/**
 * Opens the user's existing, already-logged-in Chrome profile.
 *
 * Deliberate choices:
 *  - persistent context, so we inherit the real session (no credential handling,
 *    no login automation, no stored passwords).
 *  - optional Cloudflare click solving; unresolved challenges hand back to a human.
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
      await installEsbuildNameShim(defaultContext);
      return defaultContext;
    }

    /**
     * Three visibility modes, in increasing order of detectability:
     *
     *  visible    — normal window. You can watch it, but verification may still
     *               reject a browser launched under automation. Use the
     *               dashboard's manual-login handoff when that happens.
     *  background — a real, fully-rendered window parked off-screen. Identical
     *               fingerprint to visible; it just stays out of your way.
     *  headless   — no window at all. Fastest, but headless Chrome is what bot
     *               detection specifically fingerprints, and you cannot see or
     *               clear a challenge when one appears.
     *
     * `background` is the right default for "leave it running": you get the
     * full real-browser fingerprint without the window stealing focus.
     */
    /**
     * `--test-type` only suppresses Chrome's "unsupported command-line flag"
     * bar, which Patchright's anti-detection flag otherwise triggers. Command
     * line flags are invisible to pages, and navigator.webdriver stays false.
     */
    const args: string[] = ['--test-type'];
    if (captchaEnabled()) {
      const port = Number(process.env.CDP_PORT || '9222');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CDP_PORT');
      args.push(`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1');
    }
    if (!config.headless) {
      // Size the real window rather than emulating a viewport — see below.
      args.push('--window-size=1440,960');
      if (config.background) args.push('--window-position=-32000,-32000');
    }

    ctx = await chromium.launchPersistentContext(config.userDataDir, {
      executablePath: config.chromePath,
      headless: config.headless,
      // Patchright otherwise adds --no-sandbox by default. Keep Chrome's
      // process sandbox enabled so the launched browser does not show the
      // unsupported/security warning and renderer processes stay isolated.
      chromiumSandbox: true,
      /**
       * No viewport, locale or timezone emulation in headed mode.
       *
       * Each of those is a CDP override that makes the page disagree with the
       * real machine, and Cloudflare's challenge checks exactly those seams.
       * A browser it has flagged fails the "Verify you are human" checkbox
       * even when a person clicks it in the real window. Measured here:
       *  - viewport → Emulation.setDeviceMetricsOverride reported a 1440×960
       *    screen while the window was 1456×1094 at (10,10): a window larger
       *    than the screen it sits on.
       *  - locale → a user-agent override sending Accept-Language "en-AU" with
       *    a one-entry navigator.languages, which no real Chrome produces.
       *  - timezoneId → overriding a value the OS already has right.
       * Headless keeps a fixed viewport because there is no window to size.
       */
      viewport: config.headless ? { width: 1440, height: 960 } : null,
      args,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (/already in use|existing browser session/i.test(msg)) {
      throw new Error(
        `Chrome is already running with this profile, so Patchright cannot attach.\n` +
          `  Close every window of that Chrome instance, then re-run. To force it:\n` +
          `    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |\n` +
          `      Where-Object { $_.CommandLine -like '*${config.userDataDir.split('\\').pop()}*' } |\n` +
          `      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      );
    }
    throw err;
  }
  ctx.setDefaultTimeout(30_000);
  await installEsbuildNameShim(ctx);
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
  await waitForChallengeToClear(page);
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
  if (challenged && !(await trySolveCaptcha(page) && !(await hasVisibleCaptcha(page, false)))) {
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
    .waitForFunction(() => (window as any).mosaic?.initialData !== undefined, undefined, { timeout: 10_000 })
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

/**
 * Detects a CAPTCHA that is already blocking the current page without using a
 * model. Hidden reCAPTCHA integrations do not count: many normal pages include
 * those, so only a visible challenge or explicit blocking copy should stop a
 * run.
 */
export async function hasVisibleCaptcha(page: Page, attemptSolve = true): Promise<boolean> {
  const turnstileSolved = await page.locator('input[name="cf-turnstile-response"]').evaluateAll(
    elements => elements.some(element => Boolean((element as HTMLInputElement).value)),
  ).catch(() => false);
  if (attemptSolve && !turnstileSolved && await trySolveCaptcha(page)) return hasVisibleCaptcha(page, false);
  /**
   * Only a challenge someone must actually solve counts. Invisible reCAPTCHA
   * (Greenhouse, Dayforce, SmartRecruiters and most employer ATSes) renders a
   * small badge in a corner — a visible iframe, but nothing to solve — and
   * matching it read every one of those application forms as "a CAPTCHA is
   * blocking the page" at step one.
   */
  const visibleChallenge = await page
    .locator(
      'iframe[title*="reCAPTCHA" i]:visible, iframe[src*="recaptcha"]:visible, .g-recaptcha:visible, ' +
        'iframe[src*="captcha-delivery"]:visible, iframe[title*="Verification system" i]:visible' +
        (turnstileSolved ? '' : ', iframe[title*="Cloudflare" i]:visible, iframe[title*="challenge" i]:visible, iframe[src*="challenges.cloudflare.com"]:visible'),
    )
    .evaluateAll((elements) =>
      elements.filter((element) => {
        if (element.closest('.grecaptcha-badge')) return false;
        const src = element.getAttribute('src') ?? '';
        if (/size=invisible/.test(src)) return false;
        const box = element.getBoundingClientRect();
        // The invisible-reCAPTCHA badge is 256×60 wherever it is mounted.
        return !(Math.round(box.width) === 256 && Math.round(box.height) === 60);
      }).length,
    )
    .catch(() => 0);
  if (visibleChallenge > 0) return true;

  const copy = await page.locator('body').innerText().catch(() => '');
  return /i'?m not a robot|select all (images|squares)|verify you are human|performing security verification|additional verification required|checking your browser/i.test(
    copy,
  );
}

/**
 * Lets Cloudflare's automatic challenge finish before the page is read.
 *
 * A fresh session's first SEEK page usually gets the managed challenge. It
 * clears on its own in a few seconds, but navigating away while it is still
 * verifying restarts it on the next page, so a run used to spend its first
 * minute re-triggering the same check on every search page and reading each
 * one before SEEK's data had loaded. Resolves true once no challenge is
 * showing; false if it is still there after `timeoutMs`, which the caller's
 * existing captcha check then reports.
 */
export async function waitForChallengeToClear(page: Page, timeoutMs = 45_000): Promise<boolean> {
  const showing = () =>
    page
      .evaluate(
        () =>
          /just a moment|performing security verification/i.test(document.title) ||
          Boolean(document.querySelector('#challenge-running, #challenge-stage, iframe[src*="challenges.cloudflare.com"]')),
      )
      .catch(() => false);
  const deadline = Date.now() + timeoutMs;
  if (!(await showing())) return true;
  console.log('  ⏳ Cloudflare verification — waiting for it to clear');
  while (Date.now() < deadline) {
    await sleep(500);
    if (!(await showing())) {
      // The real page is now loading behind the cleared challenge.
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }
  }
  return false;
}

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
            element.getAttribute('data-field-id') ?? '',
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
              element.getAttribute('data-field-id') ?? '',
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
      undefined,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}
