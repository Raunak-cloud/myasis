import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ManualLoginResult {
  ok: boolean;
  error?: string;
}

/**
 * Opens SEEK in ordinary desktop Chrome using Myasis's persistent profile.
 *
 * This is deliberately separate from Playwright and CDP. Security checks such
 * as Cloudflare Turnstile may reject synthetic input even when it came from a
 * person using the dashboard's streamed browser. This handoff gives the user a
 * real Chrome window and normal OS mouse/keyboard input; it does not automate
 * login or attempt to solve a challenge.
 */
export function openSeekManualLogin(env: Record<string, string>): Promise<ManualLoginResult> {
  if (env.BROWSER_CONNECT_CDP === 'true') {
    return Promise.resolve({
      ok: false,
      error:
        'This Myasis installation uses a remote managed browser. Open its secure remote desktop to sign in; the dashboard cannot open that browser on this computer.',
    });
  }

  if (process.platform !== 'win32' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return Promise.resolve({
      ok: false,
      error:
        'No desktop is available on this server. Use a secure remote desktop session to complete the SEEK sign-in.',
    });
  }

  const chromePath = env.CHROME_PATH?.trim();
  const profileDir = env.CHROME_PROFILE_DIR?.trim();
  if (!chromePath || !existsSync(chromePath)) {
    return Promise.resolve({ ok: false, error: 'The configured Chrome application could not be found.' });
  }
  if (!profileDir) {
    return Promise.resolve({ ok: false, error: 'CHROME_PROFILE_DIR is not configured.' });
  }

  return new Promise((resolve) => {
    const child = spawn(
      chromePath,
      [
        `--user-data-dir=${profileDir}`,
        '--new-window',
        '--no-first-run',
        '--no-default-browser-check',
        'https://www.seek.com.au/',
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      },
    );

    child.once('error', (error) => {
      resolve({ ok: false, error: `Chrome could not be opened: ${error.message}` });
    });
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}
