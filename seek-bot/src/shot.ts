import { chromium } from 'patchright';

/**
 * A full-page capture at an exact viewport width, for checking a layout the
 * way a phone would show it. Headless Chrome's own --screenshot cannot go
 * below its minimum window width and crops instead of narrowing.
 *
 *   npx tsx src/shot.ts http://localhost:5180/ 390 out.png [dark]
 */
const [url = 'http://localhost:5180/', widthArg = '390', out = 'shot.png', scheme = 'light'] = process.argv.slice(2);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: Number(widthArg), height: 844 },
  colorScheme: scheme === 'dark' ? 'dark' : 'light',
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: out, fullPage: true });
console.log(`saved ${out}`);
await browser.close();
