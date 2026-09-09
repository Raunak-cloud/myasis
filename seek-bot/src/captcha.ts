import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'patchright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const attempts = new WeakMap<Page, { url: string; time: number }>();
export const captchaEnabled = () => process.env.CAPTCHA_SOLVER === 'click';

/** Returns true only when the bridge completed; callers must re-check the page. */
export async function trySolveCaptcha(page: Page): Promise<boolean> {
  if (!captchaEnabled()) return false;
  const previous = attempts.get(page);
  if (previous?.url === page.url() && Date.now() - previous.time < 60_000) return false;
  const cloudflare = page.frames().some(f => f.url().startsWith('https://challenges.cloudflare.com/'));
  const interstitial = await page.locator('#challenge-running, #challenge-stage').count().catch(() => 0);
  if (!cloudflare && !interstitial) return false;
  attempts.set(page, { url: page.url(), time: Date.now() });
  try {
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
    return await new Promise<boolean>((resolveResult) => {
      const child = execFile(python, [resolve(root, 'scripts/captcha_bridge.py')], {
        timeout: 50_000, windowsHide: true, maxBuffer: 64 * 1024,
      }, (error, stdout) => {
        try {
          const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '{}');
          if (error || result.ok !== true) throw new Error('Solver failed');
          resolveResult(true);
        } catch {
          console.warn('[captcha] Solve unavailable or unsuccessful; handing off to human.');
          resolveResult(false);
        }
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({ endpoint, targetId, url: page.url(),
        captchaType: interstitial ? 'CLOUDFLARE_INTERSTITIAL' : 'CLOUDFLARE_TURNSTILE' }) + '\n');
    });
  } catch {
    return false;
  }
}
