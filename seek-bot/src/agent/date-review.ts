import type { Observation } from './observe.js';
import type { ToolSchema } from './celeris.js';

export const dateReviewTool: ToolSchema = {
  name: 'record_date_review',
  description: 'The applying agent compares date source facts with actual browser readbacks before sending or preparing an application containing date controls. No second reviewer or automatic date interpretation. Name months in words, distinguish each question and component, and include blanks and relative notice periods. Performs no browser action and never submits.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    assessment: { type: 'string', enum: ['ready', 'correct', 'needs_answer'] },
    checks: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(['question', 'source_evidence', 'intended_meaning', 'observed_parts', 'conclusion'].map(key => [key, { type: 'string', minLength: 1 }])),
      required: ['question', 'source_evidence', 'intended_meaning', 'observed_parts', 'conclusion'] } },
    next_action: { type: 'string', minLength: 1 },
  }, required: ['assessment', 'checks', 'next_action'] },
};

/** Browser evidence only: no parsing, answer generation or independent verdict. */
export class DateReview {
  private records = new Map<string, unknown>();
  private revision = 0;
  private reviewed = -1;
  requested = false;

  observe(observation: Observation): void {
    for (const field of observation.fields) {
      if (field.sensitive || field.inputType === 'password') continue;
      if (!/^(?:date|month|week|datetime-local)$/.test(field.inputType ?? '')
        && !/^\s*(?:month|day|year|from|to)\s*\*?\s*$/i.test(field.label)
        && !/\bdate\b/i.test(`${field.label} ${field.hints ?? ''}`)
        && !/\b(?:start|end|completion|graduation|birth)\b.{0,40}\b(?:month|year)\b/i.test(field.label)) continue;
      const key = JSON.stringify([observation.url, field.section, field.label, field.hints]);
      const value = { section: field.section, label: field.label, markup: field.hints,
        required: field.required, value: field.currentValue ?? '', validation: field.validationError };
      if (JSON.stringify(this.records.get(key)) !== JSON.stringify(value)) {
        this.records.set(key, value); this.revision++;
      }
      while (this.records.size > 80) this.records.delete(this.records.keys().next().value!);
    }
  }

  request(): boolean {
    if (!this.records.size || this.reviewed === this.revision) return false;
    this.requested = true; return true;
  }

  invalidate(): void { if (this.records.size) this.reviewed = -1; }

  record(assessment: string): void {
    if (assessment === 'ready') this.reviewed = this.revision;
    this.requested = false;
  }

  render(): string {
    return `DATE READBACK EVIDENCE (browser facts across wizard pages; not candidate evidence): ${JSON.stringify([...this.records.values()])}\nCompare actual components with their full question and candidate source. State dates using month names. Interpret each component by its label, not by an assumed numeric display order or locale. A relative notice period does not authorize a guessed calendar day. Leave optional unknown months blank; ask for a mandatory unsupported component. Inspect uncertain context or saved values before declaring ready. Never change the meaning of a date merely to satisfy validation.`;
  }
}
