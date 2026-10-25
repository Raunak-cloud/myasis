import type { Page } from 'patchright';
import { openEmployerBrowser, applicationBrowserName } from './employer-browser.js';
import { employerBrowserProvider } from './employer-browser-config.js';
import { guardExternalNavigations } from './external-url.js';
import { jobBoardForUrl } from './job-board-url.js';

const ENTRY_ATTEMPTS = 3;
const ENTRY_WINDOW_MS = 180_000;
const transientEntryCode = (error: unknown): string | undefined => {
  const message = String((error as Error)?.message ?? error);
  return /\b(?:ERR_EMPTY_RESPONSE|ERR_CONNECTION_(?:RESET|CLOSED|ABORTED|TIMED_OUT)|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_PROXY_CONNECTION_FAILED)\b/.exec(message)?.[0]
    ?? (/Client connect timeout \(proxy_error\)/i.test(message) ? 'PROVIDER_CONNECT_TIMEOUT' : undefined);
};

/** One private employer session per attempt, independent of the job's discovery path.
 * Only the destination URL crosses this boundary: never board cookies or storage. */
export class EmployerBrowserRouter {
  private owned?: Awaited<ReturnType<typeof openEmployerBrowser>>;
  private guard?: Awaited<ReturnType<typeof guardExternalNavigations>>;
  private contexts = new WeakSet<object>();
  private pages = new WeakSet<Page>();
  private pending = new Set<Page>();
  constructor(private dependencies = { open: openEmployerBrowser, guard: guardExternalNavigations },
    private runtime = { now: Date.now, pause: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }) {}

  async route(page: Page): Promise<Page> {
    if (employerBrowserProvider(process.env) === 'local') return page;
    const context = page.context();
    if (this.contexts.has(context)) {
      for (const tab of context.pages()) if (!this.pages.has(tab)) { this.pages.add(tab); this.pending.add(tab); }
    } else {
      this.contexts.add(context);
      for (const tab of context.pages()) this.pages.add(tab);
    }
    for (const tab of [...this.pending]) {
      if (tab.isClosed()) { this.pending.delete(tab); continue; }
      if (/^https?:\/\//i.test(tab.url())) {
        this.pending.delete(tab);
        if (!jobBoardForUrl(tab.url())) page = tab;
      }
    }
    const url = page.url();
    if (!/^https?:\/\//i.test(url) || jobBoardForUrl(url) || applicationBrowserName(page) === 'brightdata'
    ) return page;
    // Never replay a local filled/submitted form. Callers route before observing or
    // interacting with a newly reached employer page, and discard stale tool plans.
    if (this.owned) throw new Error('The employer application left its private browser session.');
    const deadline = this.runtime.now() + ENTRY_WINDOW_MS;
    for (let attempt = 1; ; attempt++) {
      // Only the initial GET is eligible. Once this returns, the agent owns
      // the browser: never recover by replaying a filled form or a send.
      this.owned = await this.dependencies.open(page);
      let committed = false;
      try {
        this.guard = await this.dependencies.guard(this.owned.page.context());
        const timeout = () => Math.max(1, Math.min(120_000, deadline - this.runtime.now()));
        await this.owned.page.goto(url, { waitUntil: 'commit', timeout: timeout() });
        committed = true;
        await this.owned.page.waitForLoadState('domcontentloaded', { timeout: timeout() });
        // HTTP responses, including access denials, are for the agent to
        // inspect. Only transport failures before receiving a page retry.
        this.pending.clear();
        return this.owned.page;
      } catch (error) {
        const blocked = this.guard?.blocked();
        const code = transientEntryCode(error);
        await this.close();
        if (committed || blocked || !code || attempt >= ENTRY_ATTEMPTS || page.isClosed() || deadline - this.runtime.now() < 60_000) throw error;
        console.log(`  Employer connection interrupted before form entry (${code}); opening fresh private session ${attempt + 1}/${ENTRY_ATTEMPTS}.`);
        await this.runtime.pause(1_000 * attempt);
      }
    }
  }

  async close(): Promise<void> {
    const guard = this.guard, owned = this.owned;
    this.guard = undefined; this.owned = undefined; this.pending.clear();
    // Cleanup after a disconnected browser must not overwrite receipt evidence.
    try { await guard?.stop(); } catch { /* Browser may already be disconnected. */ }
    try { await owned?.close(); } catch { /* The attempt result remains authoritative. */ }
  }
}
