import type { Observation } from './observe.js';
import type { ToolSchema } from './celeris.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InteractionMemory } from './interaction-memory.js';
import { changesBrowserState } from './browser-commands.js';

const text = { type: 'string', minLength: 1 };
const evidence = { type: 'array', minItems: 1, items: text };
export const recoveryTools: ToolSchema[] = [
  { name: 'record_recovery_plan', description: 'Optional recovery note when the recovery advisory requests diagnosis. Record a concise cause, a different next approach and observable verification when useful. You may instead act directly on clear current evidence or specialist advice. Performs no browser action.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      observed_issue: text, evidence, previous_approaches: evidence, next_action: text, verification: text,
    }, required: ['observed_issue', 'evidence', 'previous_approaches', 'next_action', 'verification'] } },
  { name: 'record_recovery_result', description: 'Optional combined recovery/progress-budget assessment when advised. Assess fresh browser evidence once; after a successful fix you may continue or prepare directly without this report. complete requires an actual observed employer receipt and receipt_quote. Otherwise use progress, no_progress or more_evidence. Never submits or approves independently.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      assessment: { type: 'string', enum: ['progress', 'no_progress', 'more_evidence', 'complete'] }, evidence, next_action: text,
      receipt_quote: { type: 'string', maxLength: 4000 },
    }, required: ['assessment', 'evidence', 'next_action'],anyOf:[
      {properties:{assessment:{enum:['complete']},receipt_quote:{type:'string',minLength:1}},required:['receipt_quote']},
      {properties:{assessment:{enum:['progress','no_progress','more_evidence']}}},
    ] } },
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
  checkpoint() {
    return { version: 1 as const, pending: this.pending, edges: [...this.edges], seen: [...this.seen], credited: [...this.credited],
      progressCandidate: this.progressCandidate, transitions: this.transitions, note: this.note, budgetReview: this.budgetReview,
      reviewable: this.reviewable, phase: this.phase, previous: this.previous, browserTurn: this.browserTurn, failures: this.failures,
      unchanged: this.unchanged, furtherInspections: this.furtherInspections, actionPending: this.actionPending,
      specialistPending: this.specialistPending, readResults: [...this.readResults], repeatedReads: this.repeatedReads,
      readNotice: this.readNotice, failedInteractions: this.memory.checkpoint() };
  }
  restore(saved: ReturnType<RecoveryCheckpoint['checkpoint']>): void {
    if (saved.version !== 1) throw Error('Unsupported recovery checkpoint.');
    this.pending = saved.pending; this.edges = new Map(saved.edges); this.seen = new Set(saved.seen); this.credited = new Set(saved.credited);
    this.progressCandidate = saved.progressCandidate; this.transitions = saved.transitions; this.note = saved.note;
    this.budgetReview = saved.budgetReview; this.reviewable = saved.reviewable; this.phase = saved.phase; this.previous = saved.previous;
    this.browserTurn = saved.browserTurn; this.failures = saved.failures; this.unchanged = saved.unchanged;
    this.furtherInspections = saved.furtherInspections; this.actionPending = saved.actionPending; this.specialistPending = saved.specialistPending;
    this.readResults = new Set(saved.readResults); this.repeatedReads = saved.repeatedReads; this.readNotice = saved.readNotice;
    this.memory.restore(saved.failedInteractions);
  }
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
  private specialistPending = false;
  private readResults = new Set<string>();
  private repeatedReads = 0;
  private readNotice = '';

  /** Retrieval adds evidence only when its response is new. This also catches
   * alternating already-read queries, without denying tools or choosing answers. */
  readEvidence(tool: string, response: string): { notice?: string; newlyStalled: boolean } {
    const key = createHash('sha256').update(tool).update(response).digest('hex');
    const repeated = this.readResults.has(key);
    this.readResults.add(key);
    if (this.readResults.size > 128) this.readResults.delete(this.readResults.values().next().value!);
    this.repeatedReads = repeated ? this.repeatedReads + 1 : 0;
    if (this.repeatedReads < 3) return { newlyStalled: false };
    const newlyStalled = !this.readNotice;
    this.readNotice = 'Repeated evidence reads returned material already retrieved while the employer form stayed unchanged. Reuse the evidence already read. Follow NEXT_OFFSET with the same query, read an exact document ID, or inspect and advance the actual form. Do not keep restarting the same searches. If a mandatory personal fact remains unknown after full source review, ask for that exact fact; otherwise continue using supported facts and clearly framed technical reasoning.';
    this.specialistPending = true;
    if (this.phase === 'normal') this.phase = 'plan';
    this.persist();
    return { notice: this.readNotice, newlyStalled };
  }

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
    const control = [...(this.observation?.actions ?? []), ...(this.observation?.fields ?? [])].find(item => item.ref === args.ref);
    this.memory.failed(tool, control ? { ...args, observed_target: { label: 'label' in control ? control.label : control.text,
      context: 'section' in control ? control.section : 'context' in control ? control.context : undefined } } : args, url, error); this.persist();
  }
  finish(status: string, sendAttempted: boolean): void { this.persist({ status, sendAttempted }); }
  render(): string {
    return `${this.previousAttempt ? `PREVIOUS ATTEMPT (historical agent claims only; inspect the current page, never replay a send or adopt old answers blindly): ${this.previousAttempt}\n` : ''}${this.memory.render()}${this.readNotice ? `\nEVIDENCE READ RECOVERY: ${this.readNotice}` : ''}\nRECENT ACTION OUTCOMES (changed does not necessarily mean closer to submission): ${JSON.stringify(this.transitions)}\nRECORDED PLAN / PROGRESS: ${this.note}${this.tool ? `\nRECOVERY ADVISORY: ${this.tool} is optional. ${this.budgetReview ? 'One assessment covers both recovery and spending.' : 'Inspect the latest outcome before acting.'} If the evidence or specialist advice already resolves the issue, continue the form or prepare it directly; do not spend another turn restating a completed fix.` : ''}`;
  }
  get reviewingBudget(): boolean { return this.budgetReview; }
  /** Escalation survives optional recovery narration until it is actually handled. */
  get needsSpecialist(): boolean { return this.specialistPending; }
  get evidenceKey(): string | undefined { return this.previous; }
  specialistRequested(): void {
    this.specialistPending = false;
    this.failures = 0; this.unchanged = 0;
  }
  /** Keep deeper reasoning through diagnosis, repair and fresh verification.
   * An accepted tool call or another inspection cannot end escalation. */
  get needsDeepReasoning(): boolean {
    return (!this.budgetReview && this.phase !== 'normal') || this.failures >= 2 || this.unchanged >= 5;
  }
  requestBudgetReview(): boolean {
    // Do not turn an unexecuted repair into a result checkpoint using older
    // reviewable work. A repair gets its own evidence assessment after acting;
    // the normal spending ceiling still applies before every operation.
    if (this.phase === 'verify') { this.budgetReview = true; this.reviewable = false; return true; }
    if (this.phase !== 'normal' || !this.reviewable) return false;
    this.budgetReview = true; this.phase = 'verify'; this.reviewable = false;
    return true;
  }
  private phase: 'normal' | 'plan' | 'act' | 'verify' = 'normal';
  private previous?: string;
  private browserTurn = false;
  private failures = 0;
  private unchanged = 0;
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
      if (count >= 2) {
        this.specialistPending = true;
        if (this.phase === 'normal') this.phase = 'plan';
      }
    }
    const completedChange = this.changedByAction && observation.fields.some(field => field.currentValue && !field.validationError
      && this.observation?.fields.some(old => old.label === field.label && old.section === field.section && old.currentValue !== field.currentValue));
    this.pending = []; this.seen.add(signature); this.observation = observation;
    if (signature !== this.previous) {
      this.readResults.clear(); this.repeatedReads = 0; this.readNotice = '';
      // A delayed render is evidence to inspect, not execution of the agent's
      // newly recorded plan. Only endTurn after an attempted repair schedules
      // its result check; otherwise recovery can loop without acting at all.
      this.unchanged = 0;
      // Only a successful operation with a changed, valid field clears old
      // failures. A chatbot animation or delayed error must not erase them.
      if (completedChange) { this.failures = 0; this.specialistPending = false; }
    }
    else if (this.browserTurn) this.unchanged++;
    this.previous = signature;
    this.browserTurn = false;
    if (this.phase === 'normal' && (this.failures >= 2 || this.unchanged >= 5)) this.phase = 'plan';
    if (this.failures >= 2 || this.unchanged >= 5) this.specialistPending = true;
    this.persist();
  }

  get tool(): string | undefined {
    return this.phase === 'plan' ? 'record_recovery_plan' : this.phase === 'verify' ? 'record_recovery_result' : undefined;
  }

  applicationReviewed(): void {
    // Canonical accuracy review covers this form state; a second recovery or
    // spending report must not claim the same evidence or block preparation.
    this.phase = 'normal'; this.actionPending = false; this.budgetReview = false;
    this.reviewable = false; this.progressCandidate = undefined;
    this.failures = 0; this.unchanged = 0; this.furtherInspections = 0;
    this.specialistPending = false;
  }

  planned(args?: Record<string, unknown>): void {
    this.phase = 'act'; this.failures = 0; this.unchanged = 0;
    this.furtherInspections = 0;
    if (args) this.remember(`RECOVERY PLAN: ${JSON.stringify(args)}`);
  }

  verified(assessment: string, args?: Record<string, unknown>): string | undefined {
    // The agent judges meaningful progress. Only fresh, action-grounded states
    // can fund another interval; revisits and narration cannot mint allowance.
    const credit = assessment === 'progress' && this.progressCandidate && this.progressCandidate === this.previous && !this.credited.has(this.progressCandidate) ? this.progressCandidate : undefined;
    if (credit) this.credited.add(credit);
    this.progressCandidate = undefined;
    this.reviewable = false;
    this.budgetReview = false;
    if (args) this.remember(`${this.note}\nRECOVERY RESULT: ${JSON.stringify(args)}`);
    // The result already records evidence and the agent's revised next_action.
    // Do not force a duplicate plan before allowing that repair to execute.
    if (assessment === 'no_progress') { this.phase = 'act'; this.failures = 0; this.unchanged = 0; }
    else if (assessment === 'more_evidence') this.phase = ++this.furtherInspections >= 2 ? 'plan' : 'act';
    else { this.phase = 'normal'; this.failures = 0; this.unchanged = 0; this.furtherInspections = 0; }
    return credit;
  }

  acted(tool: string, failed: boolean, args: Record<string, unknown> = {}): void {
    const changesPage = tool === 'browser_action'
      ? changesBrowserState(args)
      : tool === 'browser_batch'
        ? Array.isArray(args.actions) && args.actions.some(changesBrowserState)
        : ['fill_authentication_fields', 'enter_emailed_code', 'open_emailed_link'].includes(tool);
    // Choosing the next normal action after inspecting a repair is an
    // implicit continuation, not a reason to force a report or keep expensive
    // diagnosis active forever. It earns no extra allowance by itself.
    if (this.phase === 'verify' && changesPage && !failed) {
      this.phase = 'normal'; this.budgetReview = false; this.failures = 0; this.unchanged = 0;
    }
    if ((this.phase === 'act' || this.phase === 'plan') && changesPage) this.actionPending = true;
    if (changesPage) {
      const commands = tool === 'browser_batch' && Array.isArray(args.actions) ? args.actions : [args];
      for (const command of commands) {
        const control = [...(this.observation?.actions ?? []), ...(this.observation?.fields ?? [])].find(item => item.ref === command.ref);
        // Do not retain typed values, credentials, executable scripts or stale refs.
        this.pending.push(JSON.stringify({ tool, action: command.action,
          target: control ? { label: 'label' in control ? control.label : control.text,
            context: 'section' in control ? control.section : 'context' in control ? control.context : undefined }
            : command.locator ?? command.selector ?? command.action ?? tool, failed }));
      }
    }
    if (['browser_action', 'browser_batch', 'take_snapshot', 'wait_for_submission_result',
      'fill_authentication_fields', 'enter_emailed_code', 'open_emailed_link'].includes(tool)) this.browserTurn = true;
    if (failed) {
      this.failures++;
      if (this.failures >= 2) {
        this.specialistPending = true;
        if (this.phase === 'normal') this.phase = 'plan';
      }
    }
  }

  endTurn(): void {
    if (this.actionPending) { this.phase = 'verify'; this.actionPending = false; }
  }
}
