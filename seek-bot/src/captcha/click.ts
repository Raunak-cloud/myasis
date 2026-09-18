import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'patchright';
import type { Solver } from './detect.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Clicks the Cloudflare checkbox in the bot's own tab through the Python
 * bridge. Free and solved in the real browser, so it goes first in a chain;
 * it knows nothing but Cloudflare.
 */
export const clickSolver: Solver = {
  name: 'click',
  supports: challenge => challenge.kind === 'cloudflare-challenge' || challenge.kind === 'turnstile',
  async solve(page: Page, challenge) {
    const session = await page.context().newCDPSession(page);
    let targetId: string;
    try {
      targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId;
    } finally {
      await session.detach();
    }
    const venv = resolve(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const python = process.env.CAPTCHA_PYTHON || (existsSync(venv) ? venv : 'python');
    const endpoint = process.env.BROWSER_CONNECT_CDP === 'true'
      ? `http://${process.env.CDP_HOST}:${process.env.CDP_PORT}`
      : `http://127.0.0.1:${process.env.CDP_PORT || '9222'}`;
    return new Promise<boolean>((resolveResult) => {
      const child = execFile(python, [resolve(root, 'scripts/captcha_bridge.py')], {
        timeout: 50_000, windowsHide: true, maxBuffer: 64 * 1024,
      }, (error, stdout) => {
        try {
          const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '{}');
          if (error || result.ok !== true) throw new Error(result.error || 'Solver failed');
          resolveResult(true);
        } catch (reason) {
          const detail = reason instanceof Error ? ` (${reason.message})` : '';
          console.warn(`[captcha] click: unavailable or unsuccessful${detail}.`);
          resolveResult(false);
        }
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({ endpoint, targetId, url: page.url(),
        captchaType: challenge.kind === 'cloudflare-challenge' ? 'CLOUDFLARE_INTERSTITIAL' : 'CLOUDFLARE_TURNSTILE' }) + '\n');
    });
  },
};
