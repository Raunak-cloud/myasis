import { chromium, type Browser } from 'patchright';
import { assertExternalNavigationUrl } from './external-url.js';
import { browserDeadline, browserOperationOptions, browserOperationSignal, browserOperationTimeout } from './browser-deadline.js';

type Options = {
  launch?: typeof chromium.launch;
  validatePublicUrl?: (url: string) => Promise<string>;
  timeoutMs?: number;
};

/** Render the publisher's own public page when its ordinary HTTP response
 * requires JavaScript verification. Never open a candidate profile. */
export async function renderPublicPageup(url: string, options: Options = {}): Promise<{ url: string; html: string }> {
  const destination = new URL(url);
  if (!/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?jobs\/(?:search|[A-Za-z0-9_%.-]+)\/?$/.test(destination.pathname)) {
    throw Error('Public PageUp browser requires a job search or vacancy page.');
  }
  const validate = options.validatePublicUrl ?? assertExternalNavigationUrl;
  let browser: Browser | undefined;
  let detach = () => {};
  try {
    return await browserDeadline('Public PageUp browser', options.timeoutMs ?? 30_000, async () => {
      const signal = browserOperationSignal(30_000);
      const close = () => { void browser?.close().catch(() => {}); };
      signal.addEventListener('abort', close, { once: true });
      detach = () => signal.removeEventListener('abort', close);
      await validate(url);
      signal.throwIfAborted();
      browser = await (options.launch ?? chromium.launch.bind(chromium))({
        executablePath: process.env.CHROME_PATH ?? (process.platform === 'linux' ? '/usr/bin/google-chrome-stable' : undefined),
        ...(process.platform === 'win32' && !process.env.CHROME_PATH ? { channel: 'chrome' } : {}),
        headless: !process.env.DISPLAY,
        chromiumSandbox: true,
        timeout: browserOperationTimeout(),
        args: ['--window-size=1440,960', '--window-position=-32000,-32000'],
      });
      if (signal.aborted) { await browser.close().catch(() => {}); signal.throwIfAborted(); }
      const context = await browser.newContext({ viewport: null, serviceWorkers: 'block', acceptDownloads: false });
      const hosts = new Map<string, Promise<unknown>>();
      await context.route('**/*', async route => {
        try {
          const request = route.request(), target = new URL(request.url());
          // Public pages and their assets only. AWS's own challenge script may
          // POST its verification response; no account/form POST is allowed.
          if (!['GET', 'HEAD'].includes(request.method())
            && !(request.method() === 'POST' && !request.isNavigationRequest() && target.hostname.endsWith('.awswaf.com'))) {
            return await route.abort('blockedbyclient');
          }
          // Validate every document URL and every asset host. Cache DNS only
          // within this fresh context, never candidate sessions or WAF tokens.
          if (request.isNavigationRequest()) {
            if (target.origin !== destination.origin) return await route.abort('blockedbyclient');
            await validate(target.href);
          }
          else {
            const key = target.origin;
            if (!hosts.has(key)) hosts.set(key, validate(target.href));
            await hosts.get(key);
          }
          signal.throwIfAborted();
          return await route.fallback();
        } catch { await route.abort('blockedbyclient').catch(() => {}); }
      });
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', ...browserOperationOptions() });
      if (response && response.status() >= 400) throw Error(`Public career site returned HTTP ${response.status()}.`);
      const search = /\/search\/?$/.test(destination.pathname);
      await page.waitForFunction(isSearch => isSearch
        ? Boolean(document.querySelector('form.job-search-results-form [name="query"]') && document.querySelector('.job-search-results-content'))
        : [...document.querySelectorAll('script[type="application/ld+json"]')].some(script => /"JobPosting"/.test(script.textContent || '')),
      search, { timeout: browserOperationTimeout() });
      signal.throwIfAborted();
      const final = new URL(page.url());
      if (final.origin !== destination.origin || final.pathname.replace(/\/$/, '') !== destination.pathname.replace(/\/$/, '') || final.search !== destination.search) {
        throw Error('Public PageUp browser left the requested employer page.');
      }
      const html = await page.content();
      if (Buffer.byteLength(html) > 8_000_000) throw Error('Career-site response exceeded its size limit.');
      return { url: final.href, html };
    });
  } finally {
    detach();
    await browser?.close().catch(() => {});
  }
}
