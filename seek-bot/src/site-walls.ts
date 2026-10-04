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
 *
 * A security check belongs to the site, so it walls the whole host. A sign-in
 * that failed belongs to one employer's account: on a host many employers
 * share (SuccessFactors, SmartRecruiters) it walls only that employer.
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

const keyFor = (host: string, employer?: string) =>
  `${host.toLowerCase()}${employer?.trim() ? `|${employer.trim().toLowerCase()}` : ''}`;

/** What stopped this site, or this employer on it, within the last day, if anything. */
export function walledHost(host: string, employer?: string): Wall | null {
  const all = readAll();
  const now = Date.now();
  for (const key of [keyFor(host), ...(employer?.trim() ? [keyFor(host, employer)] : [])]) {
    if (standing(all[key], now)) return all[key];
  }
  return null;
}

/** `employer` scopes the wall to one employer's account; without it the whole host is walled. */
export function recordWall(host: string, reason: string, employer?: string): void {
  if (!host) return;
  const now = Date.now();
  const all = Object.fromEntries(Object.entries(readAll()).filter(([, wall]) => standing(wall, now)));
  all[keyFor(host, employer)] = { at: new Date(now).toISOString(), reason };
  try { writeFileSync(FILE(), JSON.stringify(all, null, 2)); } catch { /* a wall not remembered costs one more attempt, never the run */ }
}
