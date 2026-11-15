import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'patchright';
import { inspectJoraSession, checkJoraSession } from './jora-session.js';

test('Jora verifies the account, persists it and distinguishes sign-out from blocked/unknown pages', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'jora-session-test-'));
  const before = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
  try {
    const page = await browser.newPage();
    await page.context().setOffline(true);
    let html = '<h1>Settings</h1><h2>Account</h2><p>candidate@example.test</p><button>Edit</button><button>Delete</button>';
    let status = 200, login = false;
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://au.jora.com') return route.abort();
      if (login && url.pathname === '/account') return route.fulfill({ contentType: 'text/html', body: '<script>history.replaceState(null,"","/users/sign_in")</script>' + html });
      return route.fulfill({ status, contentType: 'text/html', body: html });
    });
    await checkJoraSession(page);
    const path = resolve(directory, 'jora-session.json');
    const connected = readFileSync(path, 'utf8');
    assert.equal(JSON.parse(connected).signedIn, true);
    assert.equal(JSON.parse(connected).account, 'candidate@example.test');
    if (process.platform !== 'win32') assert.equal((await import('node:fs')).statSync(path).mode & 0o777, 0o600);
    status = 403; html = '<h1>Security verification</h1>';
    await assert.rejects(checkJoraSession(page), /HTTP 403/);
    assert.equal(readFileSync(path, 'utf8'), connected, 'access failure must not invent a signed-out state');
    status = 200; login = true; html = '<h1>Jobseeker log in</h1><input type="email"><input type="password">';
    assert.deepEqual(await inspectJoraSession(page), { signedIn: false, account: null });
    await assert.rejects(checkJoraSession(page), /not signed in/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).signedIn, false);
    login = false; html = '<h1>Settings</h1><p>Account</p><button>Edit</button><button>Delete</button>';
    await assert.rejects(inspectJoraSession(page), /clear account/);
    assert.equal(existsSync(path), true);
  } finally {
    await browser.close();
    if (before === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = before;
    rmSync(directory, { recursive: true, force: true });
  }
});
