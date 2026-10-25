import { FieldBatchTargets } from './field-batch-targets.js';
import { extractFields } from '../dom.js';
import { metric } from '../pipeline.js';
import type { FormField } from '../types.js';
import type { ToolContext, ToolResult } from './tools/context.js';
import { cleanCoverLetter, isCoverLetterField } from '../cover-letter-policy.js';
import { readBatchFieldFeedback, type BatchTargetState } from './field-feedback.js';

export const MAX_FIELD_BATCH = 16;
export type FieldWrite = { ref: string; value: string };
const identity = ({ ref: _ref, currentValue: _value, validationError: _error, ...field }: FormField) => field;

/** Browser transport only. The applying agent authors every value and judges
 * the resulting page. Never parallelize writes on a shared form. */
export async function fillObservedFields(ctx: ToolContext, writes: readonly FieldWrite[]): Promise<ToolResult> {
  const started = performance.now();
  const results: Array<{ ref: string; question: string; requested: string; saved: string; validation: string }> = [];
  let targets: FieldBatchTargets | undefined;
  let scans = 0, guards = 0;
  const timings: Record<string, number> = {};
  const timed = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    const at = performance.now();
    try { return await operation(); }
    finally { timings[stage] = (timings[stage] ?? 0) + performance.now() - at; }
  };
  let disposition: 'completed' | 'reobserve' | 'failed' = 'failed';
  const reply = (message: string, outcome: 'completed' | 'reobserve' | 'failed'): ToolResult => {
    disposition = outcome;
    return { kind: 'ok', disposition,
      message: `${message}\nField write observations (not proof of server acceptance): ${JSON.stringify(results)}. Inspect the fresh page before advancing.` };
  };
  try {
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
    const unchanged = async () => {
      scans++;
      return timed('scanMs', async () => JSON.stringify((await extractFields(ctx.page)).map(identity)) === baseline);
    };
    // Track targets before scanning: changes during validation cannot slip through.
    const prepared = await timed('prepareMs', () => FieldBatchTargets.prepare(ctx.page, writes));
    if (typeof prepared === 'string') return reply(prepared, 'failed');
    targets = prepared;
    if (!await unchanged()) return reply('The form changed since observation. No fields were written.', 'reobserve');
    const current = async (known?: BatchTargetState): Promise<boolean> => {
      let state = known;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!state) { guards++; state = await timed('guardMs', () => targets!.check()); }
        if (state.status === 'ready') return true;
        if (state.status === 'stale') return false;
        if (!await unchanged()) return false;
        guards++;
        state = await timed('guardMs', () => targets!.renew(state!.revision));
      }
      return state?.status === 'ready';
    };
    for (const [index, write] of writes.entries()) {
      const field = fields[index]!;
      if (!await current()) return reply('The questions or controls changed. Remaining fields were not written; re-observe.', 'reobserve');
      const locator = targets.locator(index);
      await timed('writeMs', async () => {
        if (field.kind === 'select') await locator.selectOption({ index: targets!.optionIndices[index]! }, { timeout: 5000 });
        else if (field.kind === 'checkbox') await locator.setChecked(write.value === 'true', { timeout: 5000 });
        else await locator.fill(write.value, { timeout: 5000 });
      });
      const saved = await timed('readbackMs', () => readBatchFieldFeedback(ctx.page, targets!.key, index, write.value));
      results.push({ ref: write.ref, question: field.label, requested: write.value, saved: saved.saved ?? '', validation: saved.validation });
      const prior = ctx.captured.findIndex(item => item.question === field.label);
      if (prior >= 0) ctx.captured.splice(prior, 1);
      if (saved.saved !== null) ctx.captured.push({ question: field.label, answer: saved.saved });
      if (isCoverLetterField(field.label) && saved.saved !== null) ctx.coverLetter = saved.saved;
      if (!saved.connected || !saved.batch || !await current(saved.batch)) {
        return reply('The form changed after a write. Remaining fields were not written; re-observe.', 'reobserve');
      }
      if (!saved.matches || saved.validation) return reply('A value was transformed, rejected or invalid. Remaining fields were not written; inspect and recover.', 'reobserve');
    }
    return reply(`Wrote ${results.length} fields in one batch.`, 'completed');
  } catch (error) {
    return reply(`Batch stopped after ${results.length} observed writes: ${(error as Error).message}. The last attempted write may have taken effect; remaining fields were not attempted.`, 'failed');
  } finally {
    if (targets) await timed('cleanupMs', () => targets!.dispose());
    metric('field-batch', performance.now() - started, { jobId: ctx.job?.id, requested: writes.length, observed: results.length, disposition, scans, guards, ...timings });
  }
}
