import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Each account's Chrome profile belongs to this server alone: runs, sign-in
 * checks and the remote sign-in browser all open it, one at a time, and
 * nothing else ever should. So a Chrome that still holds it when a run wants
 * to start is always ours — most often a sign-in browser left behind when the
 * dashboard restarted and forgot it — and closing it is the right thing to
 * do. Left alone, it made every run for that account fail in under a second
 * with "Chrome is already running with this profile".
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pgrep(pattern: string): Promise<number[]> {
  return new Promise((done) => {
    execFile('pgrep', ['-f', pattern], (error, stdout) => {
      if (error) return done([]);
      done(stdout.split(/\s+/).filter(Boolean).map(Number).filter((pid) => Number.isFinite(pid) && pid !== process.pid));
    });
  });
}

function commandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

/** Chrome processes holding this profile directory, browser (top-level) processes first. */
async function holders(profileDir: string): Promise<{ browsers: number[]; all: number[] }> {
  const escaped = profileDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const all = await pgrep(`--user-data-dir=${escaped}( |$)`);
  const browsers = all.filter((pid) => !/--type=/.test(commandLine(pid)));
  return { browsers, all };
}

/**
 * Makes the profile free to open, closing any Chrome that still has it.
 * Asks politely first, so Chrome writes its state and removes its lock, and
 * forces only what ignores that. Resolves once the lock is gone or the wait
 * runs out; the caller's launch then reports whatever remains.
 */
export async function releaseChromeProfile(profileDir: string, log?: (line: string) => void): Promise<boolean> {
  if (process.platform !== 'linux') return true;
  const { browsers, all } = await holders(profileDir);
  if (!all.length) return true;

  log?.(`Closing a browser that was still open on this profile (${browsers.length || all.length} process(es)).`);
  for (const pid of browsers.length ? browsers : all) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  for (let i = 0; i < 12; i++) {
    await wait(500);
    if (!(await holders(profileDir)).all.length) break;
  }
  const remaining = (await holders(profileDir)).all;
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (remaining.length) await wait(500);
  return !(await holders(profileDir)).all.length;
}
