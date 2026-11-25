import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const html = '<html><body><main class="main" id="fixture"></main><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{AdminPanel}from"/src/components/AdminPanel.tsx";import"/src/index.css";createRoot(document.getElementById("fixture")).render(React.createElement(AdminPanel));</script></body></html>';
const server = await createServer({
  configFile: false, root: resolve(import.meta.dirname, '..'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 }, plugins: [react(), {
    name: 'admin-run-fixture',
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== '/fixture.html') return next();
        res.setHeader('content-type', 'text/html');
        res.end(await vite.transformIndexHtml('/fixture.html', html));
      });
    },
  }],
});
await server.listen();
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32'
  ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(6_000);
    await page.clock.install();
    const progress = {
      found: 2222, reviewed: 26, reviewedEstimated: false, matched: 5, reviewLimit: 300,
      sources: ['SEEK', 'Indeed', 'Jora', 'Greenhouse', 'Workday'],
      filters: { listingAge: 1352, alreadyReviewed: 764, awaitingConfirmation: 8 },
      needsAttention: 1, errors: 0, unconfirmed: 0,
    };
    const run = {
      id: '2', userId: '1', email: 'fixture@example.invalid', name: 'Fixture Applicant',
      mode: 'live', trigger: 'admin', bonus: true, startedBy: null, initiatorDevice: null,
      startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
      applied: 3, prepared: 0, cost: null, hasLog: false, running: true, progress,
    };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/admin/runs') return route.fulfill({ json: [
        run, { ...run, id: '1', running: false, finishedAt: run.startedAt, exitCode: 0, bonus: false,
          progress: { ...progress, reviewed: 18, reviewedEstimated: true } },
        { ...run, id: '0', running: false, finishedAt: run.startedAt, exitCode: 0, bonus: false, progress: null },
      ] });
      return route.fulfill({ status: 404, json: { error: 'Fixture endpoint unavailable' } });
    });
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture.html`);
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    const rows = page.locator('tbody tr');
    const live = rows.first();
    await live.getByText('Jobs found', { exact: true }).waitFor();
    assert.match(await live.locator('.admin-run-totals').innerText(), /Jobs found\s+2,222\s+Reviewed\s+26\s+Matched\s+5/);
    assert.equal(await live.locator('td[data-label="Submitted"]').innerText(), '3');
    assert.equal(await live.getByText('Bonus run', { exact: true }).count(), 1);
    assert.match(await rows.nth(1).locator('.admin-run-totals').innerText(), /≈18/);
    assert.equal(await rows.nth(2).getByText('Counts unavailable').count(), 1);
    await live.getByText('More details', { exact: true }).click();
    assert.match(await live.locator('.admin-run-breakdown').innerText(), /Past listing age limit\s+1,352/);
    assert.match(await live.locator('.admin-run-breakdown').innerText(), /Review limit\s+300/);
    assert.equal(await live.getByRole('button', { name: 'Screenshots' }).count(), 1);
    const layout = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth, viewport: innerWidth,
      search: document.querySelector('td.admin-run-search')!.getBoundingClientRect().right,
    }));
    assert.ok(layout.page <= layout.viewport + 1, JSON.stringify(layout));
    assert.ok(layout.search <= layout.viewport + 1, JSON.stringify(layout));
    progress.found = 2300;
    progress.reviewed = 31;
    run.applied = 4;
    await page.clock.fastForward(15_100);
    await live.getByText('2,300', { exact: true }).waitFor();
    assert.equal(await live.locator('td[data-label="Submitted"]').innerText(), '4');
    assert.equal(await live.locator('details[open]').count(), 1);
    console.log(`PASS ${width}px: live totals, older runs, details and layout`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
