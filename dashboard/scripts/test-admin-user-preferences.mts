/** Opens the real account drawer with fixture-only APIs. No runs, mail or model calls. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const deadline = setTimeout(() => { console.error('Admin preferences check exceeded 45 seconds.'); process.exit(1); }, 45_000);
deadline.unref();
const models:Record<string,string> = {}, runningUsers=new Set<string>();
let rejectModelSave=false;
const modelWrites:Array<{userId:string;model:string}>=[];
const user = (id: string) => ({ id, email: `candidate${id}@example.test`, name: `Candidate ${id}`, avatarUrl: null,
  createdAt: '2026-10-30T00:00:00Z', lastLoginAt: null, blockedAt: null, admin: false, plan: 'Free',
  allowance: { freeRemaining: 5, paidRemaining: 0, paidExpiresAt: null }, setupMissing: [], emailedAt: null, resumes: 1,
  boards: { seek: true, indeed: null }, autoApply: { runsPerDay: 1, usedToday: 0, paused: true, canPause: true, nextRunAt: null, applicationMode: 'auto' },
  overrides: { evaluationsPerRun: null, maxApplicationsPerRun: null }, route: { homePort: null, proxy: null, pooled: null, status: { exitOnline: false, exitProblem: null } },
  applications: { total: id === '1' ? 13 : 0, week: 0, today: 0, preparedTotal: id === '1' ? 27 : 0 }, lastRun: null, running: runningUsers.has(id), signingIn: false,
  applicationModel:models[id]??'celeris',
});
const prompt = 'Only education roles.\nPreserve my exact instructions.\n<script>window.injected=true</script>\n' + 'A'.repeat(1200);
const preferences = [
  { title: 'Search preferences', fields: [ { label: 'Search keywords', value: 'Student services officer, Office all-rounder' },
    { label: 'Companies to avoid', value: 'Fixture Employer' }, { label: 'Office city', value: 'Wollongong' },
    { label: 'Minimum match', value: '60%', note: 'Saved preference: 75%. The value above is used for scheduled runs.' } ] },
  { title: 'Custom instructions', fields: [{ label: 'Run instructions', value: prompt }] },
  { title: 'Cover letter preferences', fields: [{ label: 'Cover letter instructions', value: 'Keep it concise.' }] },
  { title: 'Profile details', fields: [{ label: 'Home suburb', value: 'Robertson' }, { label: 'Application email', value: 'candidate1@example.test' }] },
  { title: 'Saved application answers', fields: [{ label: 'Weekend availability', value: 'Saturday and Sunday' }] },
];
const html = '<!doctype html><html><body><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{AdminPanel}from"/src/components/AdminPanel.tsx";import"/src/index.css";createRoot(document.getElementById("root")).render(React.createElement(AdminPanel));</script></body></html>';
const vite = await createServer({ configFile: false, root: resolve(import.meta.dirname, '..'), plugins: [react(), {
  name: 'admin-preferences-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (req.url !== '/preferences-fixture.html') return next();
    res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, html));
  }); },
}], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen(); const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } }); page.setDefaultTimeout(5000);
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const modelOwner=url.pathname.match(/^\/api\/admin\/users\/(\d+)\/application-model$/)?.[1];
    if(request.method()==='POST'&&modelOwner){
      const model=request.postDataJSON().model as string;modelWrites.push({userId:modelOwner,model});
      if(rejectModelSave)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture save failed.'})});
      models[modelOwner]=model;
      return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,user:user(modelOwner)})});
    }
    if (request.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
    const id = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/)?.[1];
    const body = url.pathname === '/api/admin/users' ? [user('1'), user('2')]
      : id ? { ...user(id), passes: [], runs: [], recentApplications: [], preferences: id === '1' ? preferences
        : [{ title: 'Custom instructions', fields: [{ label: 'Run instructions', value: 'None' }] }, { title: 'Saved application answers', fields: [] }] }
      : { users: { total: 2, newThisWeek: 2, activeThisWeek: 0 }, passes: { essential: 0, jobSearch: 0, intensive: 0 },
        today: { runs: 0, applications: 0, failedRuns: 0 }, week: { applications: 0 }, revenueCents: { total: 0, last30Days: 0 },
        capacity: { running: 0, lanes: 3 }, redditCapi: { configured: false, accepted: 0, rejected: 0, failed: 0 }, recentRuns: [] };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${origin}/preferences-fixture.html`);
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  const applications = page.getByRole('row').filter({ hasText: 'candidate1@example.test' }).getByRole('cell').nth(6);
  assert.match(await applications.innerText(), /13 submitted\s+27 prepared total\s+0 submitted today/);
  await page.getByText('0 prepared total', { exact: true }).waitFor();
  await page.getByText('candidate1@example.test', { exact: true }).click();
  const drawer = page.locator('.admin-drawer');
  await drawer.getByRole('heading', { name: 'Search preferences', exact: true }).waitFor();
  assert.equal(await drawer.locator('dt').filter({ hasText: /^Applications prepared$/ }).evaluate(element => element.nextElementSibling?.textContent), '27 total');
  assert.match(await drawer.innerText(), /Fixture Employer/);
  assert.match(await drawer.innerText(), /Saved preference: 75%/);
  assert.equal(await drawer.getByRole('region', { name: 'Custom instructions' }).locator('dd').textContent(), prompt);
  assert.equal(await page.evaluate(() => (window as unknown as Record<string, unknown>).injected), undefined);
  assert.match(await drawer.getByRole('region', { name: 'Profile details' }).innerText(), /Robertson/);
  assert.match(await drawer.getByRole('region', { name: 'Saved application answers' }).innerText(), /Saturday and Sunday/);
  const dir = resolve(import.meta.dirname, '../../output/admin-user-preferences'); mkdirSync(dir, { recursive: true });
  await drawer.getByRole('heading', { name: 'Search preferences', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(dir, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await drawer.getByRole('region', { name: 'Custom instructions' }).locator('dd').evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth }));
  assert.ok(bounds.scroll <= bounds.width + 1, 'long instructions must wrap on mobile');
  await drawer.getByRole('heading', { name: 'Search preferences', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(dir, 'mobile.png') });
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByText('candidate2@example.test', { exact: true }).click();
  await drawer.getByRole('region', { name: 'Saved application answers' }).getByText('None saved.', { exact: true }).waitFor();
  assert.equal(await drawer.getByText('Fixture Employer', { exact: true }).count(), 0, 'switching accounts must not retain the previous preferences');
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  const picker=drawer.getByLabel('Future run model');
  assert.equal(await picker.inputValue(),'celeris');
  await picker.selectOption('minimax');await drawer.getByRole('button',{name:'Save model',exact:true}).click();
  await drawer.getByText('Future run model saved.',{exact:true}).waitFor();
  await drawer.getByRole('button',{name:'Save model',exact:true}).isDisabled().then(value=>assert.equal(value,true));
  await drawer.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByText('candidate2@example.test',{exact:true}).click();
  await picker.waitFor();assert.equal(await picker.inputValue(),'minimax','saved choice reloads from the server');
  await drawer.getByRole('button',{name:'Close',exact:true}).click();
  runningUsers.add('1');await page.getByText('candidate1@example.test',{exact:true}).click();
  await picker.waitFor();assert.equal(await picker.inputValue(),'celeris','another account retains its model');
  rejectModelSave=true;await picker.selectOption('minimax');
  await drawer.getByRole('button',{name:'Save model',exact:true}).click();
  await drawer.getByText('Fixture save failed.',{exact:true}).waitFor();
  await drawer.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByText('candidate1@example.test',{exact:true}).click();
  await picker.waitFor();assert.equal(await picker.inputValue(),'celeris','failed saves cannot persist an optimistic model');
  rejectModelSave=false;await picker.selectOption('minimax');
  await drawer.getByRole('button',{name:'Save model',exact:true}).click();
  await drawer.getByText('Future run model saved.',{exact:true}).waitFor();
  assert.equal(await drawer.getByRole('button',{name:'Stop run',exact:true}).count(),1,'future choice can be saved while a current run stays active');
  await drawer.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByText('candidate2@example.test',{exact:true}).click();await picker.waitFor();
  await picker.selectOption('celeris');await drawer.getByRole('button',{name:'Save model',exact:true}).click();
  await drawer.getByText('Future run model saved.',{exact:true}).waitFor();
  assert.equal(await picker.inputValue(),'celeris');
  const modelBounds=await picker.evaluate(element=>({right:element.getBoundingClientRect().right,width:window.innerWidth}));
  assert.ok(modelBounds.right<=modelBounds.width,'model control fits on mobile');
  await picker.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(dir,'model-control-mobile.png')});
  assert.deepEqual(modelWrites,[{userId:'2',model:'minimax'},{userId:'1',model:'minimax'},{userId:'1',model:'minimax'},{userId:'2',model:'celeris'}]);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[],'model saves must not trigger runs, stops, email or other writes');
  console.log('PASS: real admin drawer preferences and future-model control, MiniMax/Celeris saves, persistence, account isolation, failure recovery, active-run preservation and mobile layout; fixture APIs only, no runs or external calls.');
} finally { await browser?.close(); await vite.close(); clearTimeout(deadline); }
