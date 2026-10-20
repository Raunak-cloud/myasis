import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'patchright';

const directory = mkdtempSync(join(tmpdir(), 'owtomate-worker-recovery-'));
process.env.DATA_DIR = directory;
const { applicationWorkerPage } = await import('./application-worker-page.js');

test('a retired application page is replaced within its own worker and later forms remain usable', async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  try {
    const worker = await browser.newContext();
    const otherWorker = await browser.newContext();
    const original = await worker.newPage();
    const other = await otherWorker.newPage();
    await worker.addCookies([{ name: 'owner-session', value: 'retained', domain: 'fixture.invalid', path: '/' }]);
    await worker.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<form onsubmit="event.preventDefault();document.querySelector(\'p\').textContent=\'Received\'"><label>Name<input></label><button>Submit</button></form><p></p>' }));
    assert.equal(await applicationWorkerPage(original), original, 'An open application page is retained.');
    await original.close(); // Same lifecycle as a timed-out agent script.
    const replacement = await applicationWorkerPage(original);
    assert.notEqual(replacement, original);
    assert.equal(replacement.context(), worker);
    assert.equal(other.isClosed(), false, 'Recovery must not borrow or close the other platform worker.');
    assert.equal((await worker.cookies('https://fixture.invalid')).find(cookie => cookie.name === 'owner-session')?.value, 'retained');
    await replacement.goto('https://fixture.invalid/next-application');
    await replacement.getByLabel('Name').fill('Alex Fixture');
    await replacement.getByRole('button', { name: 'Submit' }).click();
    assert.equal(await replacement.locator('p').innerText(), 'Received', 'A later application remains executable after timeout retirement.');
  } finally {
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
