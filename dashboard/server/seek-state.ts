import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureUserDataDir, userDir } from './userdata.js';

/**
 * Whether an account is signed in to SEEK.
 *
 * There is no cheap way to ask this directly: the answer lives in a Chrome
 * profile's cookie store, and the only component that ever really finds out
 * is a run, when `assertSignedIn` loads the profile page. So this is a small
 * cache of the last thing anybody learned, written from two places and read
 * by the Apply page to decide whether to prompt at all.
 *
 * `seek-bot/src/browser.ts` writes the same file with `source: 'run'` and
 * must keep this shape in step.
 */
export interface SeekState {
  signedIn: boolean;
  checkedAt: string;
  /** 'run' is observed fact; 'declared' is the person saying so themselves. */
  source: 'run' | 'declared';
}

const FILE = 'seek-session.json';

export function readSeekState(userId: string): SeekState | null {
  const path = resolve(userDir(userId), FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SeekState>;
    if (typeof parsed.signedIn !== 'boolean') return null;
    return {
      signedIn: parsed.signedIn,
      checkedAt: parsed.checkedAt ?? new Date().toISOString(),
      source: parsed.source === 'run' ? 'run' : 'declared',
    };
  } catch {
    return null;
  }
}

export function writeSeekState(userId: string, state: SeekState): void {
  try {
    ensureUserDataDir(userId);
    writeFileSync(resolve(userDir(userId), FILE), JSON.stringify(state, null, 2));
  } catch {
    // A prompt shown once too often is not worth failing a request over.
  }
}
