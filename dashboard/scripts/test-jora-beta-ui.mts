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
let paidStandard=false;
let activeStandard=false;
let seekConnected=true;
let failEmployerSave=false;
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
    if(path==='/api/settings'&&req.method==='POST'&&JSON.parse(body).updates?.EMPLOYER_APPLICATIONS_ENABLED!==undefined&&failEmployerSave){res.statusCode=503;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:'Fixture save failed. Your preference was not changed.'}));return;}
    if (path === '/api/settings' && req.method === 'POST') settings = { ...settings, ...JSON.parse(body).updates };
    if (path === '/api/signin/session' && req.method === 'POST') signinSession = {id:'fictional-session',display:100,password:'fictional',target:'jora',state:'starting',startedAt:Date.now(),expiresAt:Date.now()+600000};
    if (path === '/api/signin/session' && req.method === 'DELETE') { signinSession = null; joraConnected = !req.url?.includes('cancel=true'); }
    const payloads: Record<string, unknown> = {
      '/api/auth/me': { user: {id:'fictional-owner',email:'fixture@example.invalid',name:'Fictional Candidate'}, googleConfigured:true },
      '/api/applications': [], '/api/run/last': {startedAt:null}, '/api/today':{runs:0,reviewed:0,submitted:0},
      '/api/settings': req.method === 'POST' ? { ok: true, settings } : settings,
      '/api/entitlements': { tier, manualRuns: true, firstRunRequired: false, autoRunsPerDay: 1, autoApplyPaused: true, canPauseAutoApply: true,
        autoRunsUsedToday: 0, scheduledMinScore: 60, scheduledJobsPerDay: 40, evaluationsPerRun: 40, maxApplicationsPerRunOverride: null,
        fineTune: tier !== 'standard', advancedFilters: tier !== 'standard'||activeStandard, indeedApplications: tier !== 'standard'||activeStandard||paidStandard, employerSources: tier !== 'standard'||activeStandard||paidStandard, runScopes: false, joraSignIn:tier!=='standard'||activeStandard||paidStandard },
      '/api/billing/status': { configured: true, totalRemaining: paidStandard||activeStandard||tier==='intensive'?55:5, free: { allowance: 5, used: 0, remaining: 5 }, paid: { remaining: paidStandard||activeStandard||tier==='intensive'?50:0, hasActivePass: paidStandard||activeStandard||tier==='intensive', hasActiveEssentialPass:paidStandard,hasActiveIntensivePass:tier==='intensive',hasActiveJobSearchPass:activeStandard } },
      '/api/setup/status': { ready: true, done: 3, total: 3, checks: ['resume', 'profile', 'looking'].map(id => ({ id, label: id, done: true, required: true })) },
      '/api/run/status': { running: false, hasKey: true, isOwner: true, applied: 0 },
      '/api/signin/session': { supported: true, session: signinSession, seek: { signedIn: seekConnected }, indeed: { signedIn: false }, jora: joraConnected ? {signedIn:true,checkedAt:new Date().toISOString()} : null, joraVerified:joraConnected,employerApplicationsEnabled:settings.EMPLOYER_APPLICATIONS_ENABLED!=='false' },
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
async function checkJobSourcesLayout(sidebar: import('../../seek-bot/node_modules/patchright/index.js').Locator) {
  const layout = await sidebar.evaluate(el => {
    const tiles = [...el.querySelectorAll('.nav-board-brand')].map(tile => {
      const { x, y } = tile.getBoundingClientRect();
      return { x, y };
    });
    const legible = [...el.querySelectorAll('.nav-board-brands img')].every(img => {
      const { width, height } = img.getBoundingClientRect();
      return width >= 48 && height >= 20;
    });
    const employer = el.querySelector('.nav-employer-sites')!;
    const label = employer.querySelector('.employer-sites-label')!.getBoundingClientRect();
    const status = employer.querySelector('.nav-dot')!.getBoundingClientRect();
    return { tiles, legible, labelFits: label.right <= status.left, fits: el.scrollWidth <= el.clientWidth,
      height: el.getBoundingClientRect().height };
  });
  assert.equal(layout.tiles.length, 4);
  const [topLeft, topRight, bottomLeft, bottomRight] = layout.tiles;
  assert.ok(topLeft.y === topRight.y && bottomLeft.y === bottomRight.y && topLeft.y < bottomLeft.y,
    'All four sources share a two-row grid');
  assert.ok(topLeft.x === bottomLeft.x && topRight.x === bottomRight.x && topLeft.x < topRight.x,
    'Employer sites aligns with the board tiles');
  assert.ok(layout.labelFits && layout.fits && layout.height <= 105, 'Sources fit without clipping the employer label');
  assert.ok(layout.legible, 'Board logos stay legible');
}
async function employerPreference(page:import('../../seek-bot/node_modules/patchright/index.js').Page){
  const sourceButton=()=>page.getByRole('button',{name:'Job sources: manage connections and employer-site applications.',exact:true});
  const sourceDialog=()=>page.getByRole('dialog',{name:'Job sources',exact:true});
  const toggle=()=>sourceDialog().getByRole('switch',{name:'Employer-site applications',exact:true});
  const before={...settings};let n=writes.length;
  await toggle().click();let confirmation=page.getByRole('alertdialog',{name:'Turn off employer-site applications?',exact:true});await confirmation.waitFor();assert.match(await confirmation.innerText(),/Future runs/);
  if(activeStandard)await page.screenshot({path:resolve(output,'employer-confirmation.png'),fullPage:true,animations:'disabled'});
  assert.equal(writes.length,n,'asking for confirmation does not save');await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await toggle().getAttribute('aria-checked'),'true');
  await toggle().click();await page.getByRole('alertdialog').getByRole('button',{name:'Turn off employer sites',exact:true}).click();await toggle().filter({hasText:'Off'}).waitFor();
  assert.deepEqual(writes[n],{path:'/api/settings',body:{updates:{EMPLOYER_APPLICATIONS_ENABLED:'false'}}});assert.deepEqual(settings,{...before,EMPLOYER_APPLICATIONS_ENABLED:'false'},'no other preferences changed');
  await sourceDialog().getByRole('button',{name:'Close',exact:true}).click();await page.locator('.nav-employer-sites .nav-dot.off').waitFor();
  await page.reload();await sourceButton().waitFor();await sourceButton().click();await toggle().filter({hasText:'Off'}).waitFor();
  failEmployerSave=true;await toggle().click();await sourceDialog().getByText('Fixture save failed. Your preference was not changed.',{exact:true}).waitFor();assert.equal(await toggle().getAttribute('aria-checked'),'false');assert.equal(settings.EMPLOYER_APPLICATIONS_ENABLED,'false');
  failEmployerSave=false;await toggle().click();await toggle().filter({hasText:'On'}).waitFor();assert.equal(settings.EMPLOYER_APPLICATIONS_ENABLED,'true');
}
try {
  mkdirSync(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }); page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  for (const plan of ['free','essential','active','intensive','admin'] as const) {
    tier=plan==='free'||plan==='essential'||plan==='active'?'standard':plan;paidStandard=plan==='essential';activeStandard=plan==='active';seekConnected=true;
    settings.JORA_BETA_ENABLED = 'false'; settings.PLATFORMS = 'seek';settings.EMPLOYER_APPLICATIONS_ENABLED='true'; writes.length = 0; joraConnected = false;
    await page.goto(origin);
    await page.getByText('data analyst',{exact:true}).waitFor();
    assert.equal(await page.getByRole('checkbox', {name:'Include Jora Beta'}).count(),0,'the extra checkbox is removed');
    assert.equal(await page.getByText('Find more jobs across other websites.', {exact:false}).count(), 0);
    assert.equal(await page.getByRole('button', {name:'Sign in to Jora (optional)',exact:true}).count(), 0, 'sign-in moved off the run panel');
    await page.getByRole('button',{name:'Start Auto apply',exact:true}).click();
    const review=page.getByRole('dialog',{name:'Review Auto apply settings',exact:true});
    if(plan==='free') {
      assert.equal(await review.getByRole('button',{name:'Jora (Beta)',exact:true}).count(),0,'Free has no Jora control');
      await review.getByRole('button',{name:'Cancel',exact:true}).click();
      const sidebar=page.getByRole('button',{name:'Job sources: manage connections and employer-site applications.',exact:true});
      assert.equal(await sidebar.getByRole('img',{name:'Jora',exact:true}).count(),0);
      await sidebar.click();
      const dialog=page.getByRole('dialog',{name:'Job sources',exact:true});
      assert.equal(await dialog.getByRole('img',{name:'Jora',exact:true}).count(),0,'Jora connection stays hidden even with a saved session');
      await employerPreference(page);
      await dialog.getByRole('button',{name:'Close',exact:true}).click();
      joraConnected=true;settings.JORA_BETA_ENABLED='true';await page.reload();await page.getByText('data analyst',{exact:true}).waitFor();
      await sidebar.click();assert.equal(await page.getByRole('dialog',{name:'Job sources',exact:true}).getByRole('img',{name:'Jora',exact:true}).count(),0);
      assert.equal(writes.some(w=>w.path==='/api/signin/session'),false);
      continue;
    }
    await review.getByRole('button',{name:'Jora (Beta)',exact:true}).click();
    await review.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button', {name:'Save changes',exact:true}).click();
    await page.getByText('Saved. Your next run will use this.').waitFor();
    const updates = writes.find(write => write.path === '/api/settings')!.body.updates;
    assert.equal(updates.JORA_BETA_ENABLED, 'true'); assert.equal(updates.PLATFORMS, undefined);
    assert.equal(settings.PLATFORMS, 'seek'); assert.equal(settings.MIN_SALARY, '100000'); assert.equal(settings.MAX_AGE_DAYS, '10');
    const start = page.getByRole('button',{name:'Start Auto apply',exact:true});
    await start.waitFor(); assert.equal(await start.isEnabled(), true, 'public Jora search needs no board login');
    const sidebar = page.getByRole('button',{name:'Job sources: manage connections and employer-site applications.',exact:true});
    assert.equal((await sidebar.locator('.nav-board-brands').innerText()).trim(),'Employer sites','Sidebar names employer sites and uses board logos');
    for(const name of ['SEEK','Indeed','Jora'])assert.equal(await sidebar.getByRole('img',{name,exact:true}).count(),1,'Logo retains its accessible name');
    for(const board of ['seek','indeed','jora'])assert.equal(await sidebar.locator(`img[src="/platforms/${board}.svg"]`).count(),1);
    await page.waitForFunction(()=>[...document.querySelectorAll('.nav-board-brands img')].every(n=>(n as HTMLImageElement).complete&&(n as HTMLImageElement).naturalWidth>0));
    await checkJobSourcesLayout(sidebar);
    if(plan==='active')await sidebar.screenshot({path:resolve(output,'compact-sources-desktop.png'),animations:'disabled'});
    await sidebar.click();
    let dialog = page.getByRole('dialog',{name:'Job sources',exact:true});
    let row = dialog.locator('.boards-row').filter({has:page.getByRole('img',{name:'Jora',exact:true})});
    await row.getByRole('button',{name:'Sign in',exact:true}).click();
    const signIn = page.getByRole('dialog',{name:'Browser sign-in',exact:true}); await signIn.waitFor();
    assert.deepEqual(writes.find(write=>write.path==='/api/signin/session')!.body,{target:'jora',manual:true});
    await signIn.getByRole('button',{name:'Done',exact:true}).click();
    await sidebar.click(); dialog=page.getByRole('dialog',{name:'Job sources',exact:true});
    row=dialog.locator('.boards-row').filter({has:page.getByRole('img',{name:'Jora',exact:true})});
    await row.getByRole('button',{name:'Manage sign-in',exact:true}).waitFor();
    await employerPreference(page);
    if(plan==='active') {
      await page.screenshot({path:resolve(output,'desktop.png'),fullPage:true,animations:'disabled'});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true,animations:'disabled'});
      await page.setViewportSize({width:1280,height:1000});
    }
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    if(plan==='active') {
      await page.setViewportSize({width:390,height:844});
      await page.getByRole('button',{name:'Menu',exact:true}).click();
      assert.ok(await sidebar.isVisible());
      await checkJobSourcesLayout(sidebar);
      await sidebar.screenshot({path:resolve(output,'compact-sources-mobile.png'),animations:'disabled'});
      await page.getByRole('button',{name:'Close menu',exact:true}).click();
      await page.setViewportSize({width:1280,height:1000});
    }
    await page.reload(); await page.getByText('data analyst',{exact:true}).waitFor();
    assert.equal(settings.JORA_BETA_ENABLED,'true');
    assert.equal(await page.getByRole('checkbox',{name:'Include Jora Beta'}).count(),0);
    await sidebar.click(); dialog=page.getByRole('dialog',{name:'Job sources',exact:true});
    await dialog.locator('.boards-row').filter({has:page.getByRole('img',{name:'Jora',exact:true})}).getByRole('button',{name:'Manage sign-in',exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    assert.equal(writes.some(write=>['/api/run','/api/auto-apply'].includes(write.path)),false,'fixture never starts a real run');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['Jora connections available on every paid plan and for admins', 'Free keeps its existing connections', 'preferences preserved', 'Jora source selection stays in run review', 'removed explanatory text', 'sidebar Jora sign-in and connection state', 'Done and reload preserve connection', 'desktop/mobile layout'], output }));
} finally { await browser.close(); await server.close(); }
