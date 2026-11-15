// Isolated profile only. Never reads a customer's cookies or contacts a job board.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [app, executablePath] = process.argv.slice(2);
const { chromium } = createRequire(join(app, 'seek-bot/package.json'))('patchright');
const directory = await mkdtemp(join(tmpdir(), 'owtomate-chrome-check-'));
let context;
try {
  const file = join(directory, 'resume.txt'); await writeFile(file, 'Synthetic browser update test');
  for (let pass = 0; pass < 2; pass++) {
    context = await chromium.launchPersistentContext(join(directory, 'profile'), {
      executablePath, headless: true, chromiumSandbox: true, timeout: 30_000,
    });
    context.setDefaultTimeout(10_000);
    await context.route('**/*', route => route.request().url().startsWith('https://update-check.invalid/')
      ? route.fulfill({ contentType: 'text/html', body: '<label>Name<input name="name"></label><input type="file"><button onclick="document.body.dataset.done=1">Continue</button>' })
      : route.abort());
    if (pass === 0) await context.addCookies([{ name: 'saved-session', value: 'synthetic-session', domain: 'update-check.invalid', path: '/', expires: Math.floor(Date.now() / 1000) + 3600, secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); await page.goto('https://update-check.invalid/');
    assert.equal((await context.cookies()).find(cookie => cookie.name === 'saved-session')?.value, 'synthetic-session');
    await page.getByRole('textbox', { name: 'Name' }).fill('Test candidate');
    await page.locator('input[type=file]').setInputFiles(file);
    await page.getByRole('button', { name: 'Continue' }).click();
    assert.equal(await page.locator('body').getAttribute('data-done'), '1');
    assert.equal(await page.locator('input[type=file]').evaluate(input => input.files.length), 1);
    await page.screenshot({ path: join(directory, 'confirmation.png') });
    await context.close(); context = undefined;
  }
  console.log('Browser update check passed: persistent session, fill, click, upload and screenshot.');
} finally { await context?.close(); await rm(directory, { recursive: true, force: true }); }
