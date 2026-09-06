/**
 * Diagnostic: dumps SEEK's GraphQL search traffic so we can decide whether the
 * query is replayable. Run when search stops working: `node dist/probe.js`
 */
import { launchBrowser, closeBrowser, getPage, jitter } from './browser.js';
import { config } from './config.js';

const ctx = await launchBrowser();
const page = await getPage(ctx);
const gql: { op: string; body: string; status: number; sample: string }[] = [];

page.on('request', (req) => {
  if (!req.url().includes('/graphql')) return;
  const body = req.postData() ?? '';
  let op = 'unknown';
  try {
    const parsed = JSON.parse(body);
    op = parsed.operationName ?? (Array.isArray(parsed) ? 'batch' : 'anon');
  } catch {}
  gql.push({ op, body: body.slice(0, 1500), status: 0, sample: '' });
});

page.on('response', async (res) => {
  if (!res.url().includes('/graphql')) return;
  try {
    const json = await res.json();
    const txt = JSON.stringify(json);
    const entry = gql[gql.length - 1];
    if (entry) {
      entry.status = res.status();
      entry.sample = txt.slice(0, 700);
    }
  } catch {}
});

await page.goto(`${config.seekBase}/jobs?keywords=react%20developer&sortmode=ListedDate`, {
  waitUntil: 'networkidle',
});
await jitter(2500, 3500);

console.log(`=== ${gql.length} GRAPHQL CALLS ===`);
for (const g of gql) {
  console.log(`\n--- op=${g.op} status=${g.status} ---`);
  console.log('REQ :', g.body.replace(/\s+/g, ' ').slice(0, 700));
  if (/jobs|results|count/i.test(g.sample)) console.log('RES :', g.sample.slice(0, 500));
}

await closeBrowser(ctx);
