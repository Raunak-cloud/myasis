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
const pricingHtml=html.replace('<main id="root"></main>','<div class="fixture-app"><aside aria-hidden="true"></aside><main class="main-shell pricing-dashboard"><header class="page-header"><div><h1>Plans &amp; pricing</h1><p>One payment. No subscription.</p></div></header><div id="root" class="page-content"></div></main></div>')
  .replace('body{margin:0}#root{padding:16px}','body{margin:0}.fixture-app{display:grid;grid-template-columns:264px minmax(0,1fr);min-height:100vh}.fixture-app>aside{background:var(--surface);border-right:1px solid var(--border)}.fixture-app #root{padding:0;height:auto}@media(max-width:900px){.fixture-app{grid-template-columns:1fr}.fixture-app>aside{display:none}}');
const server = await createServer({ configFile: false, root: dashboard, plugins: [react(), {
  name: 'pricing-fixture', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path=req.url?.split('?')[0];
      if(path==='/landing-pricing-fixture.html') {
        const landingHtml=html.replace("import{PricingPanel}from'/src/components/PricingPanel.tsx'","import{Landing}from'/src/components/Landing.tsx'").replace('React.createElement(PricingPanel)','React.createElement(Landing,{googleConfigured:false})');
        res.setHeader('content-type','text/html');res.end(await server.transformIndexHtml(path,landingHtml));return;
      }
      if (path !== '/pricing-fixture.html') return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml('/pricing-fixture.html', pricingHtml));
    });
  },
}], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  mkdirSync(resolve(dashboard, '../output'), { recursive: true });
  for (const {width,height} of [{width:1440,height:900},{width:1366,height:768},{width:1280,height:800},{width:900,height:1000},{width:390,height:844}]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width <= 600 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const now = Date.now();
    const active: ActivePass = { grantId: '123', planKey: 'essential-pass', expiresAt: new Date(now + 15 * DAY_MS).toISOString(),
      periodStartedAt: new Date(now - 15 * DAY_MS).toISOString(), priceCents: 990, durationMs: 30 * DAY_MS, applications: 50 };
    let freePlan = false;
    const status = (): BillingStatus => freePlan ? { configured:true,free:{allowance:5,used:0,remaining:5},
      paid:{remaining:0,employerSiteRemaining:0,expiresAt:null,hasActivePass:false,hasActiveEssentialPass:false,hasActiveJobSearchPass:false,hasActiveIntensivePass:false,unlimitedApplications:false},
      totalRemaining:5,offers:billingOffers(null,false,now) } : ({ configured: true, free: { allowance: 5, used: 5, remaining: 0 },
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
        applications: 75, amountPaidCents: 800, durationDays: 30, expiresAt: active.expiresAt });
      throw new Error('Unexpected pricing request ' + url.pathname);
    });
    await page.goto(origin + '/pricing-fixture.html');
    const card = (name: string) => page.locator('article.pricing-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await card('Essential Pass').getByRole('button', { name: 'Your pass is active' }).waitFor();
    const free=card('Free');assert.match(await free.innerText(),/5 free employer-site applications/);assert.match(await free.innerText(),/6 extra with SEEK \(11 total\)/);assert.match(await free.innerText(),/Forms without an account/);
    assert.equal(await free.locator('.pricing-cta').count(), 0, 'Free has no plan action button');
    assert.equal(await free.locator('img[src="/platforms/jora.svg"]').count(),0);assert.equal(await free.locator('img[src="/platforms/indeed.svg"]').count(),0);
    for (const plan of ['Essential Pass', 'Active Search']) {
      for (const name of ['SEEK', 'Indeed', 'Jora', 'Greenhouse']) {
        assert.equal(await card(plan).getByRole('group', { name: 'Supported job sources' }).getByRole('img', { name, exact: true }).count(), 1);
      }
      assert.doesNotMatch(await card(plan).innerText(), /Account creation with connected Gmail/);
    }
    for(const name of ['SEEK','Indeed','Jora','Greenhouse','Workday']) {
      assert.equal(await card('Get Owtomated').getByRole('group',{name:'Supported job sources'}).getByRole('img',{name,exact:true}).count(),1);
    }
    assert.equal(await card('Active Search').locator('img[src="/platforms/workday.svg"]').count(),0,'Workday remains exclusive to Get Owtomated');
    assert.doesNotMatch(await card('Get Owtomated').innerText(),/Web search for employer-site jobs/);
    assert.match(await card('Get Owtomated').innerText(), /No separate employer-site limit/);
    assert.match(await card('Get Owtomated').innerText(), /Account creation with connected Gmail/);
    const employerEmail = card('Get Owtomated').getByRole('listitem').filter({ hasText: 'Email employers' });
    assert.equal(await employerEmail.getByText('Beta', { exact: true }).isVisible(), true);
    assert.equal(await page.locator('.pricing-card .pricing-features li').filter({ hasText: 'Email employers' }).count(),1);
    assert.equal(await card('Get Owtomated').getByRole('group',{name:'Supported job sources'}).getByText('Web search',{exact:true}).count(),0);
    assert.doesNotMatch(await card('Active Search').innerText(),/Web search/);
    for (const retired of ['SmartRecruiters','PageUp','Web search']) {
      assert.equal(await page.getByRole('group',{name:'Supported job sources'}).getByRole('img',{name:retired,exact:true}).count(),0);
    }
    assert.equal(await page.locator('.pricing-card details, .pricing-card summary').count(),0,'plan details have no accordion controls');
    assert.equal(await page.locator('.pricing-plan-details:visible').count(),4,'every plan shows its details immediately');
    const featureRows = page.locator('.pricing-plan-details li');
    assert.equal(await featureRows.filter({
      hasText: /minimum match|adjustable match|jobs that match your resume by at least/i,
    }).count(), 0, 'plan details omit match threshold rows');
    assert.ok(await featureRows.evaluateAll(rows => rows.length > 0 && rows.every(row => {
      const tips = row.querySelectorAll('.field-info[role="button"]');
      return tips.length === 1 && tips[0].textContent?.trim() === '?' && (tips[0].getAttribute('aria-label')?.length ?? 0) > 20;
    })), 'every plan detail includes one labelled question mark');
    const reviewHelp = free.getByRole('button', { name: /^Reviews up to 30 jobs\/run/ });
    await reviewHelp.scrollIntoViewIfNeeded();
    if (width <= 600) await reviewHelp.tap();
    else await reviewHelp.press('Enter');
    const tip = page.getByRole('tooltip').filter({ hasText: 'How many job listings Owtomate can check for fit' });
    await tip.waitFor({ state: 'visible' });
    assert.ok(await tip.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }), 'plan help stays inside the viewport');
    await reviewHelp.press('Escape');
    await tip.waitFor({ state: 'hidden' });
    await reviewHelp.blur();
    assert.ok(await page.locator('.pricing-features').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=13),'plan details are readable at every screen size');
    assert.ok(await page.locator('.pricing-source-brands img[src="/platforms/seek.svg"]').first().evaluate(el=>el.getBoundingClientRect().width<=48),'pricing logos stay compact');
    const ctaTops=await page.locator('.pricing-card .pricing-cta').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().top));
    if(width>=1280) {
      assert.ok(Math.max(...ctaTops)-Math.min(...ctaTops)<1,'desktop plan actions align for comparison');
      const fit=await page.evaluate(()=>({height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth,viewportHeight:innerHeight,viewportWidth:innerWidth}));
      await page.screenshot({path:resolve(dashboard,`../output/pricing-screen-fit-${width}.png`),fullPage:true});
      assert.ok(fit.height<=fit.viewportHeight&&fit.width<=fit.viewportWidth,`${width}x${height}: all plan details fit beside the sidebar: ${JSON.stringify(fit)}`);
      assert.ok(await page.locator('.pricing-grid').evaluate(el=>window.innerHeight-el.getBoundingClientRect().bottom<=20),'cards fill the available desktop height');
    }
    assert.match(await card('Essential Pass').locator('.pricing-price').innerText(),/30 days/);
    assert.equal(await page.getByRole('region',{name:'Free application offer'}).count(),0,'Plans and pricing omits the promotional banner');
    assert.equal(await card('Essential Pass').locator('button.pricing-cta').isDisabled(), true);
    assert.match(await card('Active Search').innerText(), /A\$8\.00/);
    assert.match(await card('Active Search').innerText(), /75 additional application credits/);
    assert.match(await card('Active Search').innerText(), /5 extra employer-site applications \(guest forms only\)/);
    assert.doesNotMatch(await card('Active Search').innerText(), /30 days of access/);
    assert.match(await card('Get Owtomated').innerText(), /upgrade/);
    assert.equal(await page.locator('.pricing-topup').count(),0);
    assert.doesNotMatch(await page.locator('body').innerText(),/top-up|50 more applications|Needs a pass/i);
    await card('Active Search').getByRole('button', { name: 'Upgrade to Active Search' }).click();
    await page.getByRole('status').waitFor();
    const offer = status().offers!['job-search-pass'];
    assert.deepEqual(requests, [{ planKey: 'job-search-pass', quotedAt: offer.quotedAt, sourceGrantId: offer.sourceGrantId,
      amountCents: offer.amountCents, expiresAt: offer.expiresAt }]);
    await page.waitForFunction(() => !document.querySelector('button:disabled')?.textContent?.includes('Opening'));
    assert.ok(loads >= 2, 'stale offer reloads the server price');
    active.planKey = 'job-search-pass'; active.priceCents = 3499; active.applications = 200;
    await page.reload();
    await card('Essential Pass').getByRole('button', { name: 'Lower plan unavailable' }).waitFor();
    assert.equal(await card('Essential Pass').locator('button.pricing-cta').isDisabled(), true);
    assert.equal(await card('Active Search').locator('button.pricing-cta').isDisabled(), true);
    assert.equal(await card('Get Owtomated').getByRole('button', { name: 'Upgrade to Get Owtomated' }).isEnabled(), true);
    assert.equal(await page.locator('.pricing-topup').count(),0);
    await page.goto(origin + '/pricing-fixture.html?payment=success&session_id=fixture');
    await page.getByRole('status').filter({ hasText: 'Upgraded to Active Search. Access ends' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'pricing fits mobile');
    await page.screenshot({ path: resolve(dashboard, '../output/pricing-upgrades-' + width + '.png'), fullPage: true });
    active.planKey = 'intensive-pass'; active.priceCents = 9950; active.applications = 400;
    await page.goto(origin + '/pricing-fixture.html');
    await card('Get Owtomated').getByRole('button', { name: 'Your pass is active' }).waitFor();
    assert.equal(await page.locator('.pricing-card button:not(:disabled)').count(), 0);
    assert.equal(await page.locator('.pricing-topup').count(), 0);
    if(width===1440) {
      await page.evaluate(()=>document.documentElement.dataset.theme='dark');
      await page.screenshot({path:resolve(dashboard,'../output/pricing-redesign-dark.png'),fullPage:true,animations:'disabled'});
      await page.evaluate(()=>delete document.documentElement.dataset.theme);
    }
    freePlan = true;
    await page.reload();
    await card('Essential Pass').getByRole('button',{name:'Choose Essential Pass'}).waitFor();
    assert.match(await card('Essential Pass').innerText(), /A\$19\.00[\s\S]*10 employer-site applications \(guest forms only\)/);
    assert.match(await card('Active Search').innerText(), /A\$34\.99[\s\S]*20 employer-site applications \(guest forms only\)/);
    assert.match(await card('Get Owtomated').innerText(), /A\$99\.50/);
    assert.doesNotMatch(await page.locator('body').innerText(),/top-up|50 more applications|Needs a pass/i);
    await page.goto(origin+'/landing-pricing-fixture.html');
    const publicPricing=page.locator('#pricing');await publicPricing.waitFor();
    assert.match(await publicPricing.innerText(),/5 free applications/);assert.match(await publicPricing.innerText(),/11 free applications in total/);
    for (const [index, price] of ['19.00', '34.99', '99.50'].entries()) {
      assert.ok((await publicPricing.locator('.home-price-row').nth(index + 1).innerText()).includes(`A$${price}`));
    }
    assert.doesNotMatch(await publicPricing.innerText(),/top-up|A\$6\.90|SmartRecruiters|PageUp|Web search/i);
    assert.equal(await publicPricing.locator('.home-price-row').nth(0).locator('img[src="/platforms/jora.svg"]').count(),0);
    assert.equal(await publicPricing.locator('.home-price-row').nth(1).locator('img[src="/platforms/jora.svg"]').count(),1);
    assert.equal(await publicPricing.locator('.home-price-row').nth(3).getByRole('group',{name:'Supported job sources'}).getByRole('img').count(),5,'public pricing lists the same supported sources');
    await page.waitForFunction(()=>[...document.querySelectorAll('#pricing img')].every(n=>(n as HTMLImageElement).complete&&(n as HTMLImageElement).naturalWidth>0));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'public pricing fits mobile');
    await publicPricing.screenshot({path:resolve(dashboard,'../output/public-pricing-'+width+'.png')});
    assert.deepEqual(errors, []);
    console.log('PASS pricing upgrade amount, expiry, checkout snapshot and downgrade prevention at width', width);
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
