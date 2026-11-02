import type { PreparedApplication } from './application-review-types.js';
import type { FormField } from './types.js';
import { isCoverLetterField } from './cover-letter-policy.js';

const normal = (value: string) => value.replace(/\s+/g, ' ').trim();
export function typedCoverLetterControls(fields: FormField[]): FormField[] {
  return fields.filter(field => (field.kind === 'textarea' || field.kind === 'text' && field.inputType !== 'file')
    && !field.sensitive && isCoverLetterField(field.label));
}
/** Legacy drafts sometimes retained the body only as a revision-bound answer.
 * Current typed browser evidence establishes that it is prose, not a filename.
 * This derives an in-memory comparison view; it never rewrites saved history. */
export function observedApprovedCoverLetter(approved: PreparedApplication | undefined, fields: FormField[], historicalFields: FormField[] = []): string | undefined {
  if (!approved) return;
  const current = typedCoverLetterControls(fields);
  // An absent wizard step can retain its actual previous witness. A current
  // blank/different control must never be overwritten by historical evidence.
  const controls = current.length ? current : typedCoverLetterControls(historicalFields);
  const candidates = controls.filter(field => field.currentValue?.trim()).flatMap(field => approved.coverLetter !== undefined
    ? normal(approved.coverLetter) === normal(field.currentValue!) ? [approved.coverLetter] : []
    : approved.answers.filter(answer => normal(answer.question) === normal(field.label)
      && normal(answer.answer) === normal(field.currentValue!)).map(answer => answer.answer));
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
}
