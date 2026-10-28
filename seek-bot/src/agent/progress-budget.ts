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

  constructor(base: number, maximum = 0.70) {
    base = Number.isFinite(base) && base > 0 ? base : 0.20;
    maximum = Number.isFinite(maximum) && maximum > 0 ? maximum : 0.70;
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
    // cannot fund an otherwise stuck application all the way to the maximum.
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
