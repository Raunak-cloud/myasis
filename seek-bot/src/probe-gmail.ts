import { launchBrowser, closeBrowser } from './browser.js';
import { findCodeInBrowser } from './browser-gmail.js';

/**
 * Points the real reader at the real Gmail in this profile and reports what
 * it saw. Exists because every other test here is against text I wrote — this
 * is the only way to find out whether Gmail's actual markup, sign-in
 * redirects and load timing behave the way the reader assumes.
 *
 *   GMAIL_BROWSER_ACCOUNT=x@gmail.com npx tsx src/probe-gmail.ts
 */
async function main() {
  const context = await launchBrowser();
  try {
    const started = Date.now();
    const result = await findCodeInBrowser(context, {
      timeoutMs: Number(process.env.PROBE_TIMEOUT_MS ?? 25_000),
      log: (line) => console.log(line),
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if ('error' in result) console.log(`\nRESULT after ${seconds}s: no code — ${result.error}`);
    else console.log(`\nRESULT after ${seconds}s: code ${result.code} from "${result.subject}"`);
  } finally {
    await closeBrowser(context);
  }
}

void main();
