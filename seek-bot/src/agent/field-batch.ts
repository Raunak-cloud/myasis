import type { ElementHandle } from 'patchright';
import { FormBatch } from '../form-batch.js';
import { extractFields } from '../dom.js';
import { metric } from '../pipeline.js';
import type { FormField } from '../types.js';
import type { ToolContext, ToolResult } from './tools/context.js';
import { cleanCoverLetter, isCoverLetterField } from '../cover-letter-policy.js';
import { readFieldFeedback } from './field-feedback.js';

export const MAX_FIELD_BATCH = 16;
export type FieldWrite = { ref: string; value: string };
const identity = ({ ref: _ref, currentValue: _value, validationError: _error, ...field }: FormField) => field;

/** Browser transport only. The applying agent authors every value and judges
 * the resulting page. Never parallelize writes on a shared form. */
export async function fillObservedFields(ctx: ToolContext, writes: readonly FieldWrite[]): Promise<ToolResult> {
  const started = performance.now();
  const results: Array<{ ref: string; question: string; requested: string; saved: string; validation: string }> = [];
  const handles: ElementHandle<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>[] = [];
  const reply = (message: string, disposition: 'completed' | 'reobserve' | 'failed'): ToolResult => {
    metric('field-batch', performance.now() - started, { jobId: ctx.job?.id, requested: writes.length, observed: results.length, disposition });
    return { kind: 'ok', disposition,
      message: `${message}\nField write observations (not proof of server acceptance): ${JSON.stringify(results)}. Inspect the fresh page before advancing.` };
  };
  if (!writes.length || writes.length > MAX_FIELD_BATCH || new Set(writes.map(write => write.ref)).size !== writes.length) {
    return reply('Provide 1–16 distinct current FIELD refs.', 'failed');
  }
  const fields = writes.map(write => ctx.observation.fields.find(field => field.ref === write.ref));
  const blocked = fields.flatMap((field, index) => {
    const reason = !field ? 'not a current FIELD ref: inspect the fresh page'
      : field.sensitive ? 'private credential: use authentication tools'
      : field.autocomplete ? 'autocomplete: use browser_action to type, inspect suggestions, then click the matching option'
      : !['text', 'textarea', 'select', 'checkbox'].includes(field.kind) ? `${field.kind}: use browser_action individually` : '';
    return reason ? [{ ref: writes[index].ref, question: field?.label, reason }] : [];
  });
  if (blocked.length) {
    return reply(`No fields were written. Blocked fields: ${JSON.stringify(blocked)}. Remove these from the batch; ordinary fields can be batched separately.`, 'failed');
  }
  writes = writes.map((write, index) => isCoverLetterField(fields[index]!.label) ? { ...write, value: cleanCoverLetter(write.value) } : write);
  const baseline = JSON.stringify(ctx.observation.fields.map(identity));
  const unchanged = async () => JSON.stringify((await extractFields(ctx.page)).map(identity)) === baseline;
  const batch = await FormBatch.capture(ctx.page, ctx.observation.fields);
  if (!batch) return reply('The form changed since observation. No fields were written.', 'reobserve');
  try {
    // Preflight the entire request before writing anything, then retain actual
    // nodes: a re-render must never silently redirect a write to a new input.
    for (const [index, field] of fields.entries()) {
      const resolved = await batch.resolve(field!);
      if (!resolved) return reply('The form changed during preparation. No fields were written.', 'reobserve');
      const locator = ctx.page.locator(`[data-field-id="${resolved.ref}"]`);
      if (await locator.count() !== 1) return reply('A FIELD target is missing or ambiguous. No fields were written.', 'reobserve');
      const handle = await locator.elementHandle({ timeout: 2500 }) as typeof handles[number] | null;
      if (!handle) return reply('A FIELD target disappeared. No fields were written.', 'reobserve');
      handles.push(handle);
      const unsupported = await handle.evaluate((el, value) => {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return 'not a native input, textarea or select';
        if (el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return 'disabled control';
        if ('readOnly' in el && el.readOnly) return 'read-only control';
        if (el.closest('[role=combobox], [role=listbox]') || el.getAttribute('role') === 'combobox'
          || el.getAttribute('aria-autocomplete') && el.getAttribute('aria-autocomplete') !== 'none' || el.hasAttribute('list')) return 'autocomplete/custom widget: type and choose an observed suggestion individually';
        if (el instanceof HTMLSelectElement) {
          if (el.multiple) return 'multi-select: interact individually';
          const matches = [...el.options].filter(option => !option.disabled && !option.parentElement?.matches('optgroup:disabled') && (option.label === value || option.value === value));
          return matches.length === 1 ? '' : matches.length ? 'ambiguous option: use a unique option value' : 'no enabled option matches the requested label/value';
        }
        if (el instanceof HTMLTextAreaElement) return '';
        return el.type === 'checkbox' ? ['true', 'false'].includes(value) ? '' : 'checkbox value must be true or false'
          : ['text', 'email', 'tel', 'url', 'number', 'date', 'month', 'week', 'time', 'datetime-local'].includes(el.type) ? '' : `input type ${el.type} requires individual interaction`;
      }, writes[index].value);
      if (unsupported) return reply(`Field ${field!.ref} ${JSON.stringify(field!.label)}: ${unsupported}. Use browser_action to inspect and interact individually. No fields were written.`, 'failed');
    }
    for (const [index, write] of writes.entries()) {
      const field = fields[index]!, handle = handles[index];
      if (!await unchanged() || !await batch.resolve(field) || !await handle.evaluate(el => el.isConnected)) {
        return reply('The questions or controls changed. Remaining fields were not written; re-observe.', 'reobserve');
      }
      if (field.kind === 'select') {
        const option = await handle.evaluate((el, value) => [...(el as HTMLSelectElement).options].findIndex(option => !option.disabled && !option.parentElement?.matches('optgroup:disabled') && (option.label === value || option.value === value)), write.value);
        if (option < 0) return reply('The chosen option is no longer available. Remaining fields were not written.', 'reobserve');
        await handle.selectOption({ index: option }, { timeout: 5000 });
      } else if (field.kind === 'checkbox') await handle.setChecked(write.value === 'true', { timeout: 5000 });
      else await handle.fill(write.value, { timeout: 5000 });
      // Commit normal blur/change handlers, then allow one render before the
      // next question. The fallback also works in throttled background tabs.
      await handle.evaluate(el => el.blur());
      await ctx.page.evaluate(() => new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 50);
        requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
      }));
      const saved = await readFieldFeedback(handle, write.value);
      results.push({ ref: write.ref, question: field.label, requested: write.value, saved: saved.saved ?? '', validation: saved.validation });
      const prior = ctx.captured.findIndex(item => item.question === field.label);
      if (prior >= 0) ctx.captured.splice(prior, 1);
      if (saved.saved !== null) ctx.captured.push({ question: field.label, answer: saved.saved });
      if (isCoverLetterField(field.label) && saved.saved !== null) ctx.coverLetter = saved.saved;
      if (!saved.connected || !await unchanged() || !await batch.resolve(field)) {
        return reply('The form changed after a write. Remaining fields were not written; re-observe.', 'reobserve');
      }
      if (!saved.matches || saved.validation) return reply('A value was transformed, rejected or invalid. Remaining fields were not written; inspect and recover.', 'reobserve');
    }
    return reply(`Wrote ${results.length} fields in one batch.`, 'completed');
  } catch (error) {
    return reply(`Batch stopped after ${results.length} observed writes: ${(error as Error).message}. The last attempted write may have taken effect; remaining fields were not attempted.`, 'failed');
  } finally { await Promise.all(handles.map(handle => handle.dispose().catch(() => {}))); }
}
