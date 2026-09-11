import { launchBrowser, closeBrowser, getPage } from './browser.js';

/** Throwaway: shows what Gmail actually renders, so the reader can be fixed against reality. */
async function main() {
  const context = await launchBrowser();
  try {
    const page = await getPage(context);
    const search = 'newer_than:1h (code OR verification OR verify OR passcode OR OTP OR "one-time")';

    for (const [label, url] of [
      ['SEARCH URL', `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(search)}`],
      ['PLAIN INBOX', 'https://mail.google.com/mail/u/0/#inbox'],
    ] as const) {
      console.log(`\n===== ${label} =====`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => console.log('goto:', e.message));
      await page.waitForTimeout(8_000);
      console.log('landed on:', page.url());
      const text = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')) as string;
      console.log('text length:', text.length);
      console.log('--- first 900 chars ---');
      console.log(text.slice(0, 900));
    }
  } finally {
    await closeBrowser(context);
  }
}

void main();
