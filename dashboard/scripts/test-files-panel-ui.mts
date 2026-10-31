/** Real component and browser; all persistence requests stay in fixture APIs. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const dashboard = resolve(import.meta.dirname, '..');
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="fixture"></main><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{FilesPanel}from"/src/components/FilesPanel.tsx";import"/src/index.css";createRoot(document.getElementById("fixture")).render(React.createElement(React.StrictMode,null,React.createElement(FilesPanel)));</script></body></html>';
const server = await createServer({ configFile: false, root: dashboard, cacheDir: resolve(dashboard, 'node_modules/.vite-files-panel-ui'), plugins: [react(), {
  name: 'files-fixture', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/files-fixture.html') return next();
      res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml('/files-fixture.html', html));
    });
  },
}], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const notes: Array<{ id: string; kind: string; label: string; text: string; enabled: boolean }> = [];
    let mode = 'server-error', writes = 0;
    let release!: () => void;
    let requestStarted!: () => void;
    const delayedRequest = new Promise<void>(resolve => { requestStarted = resolve; });
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'POST') {
        writes++;
        if (mode === 'network-error') return route.abort();
        if (mode === 'server-error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture save unavailable' }) });
        if (mode === 'delayed') {
          await new Promise<void>(resolve => { release = resolve; requestStarted(); });
        }
        const body = request.postDataJSON();
        notes.push({ ...body, id: String(writes), enabled: true });
        return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
      }
      return route.fulfill({ contentType: 'application/json', body: path === '/api/resumes' ? '[]' : JSON.stringify({ items: notes }) });
    });
    await page.goto(`${origin}/files-fixture.html`);
    const input = page.getByLabel('Add a detail'), save = page.getByRole('button', { name: 'Save', exact: true });
    const draft = 'Fixture detail must survive a failed save';
    await input.fill(draft); await save.click();
    await page.getByRole('alert').filter({ hasText: 'Fixture save unavailable' }).waitFor();
    assert.equal(await input.inputValue(), draft); assert.equal(await save.isEnabled(), true); assert.equal(notes.length, 0);
    mode = 'network-error'; await save.click();
    await page.getByRole('alert').filter({ hasText: /fetch|network/i }).waitFor();
    assert.equal(await input.inputValue(), draft); assert.equal(await save.isEnabled(), true);
    mode = 'success'; await save.click();
    await page.locator('.files-detail-text').filter({ hasText: draft }).waitFor();
    assert.equal(await input.inputValue(), ''); assert.equal(notes.length, 1); assert.equal(await page.getByRole('alert').count(), 0);
    mode = 'delayed'; await input.fill('First submitted detail'); await save.click();
    await delayedRequest;
    assert.equal(await save.isDisabled(), true);
    await input.fill('New draft typed while the earlier detail saves');
    await input.press('Control+Enter');
    release();
    await page.locator('.files-detail-text').filter({ hasText: 'First submitted detail' }).waitFor();
    assert.equal(await input.inputValue(), 'New draft typed while the earlier detail saves');
    assert.equal(notes.length, 2); assert.equal(writes, 4, 'a busy keyboard shortcut cannot send a duplicate save');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: failed saves retain drafts, network failures release controls, successful retries persist once, and in-flight edits survive; StrictMode and fixture APIs only.`);
    await page.unroute('**/api/**');
    const resumes = [
      { id: 'r1', label: 'First resume', fileName: 'first.txt', uploadedAt: new Date().toISOString(), size: 10 },
      { id: 'r2', label: 'Second resume', fileName: 'second.txt', uploadedAt: new Date().toISOString(), size: 10 },
    ];
    let releasePatch!: () => void, patchStarted!: () => void, patches = 0, heldPatchAt = 1, failedPatchAt = 0;
    let requestedPatch = new Promise<void>(resolve => { patchStarted = resolve; });
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'PATCH') {
        patches++;
        if (patches === heldPatchAt) await new Promise<void>(resolve => { releasePatch = resolve; patchStarted(); });
        if (patches === failedPatchAt) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Fixture first resume rename unavailable"}' });
        const { id, patch } = request.postDataJSON(); Object.assign(resumes.find(resume => resume.id === id)!, patch);
        return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
      }
      if (request.method() === 'DELETE') {
        const index = resumes.findIndex(resume => resume.id === request.postDataJSON().id);
        if (index >= 0) resumes.splice(index, 1);
        return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(path === '/api/resumes' ? resumes : { items: [] }) });
    });
    await page.reload();
    const firstName = page.getByLabel('Resume name', { exact: true }).nth(0), secondName = page.getByLabel('Resume name', { exact: true }).nth(1);
    const blur = () => page.getByRole('heading', { name: /Resumes/ }).click();
    await firstName.fill('First submitted name'); await blur(); await requestedPatch;
    await secondName.fill('Second queued name'); await blur();
    await firstName.fill('Newer unsaved name');
    releasePatch();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.files-card-head button')?.disabled);
    assert.equal(await firstName.inputValue(), 'Newer unsaved name');
    assert.equal(await secondName.inputValue(), 'Second queued name');
    assert.equal(resumes[1].label, 'Second queued name', 'the second metadata write must not be dropped while busy');
    await firstName.focus(); await blur();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.files-card-head button')?.disabled);
    assert.equal(resumes[0].label, 'Newer unsaved name'); assert.equal(patches, 3);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: overlapping resume metadata saves run in order and preserve newer draft edits.`);
    heldPatchAt = 4;
    requestedPatch = new Promise<void>(resolve => { patchStarted = resolve; });
    await firstName.fill('ABA draft A'); await blur(); await requestedPatch;
    await firstName.fill('ABA queued B'); await blur();
    await firstName.fill('ABA draft A');
    releasePatch();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.files-card-head button')?.disabled);
    assert.equal(await firstName.inputValue(), 'ABA draft A', 'an older saved A cannot clear a newly typed A while B is queued');
    assert.equal(resumes[0].label, 'ABA queued B', 'the latest A remains an unsaved draft until blur');
    await blur();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.files-card-head button')?.disabled);
    assert.equal(resumes[0].label, 'ABA draft A'); assert.equal(patches, 6);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: A-to-B-to-A edits preserve the latest draft until its own save.`);
    heldPatchAt = 7; failedPatchAt = 7;
    requestedPatch = new Promise<void>(resolve => { patchStarted = resolve; });
    await firstName.fill('Failed first rename'); await blur(); await requestedPatch;
    await secondName.fill('Successful other rename'); await blur();
    releasePatch();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.files-card-head button')?.disabled);
    assert.equal(resumes[0].label, 'ABA draft A'); assert.equal(await firstName.inputValue(), 'Failed first rename');
    assert.equal(resumes[1].label, 'Successful other rename');
    assert.equal(await page.getByRole('alert').count(), 1, 'another file saving successfully cannot hide the failed draft');
    assert.match(await page.getByRole('alert').innerText(), /Fixture first resume rename unavailable/);
    await firstName.focus(); await blur();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.files-card-head button')?.disabled);
    assert.equal(resumes[0].label, 'Failed first rename'); assert.equal(patches, 9);
    assert.equal(await page.getByRole('alert').count(), 0, 'retrying the failed draft clears its error after success');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: a failed metadata draft stays visible after another file saves, and clears only after its retry.`);
    failedPatchAt = 10;
    await firstName.fill('Failed rename before deletion'); await blur();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.files-card-head button')?.disabled);
    assert.equal(await page.getByRole('alert').count(), 1);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete Failed first rename', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.files-card-head button')?.disabled);
    assert.equal(await page.getByLabel('Resume name', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('alert').count(), 0, 'deleting the file also discards its failed draft and error');
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
