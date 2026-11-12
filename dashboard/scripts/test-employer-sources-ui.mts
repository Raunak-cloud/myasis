import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { EMPLOYER_SOURCES } from '../../seek-bot/src/employer-source-config.js';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const dashboard = resolve(import.meta.dirname, '..');
const output = resolve(dashboard, '../output/employer-sources-preview');
const initial = Object.fromEntries(EMPLOYER_SOURCES.map(source => [source.key, source.id === 'smartrecruiters'
  ? 'LuxuryEscapes,NCSAustralia,APMGroup,AristaNetworks,Cuscal1,ServiceNow,Blue,carsales,Xplor,Endava,Canva,KPMGAustralia1,Colliers,ALDI1' : source.defaults]));
const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module">
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {EmployerSourceEditor} from '/src/components/EmployerSourceEditor.tsx';import '/src/index.css';
const sources=${JSON.stringify(EMPLOYER_SOURCES)};
function Preview(){const [values,setValues]=useState(${JSON.stringify(initial)});return React.createElement('main',{style:{maxWidth:850,padding:20,margin:'0 auto',display:'grid',gap:16}},
React.createElement('h2',null,'Companies to search'),...sources.map(source=>React.createElement(EmployerSourceEditor,{key:source.id,source,value:values[source.key],onChange:value=>setValues(previous=>({...previous,[source.key]:value}))})),React.createElement('output',{id:'saved',hidden:true},JSON.stringify(values)));}
createRoot(document.getElementById('root')).render(React.createElement(Preview));</script></body></html>`;
const server = await createServer({ configFile: false, root: dashboard, plugins: [react(), { name: 'employer-editor-fixture', configureServer(app) {
  app.middlewares.use(async (req, res, next) => { if (req.url !== '/') return next(); res.setHeader('content-type', 'text/html'); res.end(await app.transformIndexHtml('/', html)); });
} }], server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(dashboard, '..')] } }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', issue => errors.push(issue.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const smart = page.getByRole('region', { name: 'SmartRecruiters', exact: true });
  await smart.getByRole('button', { name: 'Show all 14 companies' }).waitFor();
  assert.equal(await page.locator('.employer-source-editor input').count(), 0, 'raw settings are not shown by default');
  assert.doesNotMatch(await page.locator('body').innerText(), /myworkdayjobs\.com|\|https:|KPMGAustralia1|employer identifiers/);
  await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
  await smart.getByRole('button', { name: 'Show all 14 companies' }).click();
  await smart.getByRole('button', { name: 'Remove Canva from SmartRecruiters', exact: true }).click();
  await smart.getByRole('button', { name: '+ Add company', exact: true }).click();
  await smart.getByLabel('Company careers page', { exact: true }).fill('https://jobs.smartrecruiters.com/Canva');
  await smart.getByRole('button', { name: 'Add company', exact: true }).click();
  const values = async () => JSON.parse(await page.locator('#saved').textContent() ?? '{}');
  assert.ok((await values()).SMARTRECRUITERS_COMPANIES.endsWith(',Canva'));
  const greenhouse = page.getByRole('region', { name: 'Greenhouse', exact: true });
  await greenhouse.getByRole('button', { name: '+ Add company', exact: true }).click();
  await greenhouse.getByLabel('Company careers page', { exact: true }).fill('https://boards.greenhouse.io/imc');
  await greenhouse.getByRole('button', { name: 'Add company', exact: true }).click();
  await greenhouse.getByRole('button', { name: 'Remove IMC from Greenhouse' }).waitFor();
  for (const source of EMPLOYER_SOURCES.filter(source => source.kind === 'urls')) {
    const card = page.getByRole('region', { name: source.label, exact: true });
    await card.getByRole('button', { name: '+ Add company', exact: true }).click();
    await card.getByLabel('Company name', { exact: true }).fill('Example Company');
    const link = source.id === 'pageup' ? 'https://careers.pageuppeople.com/999/cw/en' : 'https://example.wd3.myworkdayjobs.com/en-US/External';
    await card.getByLabel('Company careers page', { exact: true }).fill(link);
    await card.getByRole('button', { name: 'Add company', exact: true }).click();
    assert.equal((await values())[source.key], `${source.defaults},Example Company|${link}`, 'existing saved targets are preserved byte for byte');
    await card.getByRole('button', { name: '+ Add company', exact: true }).click();
    await card.getByLabel('Company name', { exact: true }).fill('Another name');
    await card.getByLabel('Company careers page', { exact: true }).fill(link);
    await card.getByRole('button', { name: 'Add company', exact: true }).click();
    await card.getByRole('alert').getByText('This company is already on the list.').waitFor();
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await card.getByRole('button', { name: `Remove Example Company from ${source.label}` }).click();
    assert.equal((await values())[source.key], source.defaults);
  }
  await smart.getByRole('button', { name: 'Show fewer' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
  await smart.getByRole('button', { name: '+ Add company', exact: true }).click();
  await smart.getByLabel('Company careers page', { exact: true }).fill('https://unrelated.invalid/company');
  await smart.getByRole('button', { name: 'Add company', exact: true }).click();
  await smart.getByRole('alert').getByText('Use the company’s SmartRecruiters careers page.').waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['readable names', 'collapsed lists', 'add/remove', 'careers links', 'saved settings preserved', 'duplicate feedback', 'mobile layout', 'no raw settings'], output }));
} finally { await browser.close(); await server.close(); }
