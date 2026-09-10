import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ManualLoginResult {
  ok: boolean;
  error?: string;
}

/**
 * Opens SEEK in ordinary desktop Chrome using Myasis's persistent profile.
 *
 * This is deliberately separate from Patchright and CDP. Security checks such
 * as Cloudflare Turnstile may reject synthetic input even when it came from a
 * person using the dashboard's streamed browser. This handoff gives the user a
 * real Chrome window and normal OS mouse/keyboard input; it does not automate
 * login or attempt to solve a challenge.
 */
export function openSeekManualLogin(
  env: Record<string, string>,
  /**
   * This account's own Chrome profile. Signing in has to happen in the same
   * profile the account's runs use, otherwise the run finds no SEEK session —
   * or worse, finds somebody else's.
   */
  chromeProfileDir?: string,
): Promise<ManualLoginResult> {
  if (env.BROWSER_CONNECT_CDP === 'true') {
    return Promise.resolve({
      ok: false,
      error:
        'This Myasis installation uses a remote managed browser. Open its secure remote desktop to sign in; the dashboard cannot open that browser on this computer.',
    });
  }

  /**
   * A server has no screen, even once Xvfb gives it a DISPLAY.
   *
   * Testing DISPLAY alone was a trap: with Xvfb running for the bot, this
   * would happily open Chrome on a virtual screen nobody can look at and
   * report success. On Linux the remote sign-in flow (server/signin.ts) is
   * the supported route, so this stays for desktop use only.
   */
  if (process.platform === 'linux') {
    return Promise.resolve({
      ok: false,
      error: 'This server has no desktop. Use "Open SEEK sign-in" in Setup, which streams a private browser to you.',
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
  const profileDir = chromeProfileDir?.trim() || env.CHROME_PROFILE_DIR?.trim();
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
