import type { Page } from 'patchright';
import { writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

/** Only Jora's account page can establish a connection. Public search needs no login. */
export async function inspectJoraSession(page: Page): Promise<{ signedIn: boolean; account: string | null }> {
  const response = await page.goto('https://au.jora.com/account', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  if (response && response.status() >= 400) throw new Error(`Jora account check returned HTTP ${response.status()}.`);
  const read = () => page.evaluate(() => {
    if (location.hostname !== 'au.jora.com') return null;
    const text = document.body?.innerText ?? '';
    if (location.pathname === '/account' && /\bSettings\b/i.test(text) && /\bAccount\b/i.test(text)
      && /Edit/.test(text) && /Delete/.test(text)) {
      const account = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
      if (account) return { signedIn: true, account };
    }
    if (/\/users\/sign_in\b/.test(location.pathname) && /log in|sign in/i.test(text)
      && document.querySelector('input[type="password"]')) return { signedIn: false, account: null };
    return null;
  });
  await page.waitForFunction(() => {
    const text = document.body?.innerText ?? '';
    return location.hostname === 'au.jora.com' && (
      location.pathname === '/account' && /\bSettings\b/.test(text) && /Edit/.test(text) && /Delete/.test(text)
      || /\/users\/sign_in\b/.test(location.pathname) && !!document.querySelector('input[type="password"]'));
  }, undefined, { timeout: 8_000 });
  const result = await read();
  if (!result) throw new Error('Jora did not provide a clear account or login page.');
  return result;
}

export async function checkJoraSession(page: Page): Promise<void> {
  const state = await inspectJoraSession(page);
  const path = resolve(config.dataDir, 'jora-session.json');
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...state, checkedAt: new Date().toISOString(), source: 'run',
    signedOutByPerson: false, autoSigninFailed: false }), { mode: 0o600 });
  renameSync(temporary, path);
  if (!state.signedIn) throw new Error('Jora session is not signed in.');
}
