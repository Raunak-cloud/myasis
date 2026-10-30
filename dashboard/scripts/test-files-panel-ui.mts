/** Real component and browser; all persistence requests stay in fixture APIs. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');
const dashboard = resolve(import.meta.dirname, '..');
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="fixture"></main><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{FilesPanel}from"/src/components/FilesPanel.tsx";import"/src/index.css";createRoot(document.getElementById("fixture")).render(React.createElement(React.StrictMode,null,React.createElement(FilesPanel)));</script></body></html>';
const server = await createServer({ configFile: false, root: dashboard, plugins: [react(), {
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
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
