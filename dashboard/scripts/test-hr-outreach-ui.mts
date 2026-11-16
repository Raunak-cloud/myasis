/** Real dashboard components, fictional APIs only. No mail, accounts or database writes. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const now = new Date().toISOString();
const apps = [{ jobId: 'one', platform: 'seek', title: 'Data Analyst', company: 'Fixture Employer', location: 'Sydney', url: 'https://fixture.invalid/job', appliedAt: now, score: 90 },
  { jobId: 'one', platform: 'indeed', title: 'Different employer role', company: 'Another Employer', location: 'Sydney', url: 'https://fixture.invalid/another', appliedAt: now, score: 80 },
  { jobId: 'archived', platform: 'external', title: 'Archived application', company: 'Historical Employer', location: 'Sydney', url: 'https://fixture.invalid/old', appliedAt: now, score: 85 }];
const literal = '<img src=x onerror="window.fixtureInjected=true">\nThanks for considering my application.\n' + 'Long factual candidate message. '.repeat(25);
const items = ['sent', 'queued', 'researching', 'sending', 'skipped', 'error', 'unconfirmed'].map((status, i) => ({ id: String(100 - i), jobId: i ? 'other' : 'one', platform: 'seek', title: i ? `Fixture role ${i}` : 'Data Analyst', company: 'Fixture Employer', status,
  toEmail: i ? null : 'hiring@example.test', subject: i ? null : 'My Data Analyst application', body: i ? null : literal, createdAt: now, sentAt: i ? null : now, contactName: i ? null : 'Hiring team',
  sourceUrl: i === 1 ? 'javascript:alert(1)' : i ? null : 'https://fixture.invalid/careers', reason: status === 'skipped' ? 'No public hiring contact was found.' : null, phase: null as string | null, sourceRunId: '42' }));
const olderItems = [{ ...items[0], id: '93', jobId: 'old-history', title: 'Older outreach role', subject: 'An older introduction' },
  { ...items[0], id: '1', jobId: 'archived', platform: 'external', title: 'Archived application', company: 'Historical Employer', subject: 'My archived application', body: 'Exact historical email body.' }];
let enabled = false, failSave = false, failHistory = false, failSettings = false, emptyHistory = false, failOlder = false;
let progress: { active: boolean; phase: string | null; title: string | null; company: string | null; queued: number; sent: number; skipped: number; failed: number; runId: string | null; contactReviewRequiredCount?: number; deliveryFailedCount?: number }
  = { active: false, phase: 'waiting', title: null, company: null, queued: 1, sent: 0, skipped: 0, failed: 0, runId: '42' };
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
let runAdmin = true;
const writes: unknown[] = [];
const html = `<!doctype html><html><body><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{ApplicationsPanel}from'/src/components/ApplicationsPanel.tsx';import'/src/index.css';const mode=new URLSearchParams(location.search).get('hr');createRoot(document.getElementById('root')).render(React.createElement(ApplicationsPanel,{apps:${JSON.stringify(apps)},onChange:()=>{},followUpDays:10,...(mode==='default'?{}:{showHrOutreach:mode!=='off'})}));</script></body></html>`;
const liveHtml = `<!doctype html><html><body><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{RunPanel}from'/src/components/RunPanel.tsx';import'/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(RunPanel,{lastRunAt:null,onFinished:()=>{},onGoPricing:()=>{}}));</script></body></html>`;
const vite = await createServer({ configFile: false, root: resolve(import.meta.dirname, '..'), plugins: [react(), { name: 'hr-outreach-fixture', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url?.split('?')[0] === '/hr-preview.html') { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, html)); return; }
    if (req.url?.split('?')[0] === '/hr-live-preview.html') { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, liveHtml)); return; }
    if (!req.url?.startsWith('/api/')) return next();
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url!, 'http://fixture.test');
    if (url.pathname === '/api/entitlements') { res.end(JSON.stringify({ tier: runAdmin ? 'admin' : 'standard', manualRuns: runAdmin, autoRunsPerDay: 0, canPauseAutoApply: false, fineTune: false, advancedFilters: false, runScopes: false, employerSources: false })); return; }
    if (url.pathname === '/api/run/status') { res.end(JSON.stringify({ running: false, mode: null, applicationMode: 'auto', startedAt: null, finishedAt: null, exitCode: 0, applied: 2, prepared: 0, hasKey: true, isOwner: true })); return; }
    if (url.pathname === '/api/settings') { res.end(JSON.stringify({ PLATFORMS: 'seek' })); return; }
    if (url.pathname === '/api/hr-outreach') {
      if (url.searchParams.get('activity') === '1') { res.end(JSON.stringify({ items: [], nextCursor: null, progress })); return; }
      const failed = failHistory || (failOlder && url.searchParams.has('cursor'));
      res.statusCode = failed ? 503 : 200;
      const allRows = reportingMode ? reportingItems : [...items, ...olderItems];
      const rows = url.searchParams.has('jobId') ? allRows.filter(item => item.jobId === url.searchParams.get('jobId') && item.platform === url.searchParams.get('platform'))
        : reportingMode ? reportingItems : url.searchParams.has('cursor') ? olderItems : items;
      res.end(JSON.stringify(failed ? { error: 'fixture unavailable' } : { items: emptyHistory ? [] : rows, nextCursor: emptyHistory || reportingMode || url.searchParams.has('cursor') || url.searchParams.has('jobId') ? null : '94', progress })); return;
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
} }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
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
  const checkbox=page.getByRole('checkbox',{name:'Email hiring teams after I apply'});await checkbox.waitFor();await page.waitForFunction(()=>!(document.querySelector('.hr-outreach-preference input') as HTMLInputElement)?.disabled);
  assert.equal(await page.getByRole('tab',{name:/^HR emails/}).count(),0,'No separate HR tab');
  assert.equal(await page.locator('.hr-role-link').count(),3,'Every applied role offers its own HR details');
  assert.equal(await checkbox.isChecked(),false);await checkbox.click();await page.waitForFunction(()=>!(document.querySelector('.hr-outreach-preference input') as HTMLInputElement)?.disabled);await page.waitForFunction(()=>(document.querySelector('.hr-outreach-preference input') as HTMLInputElement)?.checked===true);assert.equal(enabled,true);
  failSave=true;await checkbox.click();await page.getByRole('alert').filter({hasText:'Could not save'}).waitFor();assert.equal(await checkbox.isChecked(),true);failSave=false;
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
  failHistory=true;await page.reload();await page.getByRole('alert').filter({hasText:'Could not load your HR emails'}).waitFor();failHistory=false;await page.getByRole('button',{name:'Refresh HR status'}).click();await page.getByRole('button',{name:'HR email for Data Analyst at Fixture Employer'}).click();await page.locator('.drawer .hr-email').waitFor();await page.locator('.drawer').getByRole('button',{name:'Close',exact:true}).click();
  failSettings=true;await page.reload();await page.getByRole('alert').filter({hasText:'Could not load your email preference'}).waitFor();failSettings=false;await page.getByRole('button',{name:'Reload preference'}).click();await checkbox.waitFor();
  reportingMode=true;await page.reload();await page.getByRole('button',{name:'HR email for Data Analyst at Fixture Employer'}).click();
  const report=(title:string)=>page.locator('.drawer .hr-email').filter({has:page.getByText(title,{exact:true})});
  await report('No public contact role').waitFor();
  for(const[title,label]of [['No public contact role','No public contact'],['Unverified company role','Company unverified'],['Blocked source role','Access blocked'],['Provider interruption role','Search temporarily unavailable'],['Incomplete lookup role','Lookup incomplete'],['Exhausted lookup role','Failed'],['Unconfirmed delivery role','Delivery unconfirmed']])assert.ok(await report(title).locator('.badge').filter({hasText:new RegExp(`^${label}$`)}).count(),title);
  assert.match(await report('Incomplete lookup role').innerText(),/Earliest retry/);assert.doesNotMatch(await report('Exhausted lookup role').innerText(),/Earliest retry/);
  assert.match(await report('MKA historical role').innerText(),/Contact needs review/);assert.match(await report('MKA historical role').innerText(),/Exact historical subject/);
  assert.match(await report('Saved advertisement contact role').innerText(),/Saved job advertisement/);assert.match(await report('Indexed contact role').innerText(),/Public search result/);
  const bounced=page.locator('.drawer .hr-email').filter({hasText:'invalid-recruiter@hcl.example.test'}),alternative=page.locator('.drawer .hr-email').filter({hasText:'verified-recruitment@hcl.example.test'});
  assert.match(await bounced.innerText(),/Delivery failed/);assert.match(await alternative.innerText(),/Retry attempt 2/);assert.match(await alternative.innerText(),/Sent/);
  assert.doesNotMatch(await page.locator('.drawer').innerText(),/selector:secret|model:private|stack:internal|Delivered/);assert.equal(await page.locator('.drawer img').count(),0);
  await page.setViewportSize({width:390,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:resolve(screenshotDir,'role-email-mobile.png'),fullPage:true});
  const live=await browser.newPage({viewport:{width:1150,height:950}});await live.addInitScript(()=>{const interval=window.setInterval.bind(window);window.setInterval=((handler:TimerHandler,delay?:number,...args:unknown[])=>interval(handler,[5000,30000].includes(delay??0)?150:delay,...args)) as typeof window.setInterval;});
  await live.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await live.goto(origin+'/hr-live-preview.html');
  const inline=live.locator('.console-card .hr-activity-inline');await inline.waitFor();assert.equal(await live.locator('.hr-outreach-activity').count(),0,'Separate Apply card removed');assert.equal(await live.locator('.hr-activity-inline').count(),1);assert.match(await inline.innerText(),/HR emails will start afterwards/);
  for(const[phase,label]of [['researching','Finding contact'],['writing','Writing email'],['sending','Sending email'],['checking','Checking delivery']]){
    progress={...progress,active:true,phase,title:'Data Analyst',company:'Fixture Employer'};await inline.locator('.badge').filter({hasText:new RegExp(`^${label}$`)}).waitFor();assert.match(await inline.innerText(),/Data Analyst · Fixture Employer/);
    if(phase==='writing'){assert.match(await inline.innerText(),/Contact found\. Writing your follow-up/);assert.equal(await inline.locator('[aria-current="step"]').innerText(),'2\nContact found');await live.screenshot({path:resolve(screenshotDir,'activity-progress-desktop.png'),fullPage:true});}
  }
  progress={...progress,active:false,phase:null,queued:0,sent:2,skipped:1,failed:1,deliveryFailedCount:1};await inline.locator('.badge').filter({hasText:/^Finished$/}).waitFor();assert.match(await inline.innerText(),/2 sent · 0 waiting · 1 not sent · 1 need attention/);assert.match(await inline.innerText(),/1 email could not be delivered/);
  await live.setViewportSize({width:390,height:950});const openActivity=live.getByRole('button',{name:'Activity',exact:true});if(await openActivity.isVisible())await openActivity.click();await inline.waitFor();assert.equal(await live.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await live.screenshot({path:resolve(screenshotDir,'activity-progress-mobile.png'),fullPage:true});
  runAdmin=false;const regular=await browser.newPage();let hrRequests=0;regular.on('request',r=>{if(r.url().includes('/api/hr-outreach'))hrRequests++;});await regular.goto(origin+'/hr-preview.html?hr=off');await regular.locator('.applications-list').waitFor();assert.equal(await regular.locator('.hr-role-link').count(),0);assert.equal(hrRequests,0);
  await regular.goto(origin+'/hr-live-preview.html');await regular.locator('.run-layout').waitFor();await regular.waitForTimeout(350);assert.equal(await regular.locator('.hr-activity-inline').count(),0);assert.equal(hrRequests,0);
  assert.deepEqual(writes,[{enabled:true},{enabled:false}]);
  console.log('PASS: HR emails live inside each applied role, historical/board-scoped attempts and delivery reporting are preserved, no HR tab/separate Apply card remains, Activity stages refresh live on desktop/mobile, messages are escaped, opt-in errors recover and ordinary users make no HR requests. Fictional APIs only; no real mail sent.');
}finally{await browser.close();await vite.close();}
