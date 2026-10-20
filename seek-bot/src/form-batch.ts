import type { Page } from 'patchright';
import { extractFields } from './dom.js';
import { currentFormStructure } from './form-speed.js';
import type { FormField } from './types.js';

const questionIdentity = ({ ref: _ref, currentValue: _value, validationError: _error, ...question }: FormField) => JSON.stringify(question);

/** One lifecycle for a grounded answer batch: retain its form snapshot while
 * answers are generated, then resolve each write against that same form.
 * Changed questions return control to the agent; only rejected writes fail.
 * This is browser targeting, not a second answer/submission reviewer. */
export class FormBatch {
  private constructor(
    private page: Page,
    private fields: readonly FormField[],
    private url: string,
    private structure: string,
  ) {}

  static async capture(page: Page, fields: readonly FormField[]): Promise<FormBatch | null> {
    const current = await extractFields(page);
    if (JSON.stringify(current.map(questionIdentity)) !== JSON.stringify(fields.map(questionIdentity))) return null;
    return new FormBatch(page, fields, page.url(), await currentFormStructure(page));
  }

  async resolve(field: FormField): Promise<FormField | null> {
    if (this.page.url() !== this.url || await currentFormStructure(this.page) !== this.structure) return null;
    // Radio groups stamp fN:index, rather than a standalone fN control.
    if (await this.page.locator(`[data-field-id="${field.ref}"], [data-field-id^="${field.ref}:"]`).count()) return field;
    const observed = this.fields.find(candidate => candidate.ref === field.ref);
    if (!observed) return null;
    const identity = questionIdentity(observed);
    const matches = (await extractFields(this.page)).filter(candidate => questionIdentity(candidate) === identity);
    if (matches.length !== 1 || await currentFormStructure(this.page) !== this.structure) return null;
    return { ...field, ref: matches[0].ref };
  }
}
