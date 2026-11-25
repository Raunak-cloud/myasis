import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import type { RunSearchProgress } from './run-progress.js';

/**
 * How this run went, for the operator's alerts.
 *
 * A machine-readable handoff to the dashboard, like run-summary.json, but
 * rewritten on every change rather than once at the end: the runs worth
 * alerting about are the ones that die part-way (a provider out of credit, a
 * crash), and those never reach an end-of-run write.
 */
interface RunHealth {
  /** Newly recorded suitability decisions. Reuse and failed reviews do not increment this. */
  reviewed: number;
  search?: RunSearchProgress;
  errors: number;
  /** Applications the agent actually attempted. */
  attempted: number;
  applied: number;
  needsHuman: number;
  /** Attempts whose submit was pressed but that were not confirmed as sent. */
  unconfirmedSubmits: number;
  /**
   * Security checks, by how they ended: solved by CapMonster (a paid task),
   * not solved by it (also paid, unless it was refused outright), or cleared
   * by themselves before any solver was asked.
   */
  captchaSolved: number;
  captchaFailed: number;
  captchaSelfCleared: number;
  /** Providers that refused for lack of credit, by name. */
  providerOutOfCredit: string[];
}

const FILE = resolve(config.dataDir, 'run-health.json');
const health: RunHealth = {
  reviewed: 0, errors: 0,
  attempted: 0, applied: 0, needsHuman: 0, unconfirmedSubmits: 0,
  captchaSolved: 0, captchaFailed: 0, captchaSelfCleared: 0, providerOutOfCredit: [],
};
let lastSearch = '';

function save(): void {
  const temporary = `${FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ ...health, runStartId: process.env.OWTOMATE_RUN_START_ID, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temporary, FILE);
  } catch {
    // Reporting must never break a run.
    try { rmSync(temporary, { force: true }); } catch { /* Best-effort cleanup. */ }
  }
}

export function setRunSearchProgress(search: RunSearchProgress): void {
  const serialized = JSON.stringify(search);
  if (serialized === lastSearch) return;
  lastSearch = serialized;
  health.search = search;
  save();
}

type Counter = Exclude<keyof RunHealth, 'providerOutOfCredit' | 'search'>;

export function countHealth(counter: Counter, by = 1): void {
  health[counter] += by;
  save();
}

export function providerOutOfCredit(provider: string): void {
  if (health.providerOutOfCredit.includes(provider)) return;
  health.providerOutOfCredit.push(provider);
  save();
}
