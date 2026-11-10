import type { Observation } from './observe.js';
import type { ToolSchema } from './celeris.js';

export const applicationReviewTool: ToolSchema = {
  name: 'record_application_review',
  description: 'Optional self-review by the applying agent, never a separate permission gate. Choose when to inspect and review the application. Assess consequential answers, documents, vacancy and dates against candidate sources. You may record ready, correct or needs_answer, or continue directly with normal tools after assessing the evidence. A report never sends, repairs or authorizes a job. Unsupported required facts still need the candidate; an uncertain send must not be repeated.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    assessment: { type: 'string', enum: ['ready', 'correct', 'needs_answer'] },
    vacancy: { type: 'string', minLength: 1, description: 'Actual employer vacancy and location compared with the authorized job.' },
    documents: { type: 'string', minLength: 1, description: 'Observed accepted attachments and letter, compared with their selected sources; state when none are required.' },
    unresolved: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Remaining conflicts, missing required facts or unverified saved values. Must be empty for ready.' },
    checks: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(['question', 'source_evidence', 'intended_meaning', 'observed_value', 'conclusion'].map(key => [key, { type: 'string', minLength: 1 }])),
      required: ['question', 'source_evidence', 'intended_meaning', 'observed_value', 'conclusion'] } },
    next_action: { type: 'string', minLength: 1 },
  }, required: ['assessment', 'vacancy', 'documents', 'unresolved', 'checks', 'next_action'] },
};

/** Passive browser evidence. No answer inference, independent verdict or repair.
 * Earlier wizard fields are explicitly historical; only the agent can establish
 * whether an editor was saved, cancelled or superseded on the employer site. */
export class ApplicationReadiness {
  private records = new Map<string, Record<string, unknown>>();
  private wizard = new Map<string, Record<string, unknown>>();
  private current = new Set<string>();
  private revision = 0;
  private reviewed = -1;
  private notified = -1;
  private canonicalSurface = '';
  private correctionPending = false;
  private answerPending = false;
  requested = false;

  /** Preserve the applying agent's own escalation through its repair turns.
   * This changes reasoning effort only, never control selection or permission. */
  get needsDeepReasoning(): boolean { return this.correctionPending; }
  get needsAnswer(): boolean { return this.answerPending; }
  get ready(): boolean { return this.reviewed === this.revision; }

  observe(observation: Observation, source: 'canonical' | 'wizard' = 'canonical'): void {
    const records = source === 'canonical' ? this.records : this.wizard;
    if (source === 'canonical') this.current.clear();
    for (const field of observation.fields) {
      if (field.sensitive || field.inputType === 'password' || field.currentValue === '[private credential]') continue;
      const key = JSON.stringify([observation.url, field.section, field.controlIdentity ?? [field.label, field.hints]]);
      const value = { control_identity: field.controlIdentity, section: field.section, label: field.label,
        required: field.required, value: field.currentValue ?? '', validation: field.validationError,
        input_type: field.inputType, markup: field.hints };
      if (source === 'canonical') this.current.add(key);
      if (JSON.stringify(records.get(key)) !== JSON.stringify(value)) {
        records.set(key, value);
        if (source === 'canonical') this.revision++;
      }
      while (records.size > (source === 'canonical' ? 160 : 80)) records.delete(records.keys().next().value!);
    }
    if (source === 'canonical') {
      const surface = JSON.stringify([observation.url, [...this.current].sort()]);
      if (surface !== this.canonicalSurface) { this.canonicalSurface = surface; this.revision++; }
    }
  }

  request(): boolean {
    if (this.reviewed === this.revision || this.notified === this.revision) return false;
    this.notified = this.revision;
    this.requested = true; return true;
  }

  invalidate(): void { this.revision++; this.reviewed = -1; this.answerPending = false; this.requested = false; }

  record(assessment: string, unresolved: string[] = []): void {
    if (assessment === 'ready' && unresolved.length) throw new Error('Resolve the listed conflicts before recording ready. No send ran.');
    this.reviewed = assessment === 'ready' ? this.revision : -1;
    this.correctionPending = assessment === 'correct';
    this.answerPending = assessment === 'needs_answer';
    this.requested = false;
  }

  render(): string {
    const history = [...this.wizard].filter(([key]) => !this.records.has(key)).map(([, value]) => ({ ...value, presence: 'earlier wizard observation; saving not established' }));
    const canonical = [...this.records].map(([key, value]) => ({ ...value, presence: this.current.has(key) ? 'current saved-form readback' : 'earlier saved-form readback; recheck retained entries if uncertain' }));
    return `APPLICATION READBACK EVIDENCE (browser observations, not candidate sources): ${JSON.stringify([...history, ...canonical])}\nThe saved-form reader is the canonical pre-send representation. A tag widget can retain a selection while its search input is empty. Wizard observations provide history only and do not overwrite reviewed saved values. Review consequential claims against explicit profile, saved-answer or document passages. Give identifiable sources and brief supporting excerpts, not just "profile" or your earlier draft. Check all changed consequential claims, including resume-parsed values and cover-letter assertions; do not enumerate every routine field. Review actual employer vacancy, location and accepted documents. Historical fields can come from cancelled editors: inspect the current review or retained saved entries before treating them as submitted values. Dates use month names in your assessment; interpret components by actual labels and format. One week does not authorize an invented calendar day or two weeks. Never substitute a qualification. Application terms and consent acceptance are authorised; apply the shared candidate-evidence inference rules. Leave optional unknown facts blank or use offered non-disclosure; ask for required unknowns. Ready requires no unresolved conflicts. You choose any corrections and the next send yourself; no send is queued.`;
  }
}
