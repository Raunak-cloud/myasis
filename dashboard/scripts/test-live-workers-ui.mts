/** Real Chrome/CDP + real viewer, synthetic local pages only. No accounts or employers. */
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { WebSocketServer } from 'ws';
import { streamLiveWorkers, type CdpTarget } from '../server/screencast.js';
import { configureLiveWorkers, resetLiveWorkers, writeLiveTarget } from '../../seek-bot/src/live-workers.js';
import { remotePreviewFile } from '../../seek-bot/src/remote-browser-preview.js';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');

const directory = mkdtempSync(join(tmpdir(), 'live-workers-ui-'));
const unused = httpServer();
await new Promise<void>(done => unused.listen(0, '127.0.0.1', done));
const port = (unused.address() as { port: number }).port;
await new Promise<void>(done => unused.close(() => done()));
const browser = await chromium.launch({ headless: process.env.LIVE_WORKERS_HEADED !== 'true', args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
  import {LiveActionViewer} from '/src/components/LiveActionViewer.tsx'; import '/src/index.css';
  createRoot(document.getElementById('root')).render(React.createElement(LiveActionViewer,{onClose:()=>{},activity:'Synthetic worker test'}));`;
const wss = new WebSocketServer({ noServer: true });
const messages: Array<{ type: string; workerId?: string; target?: { id: string } }> = [];
async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  assert.ok(check(), 'expected worker stream update did not arrive');
}
const attachedTo = (id: string) => messages.filter(message => message.type === 'attached' && message.workerId === id).at(-1)?.target?.id;
const server = await createServer({ configFile: false, root: join(import.meta.dirname, '..'),
  plugins: [react(), {
    name: 'worker-view-fixture',
    resolveId(id) { if (id === '/worker-view-fixture.tsx') return '\0worker-view-fixture.tsx'; },
    load(id) { if (id === '\0worker-view-fixture.tsx') return entry; },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== '/') { next(); return; }
        void vite.transformIndexHtml('/', '<!doctype html><html data-theme="light"><div id="root"></div><script type="module" src="/worker-view-fixture.tsx"></script></html>').then(html => {
          res.setHeader('Content-Type', 'text/html'); res.end(html);
        });
      });
    },
  }], server: { host: '127.0.0.1', port: 0 },
});
server.httpServer!.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws/screencast')) return;
  wss.handleUpgrade(req, socket, head, client => {
    const send = client.send.bind(client);
    client.send = ((data: string) => { messages.push(JSON.parse(String(data))); send(data); }) as typeof client.send;
    streamLiveWorkers(client, { directory, port, quality: 82, maxWidth: 1000, intervalMs: 150,
      targets: async () => await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as CdpTarget[] });
  });
});
try {
  await server.listen();
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const [index, page] of pages.entries()) {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<style>body{background:${index ? '#cceedd' : '#ddeeff'};font:32px sans-serif}</style><h1>${index ? 'Indeed' : 'SEEK'} synthetic application</h1>` }));
    await page.goto(`https://worker${index}.fixture.invalid/application`);
  }
  const targetId = async (page: typeof pages[number]) => {
    const cdp = await page.context().newCDPSession(page);
    try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await cdp.detach(); }
  };
  const ids = await Promise.all(pages.map(targetId));
  resetLiveWorkers(directory);
  writeLiveTarget(directory, 'main', { targetId: ids[0] });
  const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const viewer = await viewerContext.newPage();
  const errors: string[] = [];
  viewer.on('pageerror', error => errors.push(error.message));
  await viewer.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await viewer.goto(origin);
  const single = viewer.getByRole('region', { name: 'Browser', exact: true });
  await single.getByRole('img').waitFor({ state: 'visible' });
  configureLiveWorkers(directory, ['seek', 'indeed']);
  writeLiveTarget(directory, 'seek', { targetId: ids[0] });
  writeLiveTarget(directory, 'indeed', { targetId: ids[1] });
  const seek = viewer.getByRole('region', { name: 'SEEK worker', exact: true });
  const indeed = viewer.getByRole('region', { name: 'Indeed / employer feeds worker', exact: true });
  await seek.getByText('Picture live', { exact: true }).waitFor();
  await indeed.getByText('Picture live', { exact: true }).waitFor();
  const seekFrame = await seek.getByRole('img').getAttribute('src');
  const indeedFrame = await indeed.getByRole('img').getAttribute('src');
  assert.notEqual(seekFrame, indeedFrame, 'two panes must contain two different browser pages');
  const boxes = await Promise.all([seek.boundingBox(), indeed.boundingBox()]);
  assert.ok(Math.abs(boxes[0]!.y - boxes[1]!.y) < 2 && boxes[0]!.x < boxes[1]!.x, 'desktop panes are side by side');
  await viewer.setViewportSize({ width: 390, height: 844 });
  const mobileBoxes = await Promise.all([seek.boundingBox(), indeed.boundingBox()]);
  assert.ok(mobileBoxes[0]!.y < mobileBoxes[1]!.y && Math.abs(mobileBoxes[0]!.x - mobileBoxes[1]!.x) < 2, 'mobile panes are stacked');
  assert.ok(await viewer.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal overflow');
  await viewer.setViewportSize({ width: 1440, height: 1000 });

  // Each worker owns its review page. Both can review together, then switch
  // independently between review, application and a page-less wait.
  const reviewContext = await browser.newContext();
  const reviewPage = await reviewContext.newPage();
  await reviewPage.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1 style="background:pink">SEEK job review</h1>' }));
  await reviewPage.goto('https://review.fixture.invalid/job');
  const reviewId = await targetId(reviewPage);
  const otherReviewContext = await browser.newContext();
  const otherReviewPage = await otherReviewContext.newPage();
  await otherReviewPage.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1 style="background:orange">Indeed job review</h1>' }));
  await otherReviewPage.goto('https://indeed-review.fixture.invalid/job');
  const otherReviewId = await targetId(otherReviewPage);
  writeLiveTarget(directory, 'seek', { targetId: reviewId, activity: { phase: 'reviewing', detail: 'Checking listings against your profile.' } });
  writeLiveTarget(directory, 'indeed', { targetId: ids[1], activity: { phase: 'applying', detail: 'Indeed fixture application' } });
  await seek.getByText('Reviewing jobs', { exact: true }).waitFor();
  await indeed.getByText('Applying', { exact: true }).waitFor();
  await eventually(() => attachedTo('seek') === reviewId);
  await seek.getByText('Picture live', { exact: true }).waitFor();
  assert.equal(attachedTo('indeed'), ids[1]);
  writeLiveTarget(directory, 'indeed', { targetId: otherReviewId, activity: { phase: 'reviewing', detail: 'Checking Indeed listings.' } });
  await indeed.getByText('Reviewing jobs', { exact: true }).waitFor();
  await eventually(() => attachedTo('seek') === reviewId && attachedTo('indeed') === otherReviewId);
  await indeed.getByText('Picture live', { exact: true }).waitFor();
  assert.notEqual(await seek.getByRole('img').getAttribute('src'), await indeed.getByRole('img').getAttribute('src'), 'simultaneous review pictures remain separate');
  await viewer.setViewportSize({ width: 390, height: 844 });
  assert.ok(await viewer.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'activity badges and descriptions fit mobile');
  await viewer.setViewportSize({ width: 1440, height: 1000 });
  writeLiveTarget(directory, 'seek', { activity: { phase: 'waiting', detail: 'No matching SEEK job ready.' } });
  await seek.getByRole('heading', { name: 'Waiting', exact: true }).waitFor();
  assert.equal(await seek.getByRole('img').count(), 0, 'waiting must remove the previous form');
  // A lingering cloud preview must not override the newly owned review page.
  const oldCloudFile = join(directory, remotePreviewFile('indeed'));
  writeFileSync(oldCloudFile, JSON.stringify({ sessionId: randomUUID(), provider: 'brightdata', at: Date.now(), url: 'https://cloud.fixture.invalid', data: (await pages[1].screenshot({ type: 'jpeg' })).toString('base64') }));
  writeLiveTarget(directory, 'indeed', { targetId: otherReviewId, activity: { phase: 'reviewing' } });
  await indeed.getByText('Reviewing jobs', { exact: true }).waitFor();
  await eventually(() => attachedTo('indeed') === otherReviewId);
  await indeed.getByText('Picture live', { exact: true }).waitFor();
  assert.equal(await seek.getByRole('img').count(), 0, 'released review page must not appear in the waiting worker');
  unlinkSync(oldCloudFile);
  writeLiveTarget(directory, 'seek', { targetId: ids[0], activity: { phase: 'applying', detail: 'SEEK fixture application' } });
  writeLiveTarget(directory, 'indeed', { targetId: ids[1], activity: { phase: 'applying', detail: 'Indeed fixture application' } });
  await eventually(() => attachedTo('seek') === ids[0] && attachedTo('indeed') === ids[1]);
  await seek.getByText('Picture live', { exact: true }).waitFor();
  await indeed.getByText('Picture live', { exact: true }).waitFor();

  const popup = await contexts[0].newPage();
  await popup.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1 style="background:yellow">SEEK employer popup</h1>' }));
  await popup.goto('https://popup.fixture.invalid/form');
  const popupId = await targetId(popup);
  writeLiveTarget(directory, 'seek', { targetId: popupId, activity: { phase: 'applying', detail: 'SEEK employer popup' } });
  await eventually(() => attachedTo('seek') === popupId);
  await viewer.waitForFunction(`old => document.querySelector('[aria-label="SEEK worker"] img')?.getAttribute('src') !== old`, seekFrame);
  await seek.getByText('Picture live', { exact: true }).waitFor();
  assert.equal(attachedTo('indeed'), ids[1], 'SEEK popup must not replace Indeed');
  writeLiveTarget(directory, 'seek', { activity: { phase: 'cooldown', detail: 'Application submitted. Pausing before the next job.' } });
  await seek.getByRole('heading', { name: 'Pausing between jobs', exact: true }).waitFor();
  assert.equal(await seek.getByRole('img').count(), 0);
  await indeed.getByText('Picture live', { exact: true }).waitFor();
  writeLiveTarget(directory, 'seek', { targetId: popupId, activity: { phase: 'applying' } });
  await seek.getByText('Picture live', { exact: true }).waitFor();
  const remoteData = (await popup.screenshot({ type: 'jpeg', quality: 82 })).toString('base64');
  const remoteFile = join(directory, remotePreviewFile('indeed'));
  writeFileSync(remoteFile, JSON.stringify({ sessionId: randomUUID(), provider: 'brightdata', at: Date.now(), url: 'https://cloud.fixture.invalid', data: remoteData }));
  await viewer.waitForFunction(`data => document.querySelector('[aria-label="Indeed / employer feeds worker"] img')?.getAttribute('src') === 'data:image/jpeg;base64,' + data`, remoteData);
  await seek.getByText('Picture live', { exact: true }).waitFor();
  unlinkSync(remoteFile);
  await eventually(() => attachedTo('indeed') === ids[1]);
  await indeed.getByText('Picture live', { exact: true }).waitFor();
  await contexts[0].close();
  await seek.getByRole('heading', { name: 'Waiting for an application page', exact: true }).waitFor();
  await indeed.getByText('Picture live', { exact: true }).waitFor();
  writeLiveTarget(directory, 'seek', { finished: true, activity: { phase: 'finished' } });
  await seek.getByRole('heading', { name: 'Live activity ended', exact: true }).waitFor();
  await indeed.getByText('Picture live', { exact: true }).waitFor();
  // Late failures from a vanished stream cannot erase the other worker's view.
  assert.equal(attachedTo('indeed'), ids[1]);
  assert.deepEqual(errors, []);
  await viewerContext.close();
  console.log('PASS: simultaneous independent review pictures and phases, waiting/cooldown clearing, application isolation, desktop/mobile layout, popups, cloud switching and cleanup; synthetic pages only');
} finally {
  for (const client of wss.clients) client.terminate();
  await server.close();
  await browser.close();
  rmSync(directory, { recursive: true, force: true });
}
