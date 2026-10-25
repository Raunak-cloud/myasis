import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { billingOffers, DAY_MS, type ActivePass } from '../server/billing-policy.js';
import type { BillingStatus } from '../src/billing.js';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');

const dashboard = resolve(import.meta.dirname, '..');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pricing fixture</title></head><body><main id="root"></main><script type="module">import React from 'react';import{createRoot}from'react-dom/client';import{PricingPanel}from'/src/components/PricingPanel.tsx';import'/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(PricingPanel));</script><style>body{margin:0}#root{padding:16px}</style></body></html>`;
const server = await createServer({ configFile: false, root: dashboard, plugins: [react(), {
  name: 'pricing-fixture', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/pricing-fixture.html') return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml('/pricing-fixture.html', html));
    });
  },
}], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  mkdirSync(resolve(dashboard, '../output'), { recursive: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const now = Date.now();
    const active: ActivePass = { grantId: '123', planKey: 'essential-pass', expiresAt: new Date(now + 15 * DAY_MS).toISOString(),
      periodStartedAt: new Date(now - 15 * DAY_MS).toISOString(), priceCents: 990, durationMs: 30 * DAY_MS, applications: 50 };
    const status = (): BillingStatus => ({ configured: true, free: { allowance: 5, used: 5, remaining: 0 },
      paid: { remaining: 30, employerSiteRemaining: 0, expiresAt: active.expiresAt, hasActivePass: true,
        hasActiveEssentialPass: active.planKey === 'essential-pass', hasActiveJobSearchPass: active.planKey === 'job-search-pass',
        hasActiveIntensivePass: active.planKey === 'intensive-pass', unlimitedApplications: active.planKey === 'intensive-pass' },
      totalRemaining: 30, offers: billingOffers(active, false, now) });
    const requests: unknown[] = [];
    let loads = 0;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = (body: unknown, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/billing/status') { loads++; return json(status()); }
      if (url.pathname === '/api/billing/checkout') {
        requests.push(route.request().postDataJSON());
        return json({ error: 'Your plan or upgrade price has changed. Refresh pricing and try again.' }, 409);
      }
      if (url.pathname === '/api/billing/confirm') return json({ status: status(), fulfilled: true, planKey: 'job-search-pass', kind: 'upgrade',
        applications: 75, amountPaidCents: 505, durationDays: 30, expiresAt: active.expiresAt });
      throw new Error('Unexpected pricing request ' + url.pathname);
    });
    await page.goto(origin + '/pricing-fixture.html');
    const card = (name: string) => page.locator('article.pricing-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await card('Essential Pass').getByRole('button', { name: 'Your pass is active' }).waitFor();
    assert.equal(await card('Essential Pass').getByRole('button').isDisabled(), true);
    assert.match(await card('Active Search').innerText(), /A\$5\.05/);
    assert.match(await card('Active Search').innerText(), /75 additional application credits/);
    assert.doesNotMatch(await card('Active Search').innerText(), /30 days of access/);
    assert.match(await card('Get Owtomated').innerText(), /upgrade/);
    assert.equal(await page.getByRole('button', { name: 'Add 50 applications' }).isEnabled(), true);
    await card('Active Search').getByRole('button', { name: 'Upgrade to Active Search' }).click();
    await page.getByRole('status').waitFor();
    const offer = status().offers!['job-search-pass'];
    assert.deepEqual(requests, [{ planKey: 'job-search-pass', quotedAt: offer.quotedAt, sourceGrantId: offer.sourceGrantId,
      amountCents: offer.amountCents, expiresAt: offer.expiresAt }]);
    await page.waitForFunction(() => !document.querySelector('button:disabled')?.textContent?.includes('Opening'));
    assert.ok(loads >= 2, 'stale offer reloads the server price');
    active.planKey = 'job-search-pass'; active.priceCents = 1999; active.applications = 200;
    await page.reload();
    await card('Essential Pass').getByRole('button', { name: 'Lower plan unavailable' }).waitFor();
    assert.equal(await card('Essential Pass').getByRole('button').isDisabled(), true);
    assert.equal(await card('Active Search').getByRole('button').isDisabled(), true);
    assert.equal(await card('Get Owtomated').getByRole('button', { name: 'Upgrade to Get Owtomated' }).isEnabled(), true);
    await page.goto(origin + '/pricing-fixture.html?payment=success&session_id=fixture');
    await page.getByRole('status').filter({ hasText: 'Upgraded to Active Search. Access ends' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'pricing fits mobile');
    await page.screenshot({ path: resolve(dashboard, '../output/pricing-upgrades-' + width + '.png'), fullPage: true });
    active.planKey = 'intensive-pass'; active.priceCents = 5999; active.applications = 400;
    await page.goto(origin + '/pricing-fixture.html');
    await card('Get Owtomated').getByRole('button', { name: 'Your pass is active' }).waitFor();
    assert.equal(await page.locator('.pricing-card button:not(:disabled)').count(), 0);
    assert.equal(await page.locator('.pricing-topup').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS pricing upgrade amount, expiry, checkout snapshot and downgrade prevention at width', width);
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
