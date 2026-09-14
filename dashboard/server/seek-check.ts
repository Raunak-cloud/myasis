import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOT_DIR, readEnv, runner, MAX_CONCURRENT } from './runner.js';
import { sessionFor } from './signin.js';
import { readSiteState, type SeekState, type SigninSite } from './seek-state.js';
import { userChromeDir, userDir } from './userdata.js';

/**
 * Finds out whether an account is really signed in to SEEK.
 *
 * Closing the sign-in window used to be taken as proof. It is not: a person
 * can close it early, mistype, or hit a challenge, and the next run then
 * fails a day later. This opens the account's own Chrome profile the way a
 * run does and lets `seek-bot`'s own sign-in check answer, so the source of
 * truth is SEEK's profile page, not a button.
 *
 * One check per account at a time, and none while that profile is in use —
 * Chrome locks a profile directory, so a run or an open sign-in window has
 * to finish first. Two accounts can be checked side by side; each gets its
 * own DevTools port outside the range the runs use.
 */

const CHECK_TIMEOUT_MS = 90_000;
const LOCK_WAIT_MS = 6_000;
const inFlight = new Map<string, Promise<SeekState | null>>();
let nextPortOffset = 0;

export function seekCheckInProgress(userId: string, site: SigninSite = 'seek'): boolean {
  return inFlight.has(`${userId}:${site}`);
}

/** Chrome drops this the moment it has really exited; SIGTERM alone returns before that. */
async function waitForProfileFree(profileDir: string): Promise<boolean> {
  const lock = resolve(profileDir, 'SingletonLock');
  const until = Date.now() + LOCK_WAIT_MS;
  while (existsSync(lock)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

function checkPort(): number {
  const env = readEnv();
  const first = Number(process.env.CDP_PORT ?? env.CDP_PORT ?? 9333);
  // Past every viewer slot a run could hold, cycling so two checks never collide.
  const port = first + MAX_CONCURRENT + 1 + (nextPortOffset % 8);
  nextPortOffset += 1;
  return port;
}

/**
 * Resolves to the recorded state once SEEK has answered, or to whatever was
 * already known when the profile could not be opened. Never throws: a check
 * that cannot run leaves the prompt where it was, which is the safe outcome.
 */
export function checkSeekSignin(userId: string): Promise<SeekState | null> {
  return checkSignin(userId, 'seek');
}

export function checkSignin(userId: string, site: SigninSite): Promise<SeekState | null> {
  const key = `${userId}:${site}`;
  const running = inFlight.get(key);
  if (running) return running;
  const known = () => readSiteState(userId, site);

  const task = (async () => {
    if (runner.stateFor(userId).running || sessionFor(userId)) return known();
    if (!existsSync(resolve(BOT_DIR, 'dist', 'check-signin.js'))) return known();

    const profileDir = userChromeDir(userId);
    if (!(await waitForProfileFree(profileDir))) return known();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SIGNIN_SITE: site,
      CHROME_PROFILE_DIR: profileDir,
      CDP_PORT: String(checkPort()),
      DATA_DIR: userDir(userId),
    };

    await new Promise<void>((done) => {
      const child = spawn(process.execPath, ['dist/check-signin.js'], { cwd: BOT_DIR, env, stdio: 'ignore' });
      const timer = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS);
      child.on('error', () => {
        clearTimeout(timer);
        done();
      });
      child.on('close', () => {
        clearTimeout(timer);
        done();
      });
    });
    return known();
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}
