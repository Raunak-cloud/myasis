import { CostMeter } from './celeris.js';
import type { FormField } from '../types.js';

const normalise = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
const identity = (field: FormField) => JSON.stringify([normalise(field.section ?? ''), normalise(field.label), field.kind]);
const usable = (field: FormField) => !field.sensitive && field.inputType !== 'password' && field.currentValue !== '[private credential]';
const completed = (field: FormField) => Boolean(field.currentValue?.trim()) && !field.validationError;

/** Extra spend is earned by browser evidence, never by the agent's progress notes. */
export class ProgressBudget extends CostMeter {
  private previous?: Map<string, { complete: boolean }>;
  private readonly credited = new Set<string>();
  private readonly stages = new Set<string>();
  private allowance: number;
  private progress = 0;
  readonly maximum: number;

  constructor(base: number, maximum = 0.50) {
    base = Number.isFinite(base) && base > 0 ? base : 0.20;
    maximum = Number.isFinite(maximum) && maximum > 0 ? maximum : 0.50;
    super(base);
    this.allowance = base;
    this.maximum = Math.max(base, maximum);
  }

  get limitUsd(): number { return this.allowance; }
  get progressCount(): number { return this.progress; }
  override get exhausted(): boolean { return this.totals.costUsd + 1e-9 >= this.allowance; }

  private credit(key: string): void {
    if (this.credited.has(key)) return;
    this.credited.add(key);
    this.progress++;
    // At most ten more cents after the latest new progress. One early success
    // cannot fund an otherwise stuck application all the way to fifty cents.
    this.allowance = Math.min(this.maximum, Math.max(this.allowance, this.totals.costUsd + 0.10));
  }

  observe(fields: FormField[], mutated: boolean): void {
    const current = new Map(fields.filter(usable).map(field => [identity(field), { complete: completed(field) }]));
    const stage = JSON.stringify([...current.keys()].sort());
    if (this.previous && mutated) {
      for (const [key, field] of current) {
        const before = this.previous.get(key);
        if (before && field.complete && !before.complete) this.credit(`field:${key}`);
      }
      // New questions replacing the previous questions establish a new form
      // stage. URL changes, spinners, text churn and revisiting a stage do not.
      if (this.previous.size && current.size && !this.stages.has(stage)
        && [...this.previous.keys()].some(key => !current.has(key))
        && [...current.keys()].some(key => !this.previous!.has(key))) this.credit(`stage:${stage}`);
    }
    for (const [key, field] of current) if (field.complete) this.credited.add(`field:${key}`);
    this.stages.add(stage);
    this.previous = current;
  }

  uploaded(documentKey: string): void { this.credit(`upload:${documentKey}`); }
}

/** Renew a short turn window only for new browser evidence, with a hard cap. */
export class ProgressStepBudget {
  private limit: number;
  private seenProgress = 0;
  private renewedProgress = 0;
  private lastProgressTurn = -Infinity;
  private readonly window: number;
  readonly maximum: number;

  constructor(normalTurns: number, maximum = 120) {
    this.maximum = Number.isFinite(maximum) && maximum >= 1 ? Math.min(120, Math.floor(maximum)) : 120;
    this.limit = Math.min(this.maximum, Number.isFinite(normalTurns) && normalTurns >= 1 ? Math.floor(normalTurns) : 60);
    this.window = Math.min(20, this.limit);
  }

  permits(completedTurns: number, progressCount: number): boolean {
    if (progressCount > this.seenProgress) {
      this.seenProgress = progressCount;
      this.lastProgressTurn = completedTurns;
    }
    if (completedTurns < this.limit) return true;
    if (this.limit >= this.maximum || this.seenProgress <= this.renewedProgress
      || completedTurns - this.lastProgressTurn > this.window) return false;
    this.limit = Math.min(this.maximum, this.limit + this.window);
    this.renewedProgress = this.seenProgress;
    return completedTurns < this.limit;
  }
}
