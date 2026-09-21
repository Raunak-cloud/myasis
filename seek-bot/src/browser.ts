import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'patchright';
import { config } from './config.js';
import { judgePage } from './blocker.js';
import { signInAutomatically } from './signin-agent.js';
import { watchCaptchas } from './captcha.js';

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
 *  - optional CAPTCHA solving through CapMonster; unresolved challenges hand back to a human.
 */
export async function launchBrowser(): Promise<BrowserContext> {
  let ctx: BrowserContext;
  try {
    // Opt-in local capture for real-run demos. Keep raw applicant footage in
    // private storage; only an edited/redacted export belongs in public assets.
    const recordingDir = process.env.RUN_VIDEO_DIR?.trim();
    if (recordingDir) mkdirSync(resolve(recordingDir), { recursive: true });
    const cdpHost = process.env.CDP_HOST?.trim();
    const cdpPort = process.env.CDP_PORT?.trim();
    if (process.env.BROWSER_CONNECT_CDP === 'true') {
      if (recordingDir) throw new Error('RUN_VIDEO_DIR requires a newly launched browser; recording an existing CDP context is not supported.');
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
      watchCaptchas(defaultContext);
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
    // The dashboard's authenticated, view-only stream reads frames through
    // this localhost port. Each concurrent account receives a different port.
    const port = Number(process.env.CDP_PORT || '9222');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CDP_PORT');
    args.push(`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1');
    /**
     * Cap the HTTP cache per profile.
     *
     * Chrome sizes its cache from free disk, so one account's profile grew to
     * 1.1GB — 900MB of it cached page assets — which makes disk, not the
     * database, the first thing that runs out as accounts are added. SEEK's
     * assets are a few MB; 100MB is more than a run ever revisits. Launch
     * flags are invisible to pages, so this is not a fingerprint. The V8 code
     * cache has no flag and is cleared by deploy/maintenance.sh instead.
     */
    args.push('--disk-cache-size=104857600');
    /**
     * The dashboard's route switch, for an account with a home connection: a
     * loopback SOCKS server that sends this browser out through the person's
     * home address while their machine is on and from this server otherwise.
     * The second flag keeps WebRTC from announcing this server's address from
     * behind the home one. Both are launch flags, which pages cannot see.
     */
    const proxyServer = process.env.BROWSER_PROXY_SERVER?.trim();
    if (proxyServer) args.push(`--proxy-server=${proxyServer}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
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
      ...(recordingDir ? { recordVideo: { dir: resolve(recordingDir), size: { width: 1440, height: 960 } } } : {}),
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
  watchCaptchas(ctx);
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

/**
 * Records what this run observed about the SEEK session.
 *
 * A run is the only thing that ever finds out for certain, so it is the only
 * honest source for the dashboard's "SEEK account" prompt, which otherwise
 * has to nag every account forever, including the ones already signed in.
 * The dashboard reads this same file; see `dashboard/server/seek-state.ts`,
 * which must keep the shape below in step.
 */
/**
 * Makes `page` the tab in front, and tells the dashboard it is the one being worked in.
 *
 * The dashboard's live view has to show the tab the run is acting on, and from
 * outside there is no way to know which that is: a run that has visited a few
 * employer sites has several tabs open, and "the newest" was measured showing a
 * tab left over from an earlier application for a whole minute while the form
 * being filled was somewhere else. So the run says so itself, in a file beside
 * its other state, every time the tab it is working in changes.
 *
 * Bringing it to the front is for the site as much as for the viewer: Chrome
 * throttles timers and rendering in a background tab, and forms are slower and
 * flakier there than they are for a person, who only ever types in the tab they
 * are looking at.
 */
export async function workingIn(page: Page): Promise<void> {
  try {
    await page.bringToFront();
    const session = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      writeFileSync(resolve(config.dataDir, 'live-target.json'), JSON.stringify({ targetId: targetInfo.targetId, at: new Date().toISOString() }));
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    // A picture for the person watching is never worth failing an application over.
  }
}

export type SigninSite = 'seek' | 'indeed';

/**
 * What is remembered about a board between checks: whether it was signed in,
 * as whom, and whether the person signed it out themselves. That last one is
 * what keeps the automatic sign-in from undoing a deliberate sign-out — it
 * stays until the person signs in again.
 */
interface SiteSession {
  signedIn: boolean;
  account?: string | null;
  signedOutByPerson?: boolean;
  /** Signing back in automatically was tried and did not work: the point at which only the person can fix it. */
  autoSigninFailed?: boolean;
}

function readSiteSession(site: SigninSite): SiteSession | null {
  try {
    return JSON.parse(readFileSync(resolve(config.dataDir, `${site}-session.json`), 'utf8')) as SiteSession;
  } catch {
    return null;
  }
}

export function recordSiteSession(site: SigninSite, signedIn: boolean, extra: { account?: string | null; signedOutByPerson?: boolean; autoSigninFailed?: boolean } = {}): void {
  try {
    // A failed check says nothing new about who signed out; a successful one ends a deliberate sign-out.
    const before = signedIn ? null : readSiteSession(site);
    const signedOutByPerson = signedIn ? false : extra.signedOutByPerson ?? before?.signedOutByPerson ?? false;
    const autoSigninFailed = signedIn ? false : extra.autoSigninFailed ?? before?.autoSigninFailed ?? false;
    writeFileSync(
      resolve(config.dataDir, `${site}-session.json`),
      JSON.stringify({ signedIn, checkedAt: new Date().toISOString(), source: 'run', account: signedIn ? extra.account ?? null : null, signedOutByPerson, autoSigninFailed }, null, 2),
    );
  } catch {
    // Never fail a run over a status file the run itself does not read.
  }
}

/**
 * The address the board knows this account by, read off the board's own account
 * page while it is on screen. SEEK prints it on the profile; Indeed carries it
 * in the page's data. Both come out the same way: on a person's own account page
 * the address that appears is theirs, and if several do, theirs appears most.
 */
async function accountOnPage(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const pattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
      const shown = (document.body?.innerText ?? '').match(pattern) ?? [];
      const source = shown.length ? shown : document.documentElement.innerHTML.match(pattern) ?? [];
      const counts = new Map<string, number>();
      for (const found of source) {
        const address = found.toLowerCase();
        // Asset names and the site's own mailboxes are not anybody's account.
        if (/\.(png|jpe?g|gif|svg|webp|js|css)$/.test(address) || /@(seek|indeed|sentry|example)\./.test(address)) continue;
        counts.set(address, (counts.get(address) ?? 0) + 1);
      }
      let best: string | null = null;
      for (const [address, count] of counts) if (best === null || count > (counts.get(best) ?? 0)) best = address;
      return best;
    })
    .catch(() => null);
}

const recordSeekSession = (signedIn: boolean) => recordSiteSession('seek', signedIn);

/** Confirms the SEEK session is still alive without touching credentials. */
/**
 * Signed in, or signed back in.
 *
 * A lapsed session used to stop the board until a person opened a window and
 * pressed the one button waiting for them. The board's own check still decides
 * — before, and again after — and only a "signed out" verdict starts a
 * sign-in; a page that would not load is reported as it always was.
 */
async function ensure(page: Page, site: string, check: (page: Page) => Promise<void>): Promise<void> {
  try {
    return await check(page);
  } catch (error) {
    if (!/not signed in/i.test((error as Error).message)) throw error;
    if (readSiteSession(site === 'SEEK' ? 'seek' : 'indeed')?.signedOutByPerson) throw error;
    console.log(`  ! ${site} session has lapsed; signing back in with the account this browser already has`);
  }
  const attempt = await signInAutomatically(page, site, () => check(page).then(() => true, () => false));
  if (attempt.ok) {
    console.log(`  ✓ signed back in to ${site}`);
    return;
  }
  recordSiteSession(site === 'SEEK' ? 'seek' : 'indeed', false, { autoSigninFailed: true });
  throw new Error(`${site} session is not signed in, and signing back in automatically did not work: ${attempt.reason}. Sign in on the Apply page.`);
}

export const ensureSignedIn = (page: Page): Promise<void> => ensure(page, 'SEEK', assertSignedIn);
export const ensureIndeedSignedIn = (page: Page): Promise<void> => ensure(page, 'Indeed', assertIndeedSignedIn);

export async function assertSignedIn(page: Page, challengeTimeoutMs = 45_000, verdictTimeoutMs = 15_000): Promise<void> {
  await page.goto(`${config.seekBase}/profile/me`, { waitUntil: 'domcontentloaded' });
  await waitForChallengeToClear(page, challengeTimeoutMs);

  /**
   * Wait for the answer rather than reading the URL immediately.
   *
   * The profile page is a single-page app: a signed-out visit renders its
   * shell first and only redirects to login.seek.com a second or two later.
   * Testing the URL at domcontentloaded therefore reported "signed in" for
   * every signed-out profile — harmless while one always-signed-in profile
   * was shared, and badly wrong once each account has its own, because a new
   * account's first run would crawl SEEK unauthenticated before failing.
   */
  const verdict = await page
    .waitForFunction(
      () => {
        if (/login\.seek|\/oauth\/login|\/signin|\/login\b/i.test(location.href)) return 'signed-out';
        const text = document.body?.innerText ?? '';
        if (/sign in to view your profile|sign in to continue/i.test(text)) return 'signed-out';
        if (/profile visibility|profile strength|career history|profile activity/i.test(text)) return 'signed-in';
        return false;
      },
      undefined,
      { timeout: verdictTimeoutMs, polling: 300 },
    )
    .then((handle) => handle.jsonValue() as Promise<string>)
    .catch(() => 'unclear');

  if (verdict === 'signed-out' || (verdict === 'unclear' && /login|signin|oauth/i.test(page.url()))) {
    recordSeekSession(false);
    throw new Error(
      'SEEK session is not signed in. Open the Chrome profile manually, sign in, then re-run. ' +
        'This tool never automates login.',
    );
  }
  // An 'unclear' verdict that did not land on a login page stays unrecorded: a
  // page that failed to load is not evidence either way, and overwriting a
  // known-good state with a guess would put the sign-in prompt back in front
  // of someone who is perfectly well signed in.
  if (verdict === 'signed-in') recordSiteSession('seek', true, { account: await accountOnPage(page) });
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
export async function assertIndeedSignedIn(page: Page, challengeTimeoutMs = 45_000, verdictTimeoutMs = 15_000): Promise<void> {
  // `/myjobs` is account-protected and therefore authoritative. The public
  // homepage can retain a stale `isLoggedIn` bootstrap flag after the session
  // cookie expires, while Apply redirects to secure.indeed.com with loggedIn=0.
  await page.goto(`${config.indeedBase}/myjobs`, { waitUntil: 'domcontentloaded' });
  await waitForChallengeToClear(page, challengeTimeoutMs);
  const verdict = await page
    .waitForFunction(
      () => {
        if (/secure\.indeed\.com|\/account\/login/i.test(location.href)) return 'signed-out';
        const text = document.body?.innerText ?? '';
        if (/create an account or sign in|email address\s*\*/i.test(text)) return 'signed-out';
        if (/\bmy jobs\b|\bsaved\b|\bapplied\b|\barchived\b/i.test(text)) return 'signed-in';
        return false;
      },
      undefined,
      { timeout: verdictTimeoutMs, polling: 300 },
    )
    .then((handle) => handle.jsonValue() as Promise<string>)
    .catch(() => 'unclear');

  if (verdict === 'signed-out') {
    recordSiteSession('indeed', false);
    throw new Error(
      'Indeed session is not signed in. Open the Chrome profile manually, sign in to au.indeed.com, then re-run. ' +
        'This tool never automates login.',
    );
  }
  if (verdict !== 'signed-in') {
    throw new Error('Indeed did not finish loading My Jobs, so the sign-in could not be confirmed. Try again in a moment.');
  }
  recordSiteSession('indeed', true, { account: await accountOnPage(page) });
}

async function assertIndeedSignedInLegacy(page: Page): Promise<void> {
  await page.goto(`${config.indeedBase}/`, { waitUntil: 'domcontentloaded' });
  const url = page.url();
  if (/secure\.indeed\.com|\/account\/login/i.test(url)) {
    recordSiteSession('indeed', false);
    throw new Error(
      'Indeed session is not signed in. Open the Chrome profile manually, sign in to au.indeed.com, then re-run. ' +
        'This tool never automates login.',
    );
  }
  await waitForChallengeToClear(page);
  if ((await judgePage(page, 'the Indeed homepage')).state === 'captcha') {
    throw new Error(
      'Indeed is showing a Cloudflare verification challenge instead of the site. Open the Chrome profile ' +
        'manually, solve the challenge (or wait for it to clear — it usually follows a burst of traffic), then re-run.',
    );
  }
  /**
   * Signed in, or not, from what the page shows a person.
   *
   * This used to read one global, `mosaic.initialData.isLoggedIn`. Indeed
   * stopped setting it on the homepage, and a signed-in account then read
   * as signed out on every run and every check. One private flag is a
   * fragile witness; the page has public ones. A signed-in visitor gets the
   * account menu and the Messages link in the header and no "Sign in" link.
   * A signed-out visitor gets the opposite. The flag is still consulted when
   * it exists, and when the signals disagree nothing is recorded, so a page
   * that is half-loaded never overwrites a known state.
   */
  const verdict = await page
    .waitForFunction(
      () => {
        const flag = (window as any).mosaic?.initialData?.isLoggedIn;
        const header = document.querySelector('header, nav, #gnav') ?? document.body;
        const text = header?.textContent ?? '';
        const accountMenu = Boolean(
          document.querySelector('[data-gnav-element-name="AccountMenu"], [data-gnav-element-name="Messages"], [aria-label*="account menu" i]'),
        ) || /\bMessages\b/.test(text);
        const signInLink = Boolean(document.querySelector('a[href*="/account/login"], a[data-gnav-element-name="SignIn"]'));
        if (flag === true || (accountMenu && !signInLink)) return 'signed-in';
        if (flag === false || (signInLink && !accountMenu)) return 'signed-out';
        return false;
      },
      undefined,
      { timeout: 12_000, polling: 300 },
    )
    .then((handle) => handle.jsonValue() as Promise<string>)
    .catch(() => 'unclear');
  if (verdict === 'signed-out') {
    recordSiteSession('indeed', false);
    throw new Error(
      'Indeed session is not signed in. Open the Chrome profile manually, sign in to au.indeed.com, then re-run. ' +
        'This tool never automates login.',
    );
  }
  if (verdict === 'unclear') {
    throw new Error('Indeed did not finish loading, so the sign-in could not be confirmed. Try again in a moment.');
  }
  // Same rule as SEEK: only a clear answer is written. A challenge page is not one.
  recordSiteSession('indeed', true);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
