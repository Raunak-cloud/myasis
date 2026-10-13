import { createHash } from 'node:crypto';
import type { Locator, Page } from 'patchright';
import type { FormField, FieldAnswer } from './types.js';
import { assertLive } from './tool-run.js';

/** Resource ceilings, not employer rules. Long answers/large option lists use
 * smaller batches; every field still goes through the same grounding path. */
export const MAX_ANSWER_BATCH = 24;
export function boundedAnswerBatch(fields: readonly FormField[], outputTokens: number): FormField[] {
  const outputBudget = Math.max(512, Math.floor(outputTokens * 0.75));
  let output = 0, input = 0;
  const selected: FormField[] = [];
  for (const field of fields) {
    const valueChars = field.kind === 'textarea' ? 1800 : 384;
    const cost = 128 + Math.ceil(Math.max(0, valueChars) / 3);
    const chars = JSON.stringify(field).length;
    if (selected.length && (selected.length >= MAX_ANSWER_BATCH || output + cost > outputBudget || input + chars > 24_000)) break;
    selected.push(field); output += cost; input += chars;
  }
  return selected;
}

/** Process-local only. No shared answer file, fuzzy matching or persistence.
 * Caller scopes by owner directory, job, evidence, profile and current form. */
export class FormAnswerCache {
  private entries = new Map<string, { answer: FieldAnswer; expires: number }>();
  private key(scope: string, field: FormField): string {
    const { ref: _ref, currentValue: _value, ...question } = field;
    return createHash('sha256').update(JSON.stringify([scope, question])).digest('hex');
  }
  get(scope: string, field: FormField): FieldAnswer | undefined {
    if (field.sensitive || field.validationError) return undefined;
    const key = this.key(scope, field), found = this.entries.get(key);
    if (!found || found.expires <= Date.now()) { this.entries.delete(key); return undefined; }
    return { ...found.answer, ref: field.ref };
  }
  put(scope: string, field: FormField, answer: FieldAnswer): void {
    if (field.sensitive || field.validationError || !answer.grounded || !answer.applicationQuestion || answer.basis !== 'profile') return;
    if (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(this.key(scope, field), { answer: { ...answer }, expires: Date.now() + 30 * 60_000 });
  }
}

/** Detect control replacement even when the number of fields stays the same.
 * Values/check states are excluded, so normal filling does not end a batch. */
export async function currentFormStructure(page: Page): Promise<string> {
  const structures: unknown[] = [];
  for (const frame of page.frames()) {
    structures.push(await frame.evaluate(() => {
      const roots: Array<Document | ShadowRoot> = [document], controls: unknown[] = [];
      const wording = (node: Node): string => {
        if (node instanceof HTMLSlotElement) return (node.assignedNodes({ flatten: true }).length ? node.assignedNodes({ flatten: true }) : [...node.childNodes]).map(wording).join('');
        return node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : [...node.childNodes].map(wording).join('');
      };
      for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (!el.matches('input:not([type=hidden]), select, textarea, [role=combobox], [role=radio], [role=checkbox], [contenteditable=true]')) continue;
        if (el.closest('[role=listbox], [role=menu], [role=option], [aria-live]')) continue;
        const box = el.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) continue;
        const input = el as HTMLInputElement;
        const root = el.getRootNode() as Document | ShadowRoot;
        const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
          .map(id => root.getElementById(id) ?? document.getElementById(id)).map(node => node ? wording(node) : '');
        controls.push([el.tagName, el.getAttribute('data-field-id'), el.id, input.name, input.type,
          el.getAttribute('role'), el.getAttribute('aria-label'), el.getAttribute('aria-labelledby'), labelled,
          [...(input.labels ?? [])].map(wording), input.required, input.disabled, input.readOnly,
          el instanceof HTMLSelectElement ? [...el.options].map(option => [option.value, option.textContent]) : null]);
      }
      return controls;
    }).catch(() => null));
  }
  return JSON.stringify(structures);
}

/** Sites may replace an uploader as soon as its change event fires. Reading
 * the original node avoids waiting 30s for a stale observation ref to return.
 * The returned name confirms transport only; server acceptance is checked by
 * the agent's next observation and the existing submission gate. */
export async function uploadObservedFile(input: Locator, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<string> {
  assertLive();
  const original = await input.elementHandle({ timeout: 2500 });
  if (!original) throw new Error('The observed upload control is no longer available');
  try {
    assertLive();
    await input.setInputFiles(file, { timeout: 10_000 });
    return await original.evaluate(el => (el as HTMLInputElement).files?.[0]?.name ?? '').catch(() => '');
  } finally { await original.dispose().catch(() => {}); }
}
