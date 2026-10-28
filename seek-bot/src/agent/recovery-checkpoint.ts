import type { Observation } from './observe.js';
import type { ToolSchema } from './celeris.js';

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
  private phase: 'normal' | 'plan' | 'act' | 'verify' = 'normal';
  private previous?: string;
  private browserTurn = false;
  private failures = 0;
  private unchanged = 0;
  private invalid = 0;
  private furtherInspections = 0;
  private actionPending = false;

  observe(observation: Observation): void {
    const signature = JSON.stringify([observation.url, observation.fields.map(field => [
      field.section, field.label, field.kind, field.sensitive || field.inputType === 'password' ? '[private]' : field.currentValue,
      field.validationError, field.options, field.disabled,
    ])]);
    if (signature !== this.previous) {
      if (this.previous !== undefined && this.phase === 'act') this.phase = 'verify';
      this.unchanged = 0; this.failures = 0;
    }
    else if (this.browserTurn) this.unchanged++;
    this.previous = signature;
    this.browserTurn = false;
    if (this.phase === 'normal' && (this.failures >= 2 || this.unchanged >= 5)) this.phase = 'plan';
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
    return true;
  }

  planned(): void {
    this.phase = 'act'; this.invalid = 0; this.failures = 0; this.unchanged = 0;
    this.furtherInspections = 0;
  }

  verified(assessment: string): void {
    this.invalid = 0;
    if (assessment === 'no_progress') this.phase = 'plan';
    else if (assessment === 'more_evidence') this.phase = ++this.furtherInspections >= 2 ? 'plan' : 'act';
    else { this.phase = 'normal'; this.failures = 0; this.unchanged = 0; this.furtherInspections = 0; }
  }

  acted(tool: string, failed: boolean, args: Record<string, unknown> = {}): void {
    const changesPage = tool === 'browser_action'
      ? ['click', 'fill', 'select', 'check', 'press', 'navigate', 'dialog', 'set_input_files'].includes(String(args.action)) || args.sends_application === true
      : tool === 'browser_batch'
        ? Array.isArray(args.actions) && args.actions.some(action => ['click', 'fill', 'select', 'check', 'press', 'set_input_files'].includes(String(action.action)))
        : ['complete_authentication', 'enter_emailed_code', 'open_emailed_link'].includes(tool);
    if (this.phase === 'act' && changesPage) this.actionPending = true;
    if (['browser_action', 'browser_batch', 'take_snapshot', 'wait_for_submission_result',
      'complete_authentication', 'enter_emailed_code', 'open_emailed_link'].includes(tool)) this.browserTurn = true;
    if (failed) { this.failures++; if (this.phase === 'normal' && this.failures >= 2) this.phase = 'plan'; }
  }

  endTurn(): void {
    if (this.actionPending) { this.phase = 'verify'; this.actionPending = false; }
  }
}
