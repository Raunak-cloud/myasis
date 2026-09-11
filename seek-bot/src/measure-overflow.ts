import { chromium } from 'patchright';

/**
 * Loads a page at a phone width and names whatever is wider than the
 * viewport. Exists because a screenshot shows that something overflows but
 * not what; this walks the DOM and reports the widest offenders.
 *
 *   npx tsx src/measure-overflow.ts http://localhost:5180/ 420
 */
const [url = 'http://localhost:5180/', widthArg = '420'] = process.argv.slice(2);
const width = Number(widthArg);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const report = await page.evaluate((vw) => {
  const doc = document.documentElement;
  const offenders: Array<{ tag: string; cls: string; right: number; width: number; text: string }> = [];
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > vw + 1 || r.width > vw + 1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className && typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join('.') : '',
        right: Math.round(r.right),
        width: Math.round(r.width),
        text: (el.textContent ?? '').trim().slice(0, 40),
      });
    }
  }
  offenders.sort((a, b) => b.width - a.width);
  return {
    viewport: vw,
    scrollWidth: doc.scrollWidth,
    bodyWidth: document.body.getBoundingClientRect().width,
    offenders: offenders.slice(0, 12),
  };
}, width);

console.log(JSON.stringify(report, null, 2));
await browser.close();
