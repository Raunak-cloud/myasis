import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');

const dashboard = resolve(import.meta.dirname, '..');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Resume suggestions fixture</title></head><body><main id="root"></main><script type="module">import React,{useState} from "react";import{createRoot}from"react-dom/client";import{SearchTermsGenerator}from"/src/components/SearchTermsGenerator.tsx";import"/src/index.css";function App(){const[terms,setTerms]=useState("Medical Receptionist");return React.createElement("section",null,React.createElement("h1",null,"Your search"),React.createElement("label",null,"Job titles",React.createElement("textarea",{value:terms,onChange:e=>setTerms(e.target.value)})),React.createElement(SearchTermsGenerator,{currentTerms:terms,onGenerated:setTerms}));}createRoot(document.getElementById("root")).render(React.createElement(App));</script><style>#root{max-width:720px;margin:32px auto;padding:20px}textarea{display:block;width:100%;box-sizing:border-box;margin:12px 0}body{margin:0}h1{font-size:24px}</style></body></html>`;
const server = await createServer({ configFile: false, root: dashboard, plugins: [react(), {
  name: 'resume-search-fixture', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/resume-search-fixture.html') return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml('/resume-search-fixture.html', html));
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
    const requests: Array<{ alternatives?: boolean; excludeTerms?: string[]; resumeIds: string[] }> = [];
    page.on('pageerror', error => errors.push(error.message));
    let finishRequest: (() => Promise<void>) | undefined;
    const suggestions = [
      { query: 'Medical Receptionist', matchType: 'direct', reason: 'Your clinic bookings and billing duties support this role.',
        evidence: [{ resumeId: 'cv1', resumeLabel: 'Clinic CV', quote: 'Managed patient bookings, appointment reminders and Medicare billing.' }] },
      { query: 'Bookings Officer', matchType: 'transferable', reason: 'Your appointment scheduling and customer enquiries transfer to booking services.',
        evidence: [{ resumeId: 'cv1', resumeLabel: 'Clinic CV', quote: 'Scheduled appointments and handled incoming patient enquiries.' }] },
    ];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/resumes') return json([{ id: 'cv1', label: 'Clinic CV', isDefault: true }, { id: 'cv2', label: 'General CV' }]);
      if (url.pathname === '/api/entitlements') return json({ tier: 'standard', searchTermSuggestionsLeft: null });
      if (url.pathname === '/api/search-terms/generate') {
        const body = route.request().postDataJSON();
        requests.push(body);
        finishRequest = async () => {
          if (body.alternatives) await json({ error: 'No additional roles were sufficiently supported by the selected resumes. Keep your existing searches or select a different resume.' }, 422);
          else await json({ terms: suggestions.map(s => s.query), suggestions, resumeLabel: 'Clinic CV' });
        };
        return;
      }
      throw new Error('Unexpected fixture API request ' + url.pathname);
    });
    await page.goto(origin + '/resume-search-fixture.html');
    const suggest = page.getByRole('button', { name: '✨ Suggest from my resumes', exact: true });
    await suggest.click();
    await page.waitForFunction(() => document.querySelector('.search-terms-ai-button')?.textContent === 'Suggesting…');
    await page.getByText('Using all 2 resumes', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Clear', exact: true }).isDisabled(), true, 'resume selection cannot change in flight');
    assert.equal(requests[0].alternatives, false);
    assert.equal(requests[0].excludeTerms, undefined, 'the strongest existing role is not excluded by default');
    await finishRequest!();
    await page.getByRole('status').waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Job titles' }).inputValue(), 'Medical Receptionist, Bookings Officer');
    await page.getByText('Why these suggestions?', { exact: true }).click();
    await page.getByText('Direct experience', { exact: true }).waitFor();
    await page.getByText('Transferable experience', { exact: true }).waitFor();
    await page.getByText(suggestions[0].evidence[0].quote, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile evidence must not overflow');
    await page.screenshot({ path: resolve(dashboard, '../output/resume-search-' + width + '.png'), fullPage: true });
    await page.getByRole('button', { name: 'Find alternatives', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.search-terms-ai-button')?.textContent === 'Suggesting…');
    assert.equal(requests[1].alternatives, true);
    assert.ok(requests[1].excludeTerms?.includes('medical receptionist'));
    await finishRequest!();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Job titles' }).inputValue(), 'Medical Receptionist, Bookings Officer', 'no alternatives preserves existing searches');
    await page.getByRole('checkbox', { name: 'General CV' }).uncheck();
    assert.equal(await page.getByText('Why these suggestions?', { exact: true }).count(), 0, 'changing source documents clears stale evidence');
    assert.equal(await page.getByRole('button', { name: 'Find alternatives', exact: true }).count(), 0, 'alternatives history belongs to its selected documents');
    await suggest.click();
    await page.waitForFunction(() => document.querySelector('.search-terms-ai-button')?.textContent === 'Suggesting…');
    assert.deepEqual(requests[2].resumeIds, ['cv1']);
    await finishRequest!();
    await page.getByRole('status').waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS resume suggestions, evidence, selection and alternatives at width', width);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
