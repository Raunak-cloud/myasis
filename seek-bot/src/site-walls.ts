import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

/**
 * Employer sites whose security check Owtomate could not clear, so the next
 * job on the same site is not attempted for a while.
 *
 * A check that fails is a property of the site and this account's browser
 * and address, not of the job: one run pressed submit on three Lever forms
 * (Deputy, Objective twice) and lost each to the same hCaptcha, two minutes
 * and a model bill apiece. A wall stands for a day, long enough to cover a
 * run and its automatic repeats, short enough that a changed address or a
 * solver that has learnt the check gets its chance.
 */
const FILE = () => resolve(config.dataDir, 'site-walls.json');
const WALL_STANDS_MS = 24 * 60 * 60_000;

interface Wall { at: string; reason: string }

function readAll(): Record<string, Wall> {
  try {
    return existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), 'utf8')) : {};
  } catch {
    return {};
  }
}

const standing = (wall: Wall | undefined, now: number): wall is Wall =>
  Boolean(wall && now - Date.parse(wall.at) < WALL_STANDS_MS);

/** The check that stopped this site within the last day, if any. */
export function walledHost(host: string): Wall | null {
  const wall = readAll()[host.toLowerCase()];
  return standing(wall, Date.now()) ? wall : null;
}

export function recordWall(host: string, reason: string): void {
  if (!host) return;
  const now = Date.now();
  const all = Object.fromEntries(Object.entries(readAll()).filter(([, wall]) => standing(wall, now)));
  all[host.toLowerCase()] = { at: new Date(now).toISOString(), reason };
  try { writeFileSync(FILE(), JSON.stringify(all, null, 2)); } catch { /* a wall not remembered costs one more attempt, never the run */ }
}
