import { distill, type PageFacts } from './browser/distill.js';
import { visit, withPage } from './browser/session.js';
import { assertPublicUrl, publicWebsiteUrl } from './core/public-url.js';
import { robotsAllows } from './core/politeness.js';
import { sameWebsite } from './core/quality.js';
import { pickKeyPages } from './sources/website.js';

export interface SiteScan { url: string; scannedAt: string; pages: PageFacts[]; gaps: string[] }

/** Read homepage and two product/service pages. No form submissions or model guesses. */
export async function scanSite(raw: string): Promise<SiteScan> {
  const url = publicWebsiteUrl(raw);
  await assertPublicUrl(url);
  const scan: SiteScan = { url, scannedAt: new Date().toISOString(), pages: [], gaps: [] };
  await withPage(async (page) => {
    if (!(await robotsAllows(url))) throw new Error('The website does not allow this scan.');
    await visit(page, url);
    if (!sameWebsite(page.url(), url)) throw new Error('Website redirected to another domain; enter its public address.');
    const home = await distill(page, 16_000);
    if (home.wordCount < 30) throw new Error('Not enough readable website content to identify its products.');
    scan.pages.push(home);
    const links = home.links.filter((l) => { try { return new URL(l.href).origin === new URL(home.url).origin; } catch { return false; } });
    const targets = pickKeyPages(links, 4).filter((p) => !/login|sign-in|checkout|cart|logout|delete/i.test(new URL(p.url).pathname)).slice(0, 2);
    for (const target of targets) {
      try {
        await assertPublicUrl(target.url);
        if (!(await robotsAllows(target.url))) { scan.gaps.push(`Could not scan ${target.url}: website crawl restriction.`); continue; }
        await visit(page, target.url);
        if (!sameWebsite(page.url(), url)) throw new Error('Page redirected to another domain.');
        scan.pages.push(await distill(page, 12_000));
      } catch (error) { scan.gaps.push(`Could not scan ${target.url}: ${(error as Error).message.slice(0, 180)}`); }
    }
  });
  return scan;
}
