/** Real customer React components with fictional APIs; no live account or application writes. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const root = resolve(import.meta.dirname, '..'), output = resolve(root, '../output/jora-beta');
let settings: Record<string, string> = { PLATFORMS: 'seek', JORA_BETA_ENABLED: 'false', KEYWORDS: 'data analyst', MIN_SALARY: '100000', MAX_AGE_DAYS: '10', ONSITE_CITY: 'Sydney' };
const writes: Array<{ path: string; body: any }> = [];
let joraConnected = false;
let signinSession: any = null;
let tier: 'standard' | 'intensive' | 'admin' = 'standard';
const html = `<!doctype html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module">
import React from 'react';import{createRoot}from'react-dom/client';import App from '/src/App.tsx';import'/src/index.css';
createRoot(document.getElementById('root')).render(React.createElement(App));</script></body></html>`;
const server = await createServer({ configFile: false, root, plugins: [react(), { name: 'jora-beta-fixture', configureServer(app) {
  app.middlewares.use(async (req, res, next) => {
    const path = req.url?.split('?')[0];
    if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(await app.transformIndexHtml('/', html)); return; }
    if (!path?.startsWith('/api/')) return next();
    if (path === '/api/run/stream') { res.statusCode = 204; res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.method !== 'GET') writes.push({ path, body: JSON.parse(body || '{}') });
    if (path === '/api/settings' && req.method === 'POST') settings = { ...settings, ...JSON.parse(body).updates };
    if (path === '/api/signin/session' && req.method === 'POST') signinSession = {id:'fictional-session',display:100,password:'fictional',target:'jora',state:'starting',startedAt:Date.now(),expiresAt:Date.now()+600000};
    if (path === '/api/signin/session' && req.method === 'DELETE') { signinSession = null; joraConnected = !req.url?.includes('cancel=true'); }
    const payloads: Record<string, unknown> = {
      '/api/auth/me': { user: {id:'fictional-owner',email:'fixture@example.invalid',name:'Fictional Candidate'}, googleConfigured:true },
      '/api/applications': [], '/api/run/last': {startedAt:null}, '/api/today':{runs:0,reviewed:0,submitted:0},
      '/api/settings': req.method === 'POST' ? { ok: true, settings } : settings,
      '/api/entitlements': { tier, manualRuns: true, firstRunRequired: false, autoRunsPerDay: 1, autoApplyPaused: true, canPauseAutoApply: true,
        autoRunsUsedToday: 0, scheduledMinScore: 60, scheduledJobsPerDay: 40, evaluationsPerRun: 40, maxApplicationsPerRunOverride: null,
        fineTune: tier !== 'standard', advancedFilters: tier !== 'standard', indeedApplications: tier !== 'standard', employerSources: tier !== 'standard', runScopes: false },
      '/api/billing/status': { configured: true, totalRemaining: 5, free: { allowance: 5, used: 0, remaining: 5 }, paid: { remaining: 0, hasActivePass: false } },
      '/api/setup/status': { ready: true, done: 3, total: 3, checks: ['resume', 'profile', 'looking'].map(id => ({ id, label: id, done: true, required: true })) },
      '/api/run/status': { running: false, hasKey: true, isOwner: true, applied: 0 },
      '/api/signin/session': { supported: true, session: signinSession, seek: { signedIn: false }, indeed: { signedIn: false }, jora: joraConnected ? {signedIn:true,checkedAt:new Date().toISOString()} : null, joraVerified:joraConnected },
      '/api/auto-schedule': { enabled: false, applicationMode: 'auto', runsUsedToday: 0, runsPerDay: 1, nextRunAt: null, timeZone: 'Australia/Sydney', waitingForSetup: false },
      '/api/board-resumes': { boards: [] }, '/api/gmail/status': { connected: false },
      '/api/application-reviews': { applications: [] }, '/api/skipped': { items: [] }, '/api/attention': [], '/api/admin/simulations': { simulations: [] },
      '/api/bonus-runs': { runs: [] },
    };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payloads[path] ?? {}));
  });
} }], server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '..')] } }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  mkdirSync(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  for (tier of ['standard', 'intensive', 'admin'] as const) {
    settings.JORA_BETA_ENABLED = 'false'; settings.PLATFORMS = 'seek'; writes.length = 0; joraConnected = false;
    await page.goto(origin);
    const jora = page.getByRole('checkbox', { name: 'Include Jora Beta' }); await jora.waitFor();
    assert.equal(await jora.isChecked(), false, 'Jora is available without silently opting anyone in');
    assert.equal(await page.getByText('Find more jobs across other websites.', {exact:false}).count(), 0);
    assert.equal(await page.getByRole('button', {name:'Sign in to Jora (optional)',exact:true}).count(), 0, 'sign-in moved off the run panel');
    await jora.check();
    await page.getByRole('button', {name:'Save changes',exact:true}).click();
    await page.getByText('Saved. Your next run will use this.').waitFor();
    const updates = writes.find(write => write.path === '/api/settings')!.body.updates;
    assert.equal(updates.JORA_BETA_ENABLED, 'true'); assert.equal(updates.PLATFORMS, undefined);
    assert.equal(settings.PLATFORMS, 'seek'); assert.equal(settings.MIN_SALARY, '100000'); assert.equal(settings.MAX_AGE_DAYS, '10');
    const start = page.getByRole('button',{name:'Start Auto apply',exact:true});
    await start.waitFor(); assert.equal(await start.isEnabled(), true, 'public Jora search needs no board login');
    const sidebar = page.getByRole('button',{name:'Job boards: which account is signed in, sign out, sign in.',exact:true});
    assert.match(await sidebar.innerText(), /SEEK.*Indeed.*Jora/);
    await sidebar.click();
    let dialog = page.getByRole('dialog',{name:'Job boards',exact:true});
    let row = dialog.locator('.boards-row').filter({has:page.getByText('Jora',{exact:true})});
    await row.getByRole('button',{name:'Sign in',exact:true}).click();
    const signIn = page.getByRole('dialog',{name:'Browser sign-in',exact:true}); await signIn.waitFor();
    assert.deepEqual(writes.find(write=>write.path==='/api/signin/session')!.body,{target:'jora',manual:true});
    await signIn.getByRole('button',{name:'Done',exact:true}).click();
    await sidebar.click(); dialog=page.getByRole('dialog',{name:'Job boards',exact:true});
    row=dialog.locator('.boards-row').filter({has:page.getByText('Jora',{exact:true})});
    await row.getByRole('button',{name:'Manage sign-in',exact:true}).waitFor();
    if(tier==='standard') {
      await page.screenshot({path:resolve(output,'desktop.png'),fullPage:true,animations:'disabled'});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true,animations:'disabled'});
      await page.setViewportSize({width:1280,height:1000});
    }
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    await page.reload(); await page.getByRole('checkbox',{name:'Include Jora Beta',checked:true}).waitFor();
    await sidebar.click(); dialog=page.getByRole('dialog',{name:'Job boards',exact:true});
    await dialog.locator('.boards-row').filter({has:page.getByText('Jora',{exact:true})}).getByRole('button',{name:'Manage sign-in',exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    assert.equal(writes.some(write=>['/api/run','/api/auto-apply'].includes(write.path)),false,'fixture never starts a real run');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['all customer plans and admins can opt in', 'preferences preserved', 'no Jora login needed for search', 'removed explanatory text', 'sidebar Jora sign-in and connection state', 'Done and reload preserve connection', 'desktop/mobile layout'], output }));
} finally { await browser.close(); await server.close(); }
