import type { Observation } from './observe.js';
import type { ToolSchema } from './celeris.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InteractionMemory } from './interaction-memory.js';

const text = { type: 'string', minLength: 1 };
const evidence = { type: 'array', minItems: 1, items: text };
export const recoveryTools: ToolSchema[] = [
  { name: 'record_recovery_plan', description: 'Required recovery checkpoint when requested. Briefly diagnose the observed problem, distinguish evidence from uncertainty, choose a materially different next approach and specify its observable verification. Records your decision; performs no browser action.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      observed_issue: text, evidence, previous_approaches: evidence, next_action: text, verification: text,
    }, required: ['observed_issue', 'evidence', 'previous_approaches', 'next_action', 'verification'] } },
  { name: 'record_recovery_result', description: 'Required after acting on a recovery plan. Assess the fresh browser evidence against your recorded verification. Tool success alone is not progress. complete means an actual submitted application with an observed employer receipt: include its complete receipt_quote, which records your applied judgment without another model call. Otherwise use progress, no_progress or more_evidence. Never submits or verifies receipt independently.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      assessment: { type: 'string', enum: ['progress', 'no_progress', 'more_evidence', 'complete'] }, evidence, next_action: text,
      receipt_quote: { type: 'string', minLength: 1, maxLength: 4000 },
    }, required: ['assessment', 'evidence', 'next_action'] } },
];

/** Extra narration is harmless metadata, never an additional browser instruction.
 * Preserve all declared content; do not invent missing reasoning or receipt text. */
export function recoveryInput(name: string, value: Record<string, unknown>): Record<string, unknown> {
  const properties = recoveryTools.find(tool => tool.name === name)?.parameters.properties as Record<string, unknown> | undefined;
  return properties ? Object.fromEntries(Object.entries(value).filter(([key]) => key in properties)) : value;
}

/** Schedules an agent-authored plan/check, never answers or repairs a form.
 * Ref churn, screenshots, clocks and narration cannot clear a stalled state. */
export class RecoveryCheckpoint {
  private readonly memory = new InteractionMemory();
  private observation?: Observation;
  private pending: string[] = [];
  private edges = new Map<string, number>();
  private seen = new Set<string>();
  private credited = new Set<string>();
  private changedByAction = false;
  private progressCandidate?: string;
  private transitions: string[] = [];
  private note = '';
  private previousAttempt = '';
  private budgetReview = false;
  private reviewable = false;
  private goal = '';

  constructor(private readonly journal?: string, goal = '') {
    this.goal = goal;
    if (journal) try {
      const saved = JSON.parse(readFileSync(journal, 'utf8'));
      this.previousAttempt = JSON.stringify({ status: saved.status, sendAttempted: saved.sendAttempted,
        note: saved.note, transitions: saved.transitions?.slice(-4), failures: saved.failedInteractions }).slice(-4000);
    } catch { /* No historical journal, or unusable diagnostics. */ }
  }

  private persist(extra: Record<string, unknown> = {}): void {
    if (!this.journal) return;
    try {
      mkdirSync(dirname(this.journal), { recursive: true, mode: 0o700 });
      const temporary = this.journal + `.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ goal: this.goal, savedAt: new Date().toISOString(),
        note: this.note, transitions: this.transitions, failedInteractions: this.memory.render(), ...extra }), { mode: 0o600 });
      renameSync(temporary, this.journal);
    } catch { /* Diagnostics must never block an application. */ }
  }

  remember(note: string): void { this.note = note.slice(-6000); this.persist(); }
  failed(tool: string, args: Record<string, unknown>, url: string, error: string): void {
    this.memory.failed(tool, args, url, error); this.persist();
  }
  finish(status: string, sendAttempted: boolean): void { this.persist({ status, sendAttempted }); }
  render(): string {
    return `${this.previousAttempt ? `PREVIOUS ATTEMPT (historical agent claims only; inspect the current page, never replay a send or adopt old answers blindly): ${this.previousAttempt}\n` : ''}${this.memory.render()}\nRECENT ACTION OUTCOMES (changed does not necessarily mean closer to submission): ${JSON.stringify(this.transitions)}\nRECORDED PLAN / PROGRESS: ${this.note}`;
  }
  get reviewingBudget(): boolean { return this.budgetReview; }
  requestBudgetReview(): boolean {
    if (this.tool || !this.reviewable) return false;
    this.budgetReview = true; this.phase = 'verify'; this.reviewable = false;
    return true;
  }
  private phase: 'normal' | 'plan' | 'act' | 'verify' = 'normal';
  private previous?: string;
  private browserTurn = false;
  private failures = 0;
  private unchanged = 0;
  private invalid = 0;
  private furtherInspections = 0;
  private actionPending = false;

  observe(observation: Observation): void {
    const signature = createHash('sha256').update(JSON.stringify([observation.url, observation.fields.map(field => [
      field.section, field.label, field.kind, field.sensitive || field.inputType === 'password' ? '[private]' : field.currentValue,
      field.validationError, field.options, field.disabled,
    ]), observation.actions.map(action => [action.text, action.role, action.context, action.selected, action.disabled]),
    observation.surfaceText ?? observation.text.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '[clock]')])).digest('hex');
    this.changedByAction = this.pending.length > 0 && signature !== this.previous && !this.seen.has(signature);
    if (this.pending.length) this.progressCandidate = this.changedByAction ? signature : undefined;
    if (this.changedByAction) this.reviewable = true;
    if (this.pending.length && this.previous) {
      const action = this.pending.join(' + ');
      const edge = JSON.stringify([this.previous, action, signature]);
      const count = (this.edges.get(edge) ?? 0) + 1;
      this.edges.set(edge, count);
      this.transitions.push(`${action}: ${signature === this.previous ? 'unchanged' : this.seen.has(signature) ? 'returned to a previous state' : 'changed'}${count > 1 ? `; repeated ${count} times` : ''}`);
      this.transitions = this.transitions.slice(-12);
      if (count >= 2 && this.phase === 'normal') this.phase = 'plan';
    }
    this.pending = []; this.seen.add(signature); this.observation = observation;
    if (signature !== this.previous) {
      if (this.previous !== undefined && this.phase === 'act') this.phase = 'verify';
      this.unchanged = 0; this.failures = 0;
    }
    else if (this.browserTurn) this.unchanged++;
    this.previous = signature;
    this.browserTurn = false;
    if (this.phase === 'normal' && (this.failures >= 2 || this.unchanged >= 5)) this.phase = 'plan';
    this.persist();
  }

  get tool(): string | undefined {
    return this.phase === 'plan' ? 'record_recovery_plan' : this.phase === 'verify' ? 'record_recovery_result' : undefined;
  }

  /** A formatting failure must not terminate an otherwise usable application.
   * After one correction, release the checkpoint; normal tools and budgets remain. */
  rejected(): boolean {
    if (++this.invalid < 2) return false;
    this.phase = 'normal'; this.invalid = 0; this.failures = 0; this.unchanged = 0;
    this.browserTurn = false; this.actionPending = false;
    this.budgetReview = false;
    return true;
  }

  planned(args?: Record<string, unknown>): void {
    this.phase = 'act'; this.invalid = 0; this.failures = 0; this.unchanged = 0;
    this.furtherInspections = 0;
    if (args) this.remember(`RECOVERY PLAN: ${JSON.stringify(args)}`);
  }

  verified(assessment: string, args?: Record<string, unknown>): string | undefined {
    // The agent judges meaningful progress. Only fresh, action-grounded states
    // can fund another interval; revisits and narration cannot mint allowance.
    const credit = assessment === 'progress' && this.progressCandidate && this.progressCandidate === this.previous && !this.credited.has(this.progressCandidate) ? this.progressCandidate : undefined;
    if (credit) this.credited.add(credit);
    this.progressCandidate = undefined;
    this.budgetReview = false;
    if (args) this.remember(`${this.note}\nRECOVERY RESULT: ${JSON.stringify(args)}`);
    this.invalid = 0;
    if (assessment === 'no_progress') this.phase = 'plan';
    else if (assessment === 'more_evidence') this.phase = ++this.furtherInspections >= 2 ? 'plan' : 'act';
    else { this.phase = 'normal'; this.failures = 0; this.unchanged = 0; this.furtherInspections = 0; }
    return credit;
  }

  acted(tool: string, failed: boolean, args: Record<string, unknown> = {}): void {
    const changesPage = tool === 'browser_action'
      ? ['click', 'fill', 'select', 'check', 'press', 'navigate', 'script', 'dialog', 'set_input_files'].includes(String(args.action)) || args.sends_application === true
      : tool === 'browser_batch'
        ? Array.isArray(args.actions) && args.actions.some(action => ['click', 'fill', 'select', 'check', 'press', 'script', 'navigate', 'dialog', 'set_input_files'].includes(String(action.action)))
        : ['complete_authentication', 'enter_emailed_code', 'open_emailed_link'].includes(tool);
    if (this.phase === 'act' && changesPage) this.actionPending = true;
    if (changesPage) {
      const commands = tool === 'browser_batch' && Array.isArray(args.actions) ? args.actions : [args];
      for (const command of commands) {
        const control = [...(this.observation?.actions ?? []), ...(this.observation?.fields ?? [])].find(item => item.ref === command.ref);
        // Do not retain typed values, credentials, executable scripts or stale refs.
        this.pending.push(JSON.stringify({ tool, action: command.action,
          target: control ? ('label' in control ? control.label : control.text) : String(command.selector ?? command.locator ?? command.action ?? tool).slice(0, 180), failed }));
      }
    }
    if (['browser_action', 'browser_batch', 'take_snapshot', 'wait_for_submission_result',
      'complete_authentication', 'enter_emailed_code', 'open_emailed_link'].includes(tool)) this.browserTurn = true;
    if (failed) { this.failures++; if (this.phase === 'normal' && this.failures >= 2) this.phase = 'plan'; }
  }

  endTurn(): void {
    if (this.actionPending) { this.phase = 'verify'; this.actionPending = false; }
  }
}
