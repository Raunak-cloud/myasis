import { createRequire } from 'node:module';
import type { Page } from '../../../seek-bot/node_modules/patchright/index.js';
import { ensureUserDataDir, userChromeDir } from '../userdata.js';
import { browserRoute } from '../route.js';
import { readEnv } from '../runner.js';
import { browserDeadline, browserCleanup } from '../../../seek-bot/src/browser-deadline.js';
const { chromium } = createRequire(import.meta.url)('../../../seek-bot/node_modules/patchright') as typeof import('../../../seek-bot/node_modules/patchright/index.js');

/** Caller holds the account's application-service slot. Never closes an existing
 * browser to obtain a profile: Chrome's exclusive lock makes a busy profile defer. */
export async function withHrBrowser<T>(userId: string, action: (page: Page) => Promise<T>): Promise<T> {
  ensureUserDataDir(userId);
  const route = await browserRoute(userId);
  const context = await chromium.launchPersistentContext(userChromeDir(userId), {
    executablePath: readEnv().CHROME_PATH?.trim() || '/usr/bin/google-chrome', headless: false,
    args: ['--no-sandbox','--test-type',...route.args], timeout: 30_000,
  });
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(30_000);
  try { const page=await context.newPage();return await browserDeadline('HR outreach mailbox',120_000,()=>action(page)); }
  finally { await browserCleanup('Close HR mailbox',()=>context.close()); }
}
