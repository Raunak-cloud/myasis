import type { Page } from 'patchright';
import type { Observation } from './observe.js';

/** Restore a readable surface, never replay a click, navigation or submission. */
export class ApplicationBrowserRecovery {
  private parents = new WeakMap<Page, Page>();
  constructor(private readonly entry: Page, private readonly owned: Set<Page>) {}

  opened(page: Page, parent: Page): void {
    this.parents.set(page, parent);
    this.owned.add(page);
  }

  async readablePage(current: Page): Promise<Page> {
    if (!current.isClosed()) return current;
    const seen = new Set<Page>();
    for (let parent = this.parents.get(current); parent && !seen.has(parent); parent = this.parents.get(parent)) {
      if (!parent.isClosed()) return parent;
      seen.add(parent);
    }
    if (!this.entry.isClosed()) return this.entry;
    const survivor = [...this.owned].reverse().find(page => !page.isClosed())
      ?? current.context().pages().find(page => !page.isClosed());
    if (survivor) return survivor;
    // A closed last tab need not mean the owner-scoped browser context died.
    // A blank tab lets the agent choose recovery without reopening or resending.
    try {
      const page = await current.context().newPage();
      this.owned.add(page);
      return page;
    } catch { return current; }
  }

  async observe(page: Page, read: (page: Page) => Promise<Observation>, failed: (error: unknown) => void): Promise<{ page: Page; observation: Observation; note?: string }> {
    const selected = await this.readablePage(page);
    const notice = selected === page ? undefined : 'The active tab closed. Showing a surviving tab; inspect the open pages and choose where to continue. No application action was replayed.';
    try { return { page: selected, observation: await read(selected), note: notice }; }
    catch (error) {
      failed(error);
      // Covers closing during DOM inspection, not just before the turn starts.
      const survivor = await this.readablePage(selected);
      if (survivor !== selected) {
        try { return { page: survivor, observation: await read(survivor), note: 'The tab closed during inspection. Read the surviving page and continue from actual saved work. No operation was replayed.' }; }
        catch (nextError) { failed(nextError); error = nextError; }
      }
      const message = error instanceof Error ? error.message : String(error);
      return { page: survivor, observation: { url: survivor.url(), title: '', actions: [], fields: [], inspectionError: message,
        text: `LIVE BROWSER INSPECTION FAILED: ${message}\nNo current form values or receipt were obtained. Use the open-page inventory, select another tab, inspect a different surface or choose another supported recovery. This is not evidence that the vacancy is unavailable. Preserve completed work and investigate any possible send without repeating it.` } };
    }
  }
}
