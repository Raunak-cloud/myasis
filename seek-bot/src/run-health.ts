import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

/**
 * How this run went, for the operator's alerts.
 *
 * A machine-readable handoff to the dashboard, like run-summary.json, but
 * rewritten on every change rather than once at the end: the runs worth
 * alerting about are the ones that die part-way (a provider out of credit, a
 * crash), and those never reach an end-of-run write.
 */
interface RunHealth {
  /** Applications the agent actually attempted. */
  attempted: number;
  applied: number;
  needsHuman: number;
  /** Cover letters sent humanized, and sent as the plain grounded draft. */
  humanizedLetters: number;
  draftLetters: number;
  /** Attempts whose submit was pressed but that were not confirmed as sent. */
  unconfirmedSubmits: number;
  /** Providers that refused for lack of credit, by name. */
  providerOutOfCredit: string[];
}

const FILE = resolve(config.dataDir, 'run-health.json');
const health: RunHealth = {
  attempted: 0, applied: 0, needsHuman: 0, humanizedLetters: 0, draftLetters: 0, unconfirmedSubmits: 0, providerOutOfCredit: [],
};

function save(): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify({ ...health, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    // Reporting must never break a run.
  }
}

type Counter = Exclude<keyof RunHealth, 'providerOutOfCredit'>;

export function countHealth(counter: Counter, by = 1): void {
  health[counter] += by;
  save();
}

export function providerOutOfCredit(provider: string): void {
  if (health.providerOutOfCredit.includes(provider)) return;
  health.providerOutOfCredit.push(provider);
  save();
}
