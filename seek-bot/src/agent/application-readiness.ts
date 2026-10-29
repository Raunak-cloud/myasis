import type { Observation } from './observe.js';
import type { ToolSchema } from './celeris.js';

export const applicationReviewTool: ToolSchema = {
  name: 'record_application_review',
  description: 'Your own pre-send review, not another reviewer. Compare actual saved answers, dates, consent, documents and vacancy with candidate sources. Historical wizard observations and intended drafts are not proof of the current employer state. Inspect uncertain sections; clear optional unsupported facts, correct conflicts or ask about required unknowns. This tool records your assessment and never sends or repairs.',
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
  private canonicalSurface = '';
  requested = false;

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
    if (this.reviewed === this.revision) return false;
    this.requested = true; return true;
  }

  invalidate(): void { this.reviewed = -1; }

  record(assessment: string, unresolved: string[] = []): void {
    if (assessment === 'ready' && unresolved.length) throw new Error('Resolve the listed conflicts before recording ready. No send ran.');
    if (assessment === 'ready') this.reviewed = this.revision;
    this.requested = false;
  }

  render(): string {
    const history = [...this.wizard].filter(([key]) => !this.records.has(key)).map(([, value]) => ({ ...value, presence: 'earlier wizard observation; saving not established' }));
    const canonical = [...this.records].map(([key, value]) => ({ ...value, presence: this.current.has(key) ? 'current saved-form readback' : 'earlier saved-form readback; recheck retained entries if uncertain' }));
    return `APPLICATION READBACK EVIDENCE (browser observations, not candidate sources): ${JSON.stringify([...history, ...canonical])}\nThe saved-form reader is the canonical pre-send representation. A tag widget can retain a selection while its search input is empty. Wizard observations provide history only and do not overwrite reviewed saved values. Review consequential claims against explicit profile, saved-answer or document passages. Give identifiable sources and brief supporting excerpts, not just "profile" or your earlier draft. Check all changed consequential claims, including resume-parsed values and cover-letter assertions; do not enumerate every routine field. Review actual employer vacancy, location and accepted documents. Historical fields can come from cancelled editors: inspect the current review or retained saved entries before treating them as submitted values. Dates use month names in your assessment; interpret components by actual labels and format. One week does not authorize an invented calendar day or two weeks. Never substitute a qualification or consent. Leave optional unknown facts blank or use offered non-disclosure; ask for required unknowns. Ready requires no unresolved conflicts. You choose any corrections and the next send yourself; no send is queued.`;
  }
}
