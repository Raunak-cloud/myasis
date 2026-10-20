import type { Page } from 'patchright';
import { workingIn } from './browser.js';

/** A retired attempt may close its page. Replacement stays in the same worker
 * context, so account sessions and the other worker's tabs are untouched. */
export async function applicationWorkerPage(page: Page): Promise<Page> {
  if (!page.isClosed()) return page;
  const replacement = await page.context().newPage();
  await workingIn(replacement);
  return replacement;
}
