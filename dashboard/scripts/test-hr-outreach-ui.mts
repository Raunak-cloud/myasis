/** Real dashboard components, fictional APIs only. No mail, accounts or database writes. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const now = new Date().toISOString();
const sourceFixtures=[
  {source:'pageup',name:'PageUp',url:'https://careers.pageuppeople.com/841/cw/en/job/123/fixture'},
  {source:'workday',name:'Workday',url:'https://fixture.wd3.myworkdayjobs.com/en-US/Careers/job/123'},
  {source:'greenhouse',name:'Greenhouse',url:'https://job-boards.greenhouse.io/fixture/jobs/123'},
  {source:'smartrecruiters',name:'SmartRecruiters',url:'https://jobs.smartrecruiters.com/Fixture/123'},
  {source:'jora',name:'Jora',url:'https://au.jora.com/job/fixture'},
];
const apps = [{ jobId: 'one', platform: 'seek', title: 'Data Analyst', company: 'Fixture Employer', location: 'Sydney', url: 'https://fixture.invalid/job', appliedAt: now, score: 90 },
  { jobId: 'one', platform: 'indeed', title: 'Different employer role', company: 'Another Employer', location: 'Sydney', url: 'https://fixture.invalid/another', appliedAt: now, score: 80 },
  { jobId: 'archived', platform: 'external', title: 'Archived application', company: 'Historical Employer', location: 'Sydney', url: 'https://fixture.invalid/old', appliedAt: now, score: 85 },
  ...sourceFixtures.map(item=>({jobId:item.source,platform:'external',title:`${item.name} application`,company:'Fixture Employer',location:'Sydney',url:item.url,appliedAt:now,score:85,external:true})),
  {jobId:'unrecognised',platform:'external',title:'Direct employer application',company:'Fixture Employer',location:'Sydney',url:'https://myworkdayjobs.com.fixture.invalid/job',appliedAt:now,score:85}];
const literal = '<img src=x onerror="window.fixtureInjected=true">\nThanks for considering my application.\n' + 'Long factual candidate message. '.repeat(25);
const items = ['sent', 'queued', 'researching', 'sending', 'skipped', 'error', 'unconfirmed'].map((status, i) => ({ id: String(100 - i), jobId: i ? 'other' : 'one', platform: 'seek', title: i ? `Fixture role ${i}` : 'Data Analyst', company: 'Fixture Employer', status,
  toEmail: i ? null : 'hiring@example.test', subject: i ? null : 'My Data Analyst application', body: i ? null : literal, createdAt: now, sentAt: i ? null : now, contactName: i ? null : 'Hiring team',
  sourceUrl: i === 1 ? 'javascript:alert(1)' : i ? null : 'https://fixture.invalid/careers', reason: status === 'skipped' ? 'No public hiring contact was found.' : null, phase: null as string | null, sourceRunId: '42' }));
// undefined uses historical data, null represents a role with no follow-up yet.
type FixtureEmail = typeof items[number] & {
  lookupOutcome?: string;
  lookupRetryAt?: string | null;
  deliveryStatus?: string;
  checkingDelivery?: boolean;
};
let liveEmail: FixtureEmail | null | undefined;
const olderItems = [{ ...items[0], id: '93', jobId: 'old-history', title: 'Older outreach role', subject: 'An older introduction' },
  { ...items[0], id: '1', jobId: 'archived', platform: 'external', title: 'Archived application', company: 'Historical Employer', subject: 'My archived application', body: 'Exact historical email body.' }];
let enabled = false, failSave = false, failHistory = false, failSettings = false, emptyHistory = false, failOlder = false;
const progress = { active: false, phase: 'finished', title: null, company: null, queued: 0, sent: 5, skipped: 0, failed: 0, runId: '42' };
let reportingMode = false;
const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString(), retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
const sourceObservedAt = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
const reportBase = { ...items[0], toEmail: null, subject: null, body: null, sentAt: null, reason: null, sourceUrl: 'https://fixture.invalid/careers', contactName: null, phase: null, lookupCheckedAt: checkedAt, lookupRetryAt: null };
const reportingItems: Array<typeof items[number] & { lookupOutcome?: string; lookupCheckedAt?: string; lookupRetryAt?: string | null; contactReviewRequired?: boolean; contactReviewReason?: string; sourceKind?: string; sourceCheckedAt?: string; deliveryStatus?: string; deliveryReason?: string; deliveryCheckedAt?: string; deliveryFailedAt?: string; outreachAttempt?: number; retryOfId?: string; diagnostics?: unknown }> = [
  { ...reportBase, id: '210', title: 'No public contact role', status: 'skipped', lookupOutcome: 'no_contact' },
  { ...reportBase, id: '209', title: 'Unverified company role', status: 'skipped', lookupOutcome: 'company_unverified' },
  { ...reportBase, id: '208', title: 'Blocked source role', status: 'error', lookupOutcome: 'access_blocked', lookupRetryAt: retryAt },
  { ...reportBase, id: '207', title: 'Provider interruption role', status: 'error', lookupOutcome: 'temporarily_unavailable', lookupRetryAt: retryAt },
  { ...reportBase, id: '206', title: 'Incomplete lookup role', status: 'error', lookupOutcome: 'incomplete', lookupRetryAt: retryAt },
  { ...reportBase, id: '205', title: 'Exhausted lookup role', status: 'error', lookupOutcome: 'incomplete' },
  { ...reportBase, id: '211', title: 'Unconfirmed delivery role', status: 'unconfirmed', lookupOutcome: 'found', lookupRetryAt: retryAt, reason: 'Delivery needs checking. The email will not be sent again automatically.' },
  { ...items[0], id: '204', title: 'MKA historical role', company: 'MKA IT Services Pty LTD', toEmail: 'hello@freehire.me', subject: 'Exact historical subject', body: 'Exact historical message already sent.', sourceUrl: 'https://freehire.me/talent', contactName: null,
    lookupOutcome: 'found', lookupCheckedAt: checkedAt, lookupRetryAt: null, contactReviewRequired: true, contactReviewReason: 'The email was sent to a platform address. Its connection to this employer’s hiring team has not been verified.', diagnostics: { internalOnly: 'selector:secret model:private stack:internal' } },
  { ...items[0], id: '203', title: 'FiftyFive historical role', company: 'FiftyFive Group Pty Ltd', toEmail: 'hello@freehire.me', sourceUrl: 'https://freehire.me/talent', contactReviewRequired: true, contactReviewReason: 'This platform contact has not been verified as the employer’s hiring contact.' },
  { ...items[0], id: '202', title: 'Lanson software role', company: 'Lanson Partners', toEmail: 'josh@lansonpartners.com', contactReviewRequired: true, contactReviewReason: 'The public contact covers finance recruitment. Relevance to this software role needs review.' },
  { ...items[0], id: '201', title: 'Verified hiring contact role', contactReviewRequired: false, lookupOutcome: 'found', lookupCheckedAt: checkedAt, lookupRetryAt: null },
  { ...items[0], id: '200', title: 'Saved advertisement contact role', contactName: null, sourceKind: 'stored_vacancy', sourceCheckedAt: sourceObservedAt, lookupCheckedAt: checkedAt, lookupOutcome: 'found', lookupRetryAt: null },
  { ...items[0], id: '199', title: 'Indexed contact role', sourceKind: 'indexed_excerpt', sourceCheckedAt: sourceObservedAt, lookupCheckedAt: checkedAt, lookupOutcome: 'found', lookupRetryAt: null },
  { ...items[0], id: '198', title: 'Current page contact role', sourceKind: 'public_page', sourceCheckedAt: sourceObservedAt, lookupCheckedAt: checkedAt, lookupOutcome: 'found', lookupRetryAt: null },
  { ...items[0], id: '197', title: 'HCL Software Engineer', company: 'HCLTech', contactName: null, toEmail: 'invalid-recruiter@hcl.example.test', subject: 'Exact original HCL subject', body: literal,
    deliveryStatus: 'bounced', deliveryReason: 'The recipient address does not exist. <img src=x onerror="window.fixtureInjected=true">', deliveryCheckedAt: checkedAt, deliveryFailedAt: checkedAt },
  { ...items[0], id: '196', title: 'HCL Software Engineer', company: 'HCLTech', contactName: null, toEmail: 'verified-recruitment@hcl.example.test', subject: 'Alternative contact subject', body: 'Exact alternative-contact email.', deliveryStatus: 'unknown', deliveryCheckedAt: checkedAt, outreachAttempt: 2, retryOfId: '197' },
  { ...items[0], id: '195', title: 'Temporarily delayed contact role', deliveryStatus: 'unknown', deliveryReason: 'The receiving mail service temporarily delayed this email.', deliveryCheckedAt: checkedAt },
];
let runAdmin = true, setupReady = true;
const writes: unknown[] = [];
const html = `<!doctype html><html><body><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{ApplicationsPanel}from'/src/components/ApplicationsPanel.tsx';import'/src/index.css';const mode=new URLSearchParams(location.search).get('hr');createRoot(document.getElementById('root')).render(React.createElement(ApplicationsPanel,{apps:${JSON.stringify(apps)},onChange:()=>{},followUpDays:10,...(mode==='default'?{}:{showHrOutreach:mode!=='off'})}));</script></body></html>`;
const liveHtml = `<!doctype html><html><body><main class="main-shell run-dashboard"><header class="page-header"><h1>Apply for jobs</h1></header><div id="root" class="page-content"></div></main><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{RunPanel}from'/src/components/RunPanel.tsx';import'/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(RunPanel,{lastRunAt:null,onFinished:()=>{},onGoPricing:()=>{}}));</script></body></html>`;
const shellHtml = `<!doctype html><html><body><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import App from'/src/App.tsx';import'/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(App));</script></body></html>`;
const vite = await createServer({ configFile: false, root: resolve(import.meta.dirname, '..'), plugins: [react(), { name: 'hr-outreach-fixture', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url?.split('?')[0] === '/hr-preview.html') { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, html)); return; }
    if (req.url?.split('?')[0] === '/hr-live-preview.html') { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, liveHtml)); return; }
    if (req.url?.split('?')[0] === '/hr-shell-preview.html') { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, shellHtml)); return; }
    if (!req.url?.startsWith('/api/')) return next();
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url!, 'http://fixture.test');
    if (url.pathname === '/api/auth/me') { res.end(JSON.stringify({user:{id:'fixture',name:'Fixture Candidate',email:'fixture@example.test',avatarUrl:null},googleConfigured:true})); return; }
    if (url.pathname === '/api/today') { res.end(JSON.stringify({runs:1,submitted:32,reviewed:224})); return; }
    if (url.pathname === '/api/applications') { res.end(JSON.stringify(apps)); return; }
    if (url.pathname === '/api/entitlements') { res.end(JSON.stringify({ tier: runAdmin ? 'admin' : 'standard', manualRuns: runAdmin, firstRunRequired:!runAdmin, autoRunsPerDay: runAdmin ? 4 : 1, autoRunsUsedToday:0, canPauseAutoApply:true, fineTune: false, advancedFilters: false, runScopes: runAdmin, employerSources: false })); return; }
    if (url.pathname === '/api/setup/status') { res.end(JSON.stringify({ready:setupReady,done:setupReady?3:0,total:3,checks:[{id:'resume',label:'Your resume',fix:'documents'},{id:'profile',label:'Your details',fix:'details'},{id:'looking',label:'Your job search',fix:'looking'}].map(check=>({...check,done:setupReady,required:true,hint:'Complete this step to start applying.'}))})); return; }
    if (url.pathname === '/api/auto-schedule') { res.end(JSON.stringify({enabled:false,applicationMode:'auto',runsUsedToday:0,runsPerDay:4,nextRunAt:null,dueNow:false,timeZone:'Australia/Sydney',lastError:null,waitingForSetup:false,waitingForBoard:false,waitingForFirstRun:false})); return; }
    if (url.pathname === '/api/run/status') { res.end(JSON.stringify({ running: false, mode: null, applicationMode: 'auto', startedAt: null, finishedAt: null, exitCode: 0, applied: 2, prepared: 0, hasKey: true, isOwner: true })); return; }
    if (url.pathname === '/api/settings') { res.end(JSON.stringify({ PLATFORMS: 'seek' })); return; }
    if (url.pathname === '/api/hr-outreach') {
      if (url.searchParams.get('activity') === '1') { res.end(JSON.stringify({ items: [], nextCursor: null, progress })); return; }
      const failed = failHistory || (failOlder && url.searchParams.has('cursor'));
      res.statusCode = failed ? 503 : 200;
      const recent = liveEmail === undefined ? items : [...(liveEmail ? [liveEmail] : []), ...items.slice(1)];
      const allRows = reportingMode ? reportingItems : [...recent, ...olderItems];
      const rows: FixtureEmail[] = url.searchParams.has('jobId') ? allRows.filter(item => item.jobId === url.searchParams.get('jobId') && item.platform === url.searchParams.get('platform'))
        : reportingMode ? reportingItems : url.searchParams.has('cursor') ? olderItems : recent;
      const visible = url.searchParams.get('view') === 'status'
        ? rows.map(({ id, jobId, platform, status, phase, lookupOutcome, lookupRetryAt, deliveryStatus, checkingDelivery }) =>
          ({ id, jobId, platform, status, phase, lookupOutcome, lookupRetryAt, deliveryStatus, checkingDelivery }))
        : rows;
      res.end(JSON.stringify(failed ? { error: 'fixture unavailable' } : { items: emptyHistory ? [] : visible, nextCursor: emptyHistory || reportingMode || url.searchParams.has('cursor') || url.searchParams.has('jobId') ? null : '94', progress })); return;
    }
    if (req.url === '/api/hr-outreach/settings') {
      if (failSettings) { res.statusCode = 503; res.end(JSON.stringify({ error: 'fixture unavailable' })); return; }
      if (req.method === 'POST') {
        let body = ''; for await (const part of req) body += part;
        const value = JSON.parse(body); writes.push(value);
        if (failSave) { res.statusCode = 503; res.end(JSON.stringify({ error: 'fixture unavailable' })); return; }
        enabled = value.enabled;
      }
      res.end(JSON.stringify({ enabled })); return;
    }
    res.end(JSON.stringify([]));
  });
} }], optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: '/usr/bin/google-chrome-stable' }) });
const screenshotDir = resolve(import.meta.dirname, '../../output/hr-outreach-ui');
await mkdir(screenshotDir, { recursive: true });
try {
  const page=await browser.newPage({viewport:{width:1150,height:950}});
  await page.addInitScript(()=>{const interval=window.setInterval.bind(window);window.setInterval=((handler:TimerHandler,delay?:number,...args:unknown[])=>interval(handler,[5000,30000].includes(delay??0)?150:delay,...args)) as typeof window.setInterval;});
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin+'/hr-preview.html');
  await page.locator('.applications-list').waitFor();
  assert.equal(await page.getByRole('checkbox',{name:'Email hiring teams',exact:true}).count(),0,'Email preference has moved out of Submitted Applications');
  assert.equal(await page.getByRole('tab',{name:/^HR emails/}).count(),0,'No separate HR tab');
  assert.equal(await page.locator('.hr-role-link').count(),apps.length,'Every applied role offers its own HR details');
  for(const fixture of sourceFixtures) {
    const link=page.locator(`.application-link a[href="${fixture.url}"]`);
    assert.equal(await link.getByRole('img',{name:fixture.name,exact:true}).count(),1,'Legacy external links use the actual provider logo');
    assert.equal(await link.getAttribute('aria-label'),`Open ${fixture.name} listing`);
  }
  assert.equal(await page.locator('.application-link .employer-sites-label').count(),2,'Direct employer and lookalike hosts keep the employer-site icon');
  assert.doesNotMatch((await page.locator('.application-link').allTextContents()).join(' '),/External/);
  await page.waitForFunction(()=>[...document.querySelectorAll('.application-link img')].every(n=>(n as HTMLImageElement).complete&&(n as HTMLImageElement).naturalWidth>0));
  await page.screenshot({path:resolve(screenshotDir,'application-source-logos.png'),fullPage:true});
  await page.getByRole('button',{name:'HR email for Data Analyst at Fixture Employer'}).click();
  await page.locator('.drawer .hr-email').waitFor();await page.locator('.drawer').getByText('View sent email',{exact:true}).click();
  assert.equal(await page.locator('.drawer .hr-email .letter').innerText(),literal);assert.equal(await page.locator('.drawer .hr-email img').count(),0);
  assert.equal(await page.evaluate(()=>Boolean((window as any).fixtureInjected)),false);assert.match(await page.locator('.drawer .hr-email').innerText(),/hiring@example.test/);
  assert.equal(await page.locator('.drawer .hr-contact-source').getAttribute('href'),'https://fixture.invalid/careers');
  await page.screenshot({path:resolve(screenshotDir,'role-email-desktop.png'),fullPage:true});
  await page.waitForTimeout(350);assert.equal(await page.locator('.drawer .letter').isVisible(),true,'Polling preserves expanded content');
  await page.locator('.drawer').getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'HR email for Different employer role at Another Employer'}).click();
  await page.getByText('No HR email is recorded for this application.',{exact:true}).waitFor();assert.equal(await page.locator('.drawer .hr-email').count(),0,'Same job ID on another board cannot leak mail');
  await page.locator('.drawer').getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'HR email for Archived application at Historical Employer'}).click();
  await page.locator('.drawer').getByText('My archived application',{exact:true}).waitFor();await page.locator('.drawer').getByText('View sent email',{exact:true}).click();assert.match(await page.locator('.drawer .letter').innerText(),/Exact historical email body/);
  await page.locator('.drawer').getByRole('button',{name:'Close',exact:true}).click();
  liveEmail = null;
  await page.reload();
  const role = page.getByRole('button', { name: 'HR email for Data Analyst at Fixture Employer' });
  const indicator = role.locator('.hr-email-indicator');
  await role.getByText('View details', { exact: true }).waitFor();
  assert.equal(await indicator.count(), 0, 'No status appears before the follow-up is queued');
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const queued = { ...items[0], status: 'queued', phase: 'queued', toEmail: null, subject: null, body: null, sentAt: null };
  liveEmail = queued;
  await indicator.getByText('Queued', { exact: true }).waitFor();
  await role.click();
  const drawer = page.locator('.drawer');
  const stages = drawer.getByRole('list', { name: 'Email stages' });
  await stages.waitFor();
  assert.equal(await stages.locator('[aria-current="step"]').count(), 0, 'Queued email has not started finding a contact');
  for (const [status, phase, label, step] of [
    ['researching', 'researching', 'Finding contact', 'Find contact'],
    ['researching', 'writing', 'Writing email', 'Write email'],
    ['sending', 'sending', 'Sending email', 'Send email'],
  ]) {
    liveEmail = { ...queued, status, phase };
    await indicator.getByText(label, { exact: true }).waitFor();
    await stages.locator('[aria-current="step"]').getByText(step, { exact: true }).waitFor();
    assert.equal(await indicator.getAttribute('data-active'), 'true', `${label} uses the live indicator`);
    assert.equal(await page.getByRole('button', { name: 'HR email for Different employer role at Another Employer' }).getByText(label, { exact: true }).count(), 0, 'Progress belongs only to the matching board and role');
  }
  liveEmail = { ...items[0], checkingDelivery: true };
  await indicator.getByText('Checking delivery', { exact: true }).waitFor();
  await stages.locator('[aria-current="step"]').getByText('Check delivery', { exact: true }).waitFor();
  assert.equal(await indicator.getAttribute('data-active'), 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'The live stages fit a phone');
  await page.screenshot({ path: resolve(screenshotDir, 'role-email-live-mobile.png'), fullPage: true, animations: 'disabled' });
  liveEmail = items[0];
  await indicator.getByText('Sent', { exact: true }).waitFor();
  await drawer.locator('.hr-email-indicator').getByText('Sent', { exact: true }).waitFor();
  await drawer.getByText('View sent email', { exact: true }).waitFor();
  assert.notEqual(await indicator.getAttribute('data-active'), 'true', 'The indicator stops animating after send');
  assert.equal(await stages.count(), 0, 'A settled email no longer shows live steps');
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin, 'Updates arrive without a page reload');
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 1150, height: 950 });
  liveEmail = undefined;
  failHistory=true;await page.reload();await page.getByRole('alert').filter({hasText:'Could not load your HR emails'}).waitFor();failHistory=false;
  await page.getByRole('alert').filter({hasText:'Could not load your HR emails'}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'HR email for Data Analyst at Fixture Employer'}).click();await page.locator('.drawer .hr-email').waitFor();await page.locator('.drawer').getByRole('button',{name:'Close',exact:true}).click();
  reportingMode=true;await page.reload();await page.getByRole('button',{name:'HR email for Data Analyst at Fixture Employer'}).click();
  const report=(title:string)=>page.locator('.drawer .hr-email').filter({has:page.getByText(title,{exact:true})});
  await report('No public contact role').waitFor();
  for(const[title,label]of [['No public contact role','No public contact'],['Unverified company role','Company unverified'],['Blocked source role','Access blocked'],['Provider interruption role','Search temporarily unavailable'],['Incomplete lookup role','Lookup incomplete'],['Exhausted lookup role','Failed'],['Unconfirmed delivery role','Delivery unconfirmed']])assert.ok(await report(title).locator('.badge').filter({hasText:new RegExp(`^${label}$`)}).count(),title);
  assert.match(await report('Incomplete lookup role').innerText(),/Earliest retry/);assert.doesNotMatch(await report('Exhausted lookup role').innerText(),/Earliest retry/);
  assert.match(await report('MKA historical role').innerText(),/Contact needs review/);assert.match(await report('MKA historical role').innerText(),/Exact historical subject/);
  assert.match(await report('Saved advertisement contact role').innerText(),/Saved job advertisement/);assert.match(await report('Indexed contact role').innerText(),/Public search result/);
  const bounced=page.locator('.drawer .hr-email').filter({hasText:'invalid-recruiter@hcl.example.test'}),alternative=page.locator('.drawer .hr-email').filter({hasText:'verified-recruitment@hcl.example.test'});
  assert.match(await bounced.innerText(),/Delivery failed/);assert.match(await alternative.innerText(),/Retry attempt 2/);assert.match(await alternative.innerText(),/Sent/);
  assert.doesNotMatch(await page.locator('.drawer').innerText(),/selector:secret|model:private|stack:internal|Delivered/);assert.equal(await page.locator('.drawer .hr-email img').count(),0);
  await page.setViewportSize({width:390,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:resolve(screenshotDir,'role-email-mobile.png'),fullPage:true});
  await page.locator('.drawer').getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'provider logos fit the mobile application cards');
  await page.screenshot({path:resolve(screenshotDir,'application-source-logos-mobile.png'),fullPage:true});
  const live=await browser.newPage({viewport:{width:1150,height:950}});await live.addInitScript(()=>{const interval=window.setInterval.bind(window);window.setInterval=((handler:TimerHandler,delay?:number,...args:unknown[])=>interval(handler,[5000,30000].includes(delay??0)?150:delay,...args)) as typeof window.setInterval;});
  let activityRequests = 0;
  live.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/hr-outreach' && url.searchParams.get('activity') === '1') activityRequests++;
  });
  await live.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await live.goto(origin+'/hr-live-preview.html');
  const checkbox=live.getByRole('checkbox',{name:'Email hiring teams',exact:true});await checkbox.waitFor({timeout:10000}).catch(async error=>{console.error('Apply fixture state:',await live.locator('body').innerText());throw error;});
  await live.waitForFunction(()=>!(document.querySelector('.hr-outreach-preference input') as HTMLInputElement)?.disabled);
  assert.equal(writes.length,0,'Opening either page does not change the saved preference');
  assert.equal(await checkbox.isChecked(),false);await checkbox.click();await live.waitForFunction(()=>!(document.querySelector('.hr-outreach-preference input') as HTMLInputElement)?.disabled);await live.waitForFunction(()=>(document.querySelector('.hr-outreach-preference input') as HTMLInputElement)?.checked===true);assert.equal(enabled,true);
  failSave=true;await checkbox.click();await live.getByRole('alert').filter({hasText:'Could not save'}).waitFor();assert.equal(await checkbox.isChecked(),true);failSave=false;
  failSettings=true;await live.reload();await live.getByRole('alert').filter({hasText:'Could not load your email preference'}).waitFor();failSettings=false;await live.getByRole('button',{name:'Reload preference'}).click();await live.waitForFunction(()=>!(document.querySelector('.hr-outreach-preference input') as HTMLInputElement)?.disabled);assert.equal(await checkbox.isChecked(),true,'Reloading Apply preserves the saved preference');
  const activity = live.locator('.console-card .activity-body');
  await activity.getByText('No activity yet', { exact: true }).waitFor();
  assert.equal(await activity.getByText('Hiring-team follow-ups', { exact: true }).count(), 0);
  assert.equal(await live.getByRole('region',{name:'Application summary'}).count(),0,'Overview is no longer part of Apply');
  assert.equal(await live.locator('.run-controls-card .hr-outreach-preference').count(),1,'Email preference is grouped with application settings');
  const desktopLayout=await live.evaluate(()=>{const activity=document.querySelector('.run-activity-column')!.getBoundingClientRect(),settings=document.querySelector('.run-side')!.getBoundingClientRect();return{beside:activity.left>settings.right,aligned:Math.abs(activity.top-settings.top)<2,overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.deepEqual(desktopLayout,{beside:true,aligned:true,overflow:false},'Activity aligns with the settings column');
  for(const width of [320,390,430,768]){
    await live.setViewportSize({width,height:844});
    const mobile=await live.evaluate(()=>{const search=document.querySelector('.saved-search-card')!.getBoundingClientRect(),settings=document.querySelector('.run-controls-card')!.getBoundingClientRect(),bar=document.querySelector('.run-actions')!.getBoundingClientRect(),start=document.querySelector('.run-actions .btn.lg')!.getBoundingClientRect();return{overflow:document.documentElement.scrollWidth>innerWidth,settingsFirst:settings.bottom<=search.top,startHeight:start.height,footerBottom:bar.bottom,footerHeight:bar.height,inputFont:getComputedStyle(document.querySelector('#saved-search-terms')!).fontSize};});
    assert.equal(mobile.overflow,false,`${width}px: no horizontal scrolling`);assert.equal(mobile.settingsFirst,true,`${width}px: application settings appear before your search`);assert.ok(mobile.startHeight>=48,`${width}px: thumb-sized start button`);assert.ok(mobile.footerBottom<=845&&mobile.footerHeight<168,`${width}px: compact footer stays on screen`);assert.equal(mobile.inputFont,'16px',`${width}px: fields avoid iPhone focus zoom`);
    assert.equal(await live.locator('.run-actions .run-scope-actions, .run-actions .run-auto-row').count(),0,'Secondary settings stay out of the fixed footer');
  }
  await live.setViewportSize({width:390,height:844});
  await live.getByRole('button',{name:'Semi auto',exact:true}).click();await live.getByRole('button',{name:'Start Semi auto',exact:true}).waitFor();
  await live.getByRole('button',{name:'Auto apply',exact:true}).click();await live.getByRole('button',{name:'Start Auto apply',exact:true}).waitFor();
  assert.equal(await live.getByRole('region',{name:'Application summary'}).count(),0,'Mobile Apply has no Overview section');
  assert.equal(await live.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await live.screenshot({path:resolve(screenshotDir,'apply-mobile.png'),fullPage:true});
  const openActivity=live.getByRole('button',{name:'Activity',exact:true});if(await openActivity.isVisible())await openActivity.click();
  await activity.getByText('No activity yet', { exact: true }).waitFor();
  assert.equal(await activity.getByText('Hiring-team follow-ups', { exact: true }).count(), 0);
  assert.equal(activityRequests, 0, 'Apply does not poll hiring-email activity');
  assert.equal(await live.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await live.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await openActivity.isVisible(),true,'Activity closes back to the mobile controls');
  runAdmin=false;const regular=await browser.newPage();let hrRequests=0;regular.on('request',r=>{if(r.url().includes('/api/hr-outreach'))hrRequests++;});await regular.goto(origin+'/hr-preview.html?hr=off');await regular.locator('.applications-list').waitFor();assert.equal(await regular.locator('.hr-role-link').count(),0);assert.equal(hrRequests,0);
  await regular.goto(origin+'/hr-live-preview.html');await regular.locator('.run-layout').waitFor();await regular.waitForTimeout(350);assert.equal(await regular.locator('.hr-activity-inline').count(),0);assert.equal(hrRequests,0);
  assert.equal(await regular.getByRole('checkbox',{name:'Email hiring teams',exact:true}).count(),0,'Preference keeps its existing access restriction');
  setupReady=false;
  const newcomer=await browser.newPage({viewport:{width:390,height:844}});await newcomer.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await newcomer.goto(origin+'/hr-live-preview.html');
  const finishSetup=newcomer.getByRole('button',{name:'Finish setup',exact:true});await finishSetup.waitFor();assert.equal(await finishSetup.isEnabled(),true,'New users get an actionable setup button');
  const controls=newcomer.locator('.run-controls-card');
  assert.equal(await controls.locator('.resume-line,.run-auto-row,.signin-status,.gmail-card,.activity-open').count(),0,'Unfinished setup has no resume claim, paused schedule or duplicate connection controls');
  assert.equal(await controls.getByRole('button',{name:'Start Auto apply',exact:true}).count(),0,'No disabled Start button before setup is finished');
  assert.ok((await controls.innerText()).length<210,'First-run panel has one short explanation');
  await newcomer.screenshot({path:resolve(screenshotDir,'new-user-apply-mobile.png'),fullPage:true});
  await newcomer.setViewportSize({width:1150,height:950});await newcomer.screenshot({path:resolve(screenshotDir,'new-user-apply-desktop.png'),fullPage:true});
  await finishSetup.click();await newcomer.getByRole('button',{name:'Hide steps',exact:true}).waitFor();assert.equal(await newcomer.locator('.run-notes').evaluate(el=>el===document.activeElement),true,'Finish setup focuses the setup section');
  setupReady=true;await newcomer.reload();await newcomer.getByRole('button',{name:'Start Auto apply',exact:true}).waitFor();assert.equal(await newcomer.getByRole('button',{name:'Finish setup',exact:true}).count(),0,'Start returns once setup is complete');
  runAdmin=true;
  const shell=await browser.newPage({viewport:{width:1950,height:950}});
  await shell.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await shell.goto(origin+'/hr-shell-preview.html?tab=overview');
  await shell.getByRole('region',{name:'Application summary'}).waitFor();
  assert.equal(await shell.getByRole('button',{name:'Overview',exact:true}).count(),0,'Overview is absent from the desktop sidebar');
  await shell.getByRole('button',{name:`${apps.length} Applied this week`,exact:true}).click();await shell.getByRole('heading',{name:'Submitted Applications',exact:true}).waitFor();
  await shell.getByRole('button',{name:'Apply',exact:true}).click();await shell.locator('.run-controls-card').waitFor();
  assert.equal(await shell.getByRole('region',{name:'Application summary'}).count(),0,'Real Apply shell excludes Overview');
  assert.ok(await shell.evaluate(()=>{const main=document.querySelector('main')!.getBoundingClientRect();return Math.abs((document.querySelector('.run-controls-card')!.getBoundingClientRect().left-main.left)/main.width-.01)<.001;}),'Apply keeps a 1% left gutter');
  assert.ok(await shell.evaluate(()=>Math.abs(document.querySelector('.page-content')!.getBoundingClientRect().width/document.querySelector('main')!.getBoundingClientRect().width-.98)<.001),'Apply uses 98% of the width beside the sidebar');
  await shell.screenshot({path:resolve(screenshotDir,'apply-sidebar-desktop.png'),fullPage:true});
  await shell.setViewportSize({width:390,height:844});await shell.getByRole('button',{name:'Menu',exact:true}).click();
  const menuScroll=await shell.evaluate(()=>{const nav=document.querySelector('.side-nav')!,links=document.querySelector('.nav-links')!;return {container:getComputedStyle(nav).overflowY,links:getComputedStyle(links).overflowY,linksFit:links.scrollHeight===links.clientHeight};});
  assert.deepEqual(menuScroll,{container:'auto',links:'visible',linksFit:true},'the entire menu scrolls together without a separate Workspace scroll');
  assert.equal(await shell.getByRole('button',{name:'Overview',exact:true}).count(),0,'Overview is absent from the mobile menu');
  await shell.getByRole('button',{name:'Apply',exact:true}).click();await shell.locator('.run-controls-card').waitFor();
  assert.equal(await shell.getByRole('region',{name:'Application summary'}).count(),0,'Mobile Apply excludes Overview');
  assert.equal(await shell.getByRole('button',{name:'Menu',exact:true}).getAttribute('aria-expanded'),'false','Choosing Apply closes the mobile menu');
  await shell.waitForFunction(()=>getComputedStyle(document.querySelector('.side-nav')!).visibility==='hidden');
  assert.equal(await shell.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Apply fits on mobile');
  await shell.screenshot({path:resolve(screenshotDir,'apply-sidebar-mobile.png'),fullPage:true});
  assert.deepEqual(writes,[{enabled:true},{enabled:false}]);
  console.log('PASS: Submitted Applications updates hiring-email stages from queued to sent. Apply Activity remains separate, and email preferences and history still work. Fictional APIs only; no real mail sent.');
}finally{await browser.close();await vite.close();}
