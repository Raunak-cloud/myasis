import type { PreparedApplication } from './application-review-types.js';
import type { FormField } from './types.js';
import { isCoverLetterField } from './cover-letter-policy.js';

const normal = (value: string) => value.replace(/\s+/g, ' ').trim();
/** Legacy drafts sometimes retained the body only as a revision-bound answer.
 * Current typed browser evidence establishes that it is prose, not a filename.
 * This derives an in-memory comparison view; it never rewrites saved history. */
export function observedApprovedCoverLetter(approved: PreparedApplication | undefined, fields: FormField[]): string | undefined {
  if (approved?.coverLetter !== undefined) return approved.coverLetter;
  if (!approved) return;
  const candidates = fields.filter(field => (field.kind === 'textarea' || field.kind === 'text' && field.inputType !== 'file')
    && !field.sensitive && isCoverLetterField(field.label) && field.currentValue?.trim())
    .flatMap(field => approved.answers.filter(answer => normal(answer.question) === normal(field.label)
      && normal(answer.answer) === normal(field.currentValue!)).map(answer => answer.answer));
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
}
