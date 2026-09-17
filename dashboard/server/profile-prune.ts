import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { runner } from './runner.js';
import { sessionFor } from './signin.js';
import { USERS_DIR, userChromeDir } from './userdata.js';

/**
 * Keeps each account's Chrome profile from eating the disk.
 *
 * Every account gets its own profile so its SEEK and Indeed sessions stay
 * separate, and a profile grows without limit as runs accumulate HTTP cache,
 * compiled scripts and downloaded Chrome components. Measured on this
 * installation: 500 MB for one account after a hundred runs, against a 14 MB
 * database for the whole product. At a few hundred accounts the profiles, not
 * the data, are what fills the disk.
 *
 * Almost all of that bulk is disposable. What has to survive is anything that
 * proves who the candidate is — cookies, local storage, IndexedDB, saved
 * logins — because losing it signs them out of the job boards and no run can
 * apply until they sign in again by hand.
 */

/**
 * Directories Chrome rebuilds on demand, relative to the profile root.
 *
 * Only entries whose sole purpose is caching. Everything to do with identity
 * is deliberately absent: `Cookies`, `Local Storage`, `Session Storage`,
 * `IndexedDB`, `Login Data`, `Preferences`, `Network` and `Storage` all stay,
 * as does `Service Worker/Database`, which holds registrations rather than
 * cached payloads.
 */
const DISPOSABLE = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnWebGPUCache',
  'Default/DawnGraphiteCache',
  'Default/Service Worker/CacheStorage',
  'Default/Service Worker/ScriptCache',
  'Default/Shared Dictionary',
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'BrowserMetrics',
  'component_crx_cache',
  'optimization_guide_model_store',
  'OnDeviceHeadSuggestModel',
  'WasmTtsEngine',
  'Safe Browsing',
  'ActorSafetyLists',
  'ZxcvbnData',
  'hyphen-data',
];

/** Chrome drops this only once it has really exited; a profile holding it is in use. */
function profileLocked(profileDir: string): boolean {
  return existsSync(resolve(profileDir, 'SingletonLock'));
}

function directorySize(path: string): number {
  let total = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        try {
          total += statSync(child).size;
        } catch {
          // Vanished mid-walk; it was not going to be counted for long anyway.
        }
      }
    }
  };
  walk(path);
  return total;
}

/**
 * Removes the disposable caches from one account's profile.
 *
 * Refuses while that account has a run going, a sign-in window open, or a
 * Chrome still holding the profile lock: deleting underneath a live browser
 * corrupts the profile, which would cost the candidate their job-board
 * sessions — the exact thing this is written to protect.
 */
export function pruneProfile(userId: string): { skipped: true; reason: string } | { skipped: false; freedBytes: number } {
  if (runner.stateFor(userId).running) return { skipped: true, reason: 'a run is going' };
  if (sessionFor(userId)) return { skipped: true, reason: 'a sign-in window is open' };

  const profileDir = userChromeDir(userId);
  if (!existsSync(profileDir)) return { skipped: true, reason: 'no profile yet' };
  if (profileLocked(profileDir)) return { skipped: true, reason: 'the profile is still locked by Chrome' };

  let freed = 0;
  for (const relative of DISPOSABLE) {
    const target = resolve(profileDir, relative);
    // resolve() collapses any traversal; refuse anything that escaped the profile.
    if (!target.startsWith(profileDir) || !existsSync(target)) continue;
    const size = directorySize(target);
    try {
      rmSync(target, { recursive: true, force: true });
      freed += size;
    } catch {
      // Locked or already gone; the next pass will get it.
    }
  }
  return { skipped: false, freedBytes: freed };
}

/** Every account with a profile on disk. */
function accountsWithProfiles(): string[] {
  try {
    return readdirSync(USERS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function pruneAllProfiles(): { freedBytes: number; pruned: number; skipped: number } {
  let freedBytes = 0;
  let pruned = 0;
  let skipped = 0;
  for (const userId of accountsWithProfiles()) {
    const result = pruneProfile(userId);
    if (result.skipped) skipped += 1;
    else {
      pruned += 1;
      freedBytes += result.freedBytes;
    }
  }
  return { freedBytes, pruned, skipped };
}

let maintenance: NodeJS.Timeout | null = null;

/**
 * Prunes every idle profile once a day, starting a few minutes after boot.
 *
 * Daily rather than after each run: a profile in use is skipped, and an
 * account that runs all day would otherwise never be pruned at all, whereas
 * over 24 hours every profile is idle at some point.
 */
export function startProfileMaintenance(): void {
  if (maintenance) return;
  const prune = () => {
    try {
      const { freedBytes, pruned, skipped } = pruneAllProfiles();
      if (freedBytes > 0) {
        console.log(`[profiles] freed ${(freedBytes / 1024 / 1024).toFixed(0)} MB from ${pruned} profile(s), ${skipped} in use`);
      }
    } catch (error) {
      console.warn('[profiles] prune failed:', (error as Error).message);
    }
  };
  setTimeout(prune, 5 * 60_000).unref();
  maintenance = setInterval(prune, 24 * 60 * 60 * 1000);
  maintenance.unref();
}
