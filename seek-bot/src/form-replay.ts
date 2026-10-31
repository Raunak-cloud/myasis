import { writeFileSync } from 'node:fs';
import { chromium } from 'patchright';
import { corpusPages, expectationOf } from './form-corpus.js';
import { observe } from './agent/observe.js';
import { hasCaptchaSurface } from './captcha/detect.js';
import { compareFormExpectations as compare, type Finding } from './form-replay-compare.js';

/**
 * Replays the recorded real employer form pages against the current code and
 * reports what it now reads differently.
 *
 *   node dist/form-replay.js <corpus dir>... [--accept]
 *
 * A regression fails the replay (exit 1): a field no longer found, a field
 * that had a real label now named by nothing useful, a security check read
 * differently, a place for a cover letter no longer seen. Other differences
 * (a label worded differently, a field newly found) are listed for a person
 * to judge; --accept records the current reading as the new expectation once
 * they have. Every page is served at its own address with every other request
 * refused, so nothing reaches an employer.
 */
const args = process.argv.slice(2);
const accept = args.includes('--accept');
const dirs = args.filter((arg) => !arg.startsWith('--'));
if (!dirs.length) {
  console.error('usage: node dist/form-replay.js <corpus dir>... [--accept]');
  process.exit(2);
}

/**
 * An address as the browser requests it: without the part after "#". A
 * single-page form keeps its step there (ELMO's "#/step2", Cornerstone's
 * "#2"), which never reaches the network, so comparing whole addresses
 * refused every such page and reported it as unreadable.
 */
const requested = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
};

const pages = corpusPages(dirs);
console.log(`Replaying ${pages.length} recorded employer form page(s)…`);
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const findings: Finding[] = [];
let read = 0;
try {
  for (const recorded of pages) {
    // Several recorded steps can share one URL (including its fragment).
    // A fresh page prevents same-document navigation from reusing the last
    // step's DOM instead of requesting this snapshot.
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const name = `${recorded.expectation.platform} · ${recorded.expectation.host}${new URL(recorded.expectation.url).pathname.slice(0, 60)}`;
    try {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      const address = requested(recorded.expectation.url);
      await page.route('**/*', (route) => {
        if (requested(route.request().url()) === address) {
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: recorded.html });
        }
        // Keep the recorded child-frame URL without contacting its provider.
        // Aborting replaces it with chrome-error:// and falsely loses CAPTCHA
        // surfaces whose detection depends on the security frame's URL.
        if (route.request().isNavigationRequest() && route.request().frame() !== page.mainFrame()) {
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body></body></html>' });
        }
        return route.abort();
      });
      await page.goto(recorded.expectation.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      // A recorded static page must not replay its entrance animation from
      // frame zero. Match snapshot-test rendering: finish finite animations
      // and cancel infinite ones before observing, without changing baselines.
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) {
          try {
            if (animation.effect?.getComputedTiming().endTime === Infinity) animation.cancel();
            else animation.finish();
          } catch { animation.cancel(); }
        }
      });
      const observation = await observe(page);
      const now = expectationOf(observation, await hasCaptchaSurface(page).catch(() => false), recorded.expectation.url, recorded.expectation.capturedAt);
      findings.push(...compare(name, recorded.expectation, now));
      if (accept) writeFileSync(recorded.json, JSON.stringify(now, null, 2));
      read++;
    } catch (error) {
      findings.push({ page: name, kind: 'regression', detail: `could not be read: ${(error as Error).message.split('\n')[0].slice(0, 160)}` });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

const regressions = findings.filter((finding) => finding.kind === 'regression');
const changes = findings.filter((finding) => finding.kind === 'change');
for (const finding of [...regressions, ...changes]) console.log(`  ${finding.kind === 'regression' ? '✗' : '·'} ${finding.page}: ${finding.detail}`);
console.log(`Replayed ${read}/${pages.length}: ${regressions.length} regression(s), ${changes.length} change(s)${accept ? ' — current readings accepted as expected' : ''}.`);
process.exit(regressions.length && !accept ? 1 : 0);
