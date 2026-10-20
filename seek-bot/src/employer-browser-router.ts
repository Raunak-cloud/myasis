import type { Page } from 'patchright';
import { openEmployerBrowser, applicationBrowserName } from './employer-browser.js';
import { employerBrowserProvider } from './employer-browser-config.js';
import { guardExternalNavigations } from './external-url.js';
import { jobBoardForUrl } from './job-board-url.js';

/** One private employer session per attempt, independent of the job's discovery path.
 * Only the destination URL crosses this boundary: never board cookies or storage. */
export class EmployerBrowserRouter {
  private owned?: Awaited<ReturnType<typeof openEmployerBrowser>>;
  private guard?: Awaited<ReturnType<typeof guardExternalNavigations>>;
  private contexts = new WeakSet<object>();
  private pages = new WeakSet<Page>();
  private pending = new Set<Page>();
  constructor(private dependencies = { open: openEmployerBrowser, guard: guardExternalNavigations }) {}

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
    this.owned = await this.dependencies.open(page);
    try {
      this.guard = await this.dependencies.guard(this.owned.page.context());
      await this.owned.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      this.pending.clear();
      return this.owned.page;
    } catch (error) {
      await this.close();
      throw error;
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
