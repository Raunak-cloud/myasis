import type { FormField } from '../types.js';

export const BROWSER_ACTION_EXAMPLES = [
  { action: 'click', ref: 'a0', sends_application: false },
  { action: 'fill', ref: 'f0', value: '<answer from candidate evidence>' },
  { action: 'select', ref: 'f1', value: '<observed option>' },
  { action: 'check', ref: 'f2', value: 'true' },
  { action: 'set_input_files', ref: 'f3', file_ids: ['<document ID from inventory>'] },
  { action: 'take_snapshot' },
  { action: 'wait', ref: 'a1', state: 'visible', timeout_ms: 30000 },
  { action: 'navigate', value: 'https://employer.example/apply' },
] as const;

export const SIMPLE_BROWSER_EXAMPLES = [
  { tool: 'browser_fill', args: { ref: 'f0', value: '<candidate answer>' } },
  { tool: 'browser_select_dropdown', args: { ref: 'f1', option: '<observed option>' } },
  { tool: 'browser_choose_radio', args: { ref: 'f2:1' } },
  { tool: 'browser_set_checkbox', args: { ref: 'f3', checked: true } },
  { tool: 'browser_upload', args: { ref: 'f4', file_ids: ['<document ID>'] } },
  { tool: 'browser_click', args: { ref: 'a0', sends_application: false } },
] as const;

export const BROWSER_FIELD_GUIDANCE = `Ordinary controls use dedicated tools and current field refs. Omit unused arguments. These examples use placeholders, not candidate answers or reusable refs. Use the same tool and args inside browser_batch.actions:\n${SIMPLE_BROWSER_EXAMPLES.map(example => JSON.stringify(example)).join('\n')}`;

/** Advice about the observed control only. Never supplies a candidate answer
 * or changes which operations the agent can execute. */
export function ordinaryFieldGuidance(field: Pick<FormField, 'label' | 'kind' | 'inputType' | 'autocomplete'> & { ref?: string }): string {
  const label = `${JSON.stringify(field.label || 'Selected control')}${field.ref && /^(?:[af]\d|frame\d)/.test(field.ref) ? ` [${field.ref}]` : ''}`;
  if (field.inputType === 'file') return `${label}: upload with browser_upload and file_ids, an array of document IDs.`;
  if (['button', 'submit', 'reset'].includes(field.inputType ?? '')) return `${label}: use browser_click with its current control ref.`;
  if (field.autocomplete) return `${label}: search with browser_fill {ref, value}. Read dropdown feedback. If not selected, use browser_inspect {ref}; select an offered option with browser_select_dropdown {ref, option} or click its current option ref. Typed text alone is not selection. For no results, investigate a truthful alternate spelling or offered Other option.`;
  if (field.kind === 'select' || ['select-one', 'select-multiple'].includes(field.inputType ?? '')) return `${label}: choose an observed option with browser_select_dropdown and option.`;
  if (field.kind === 'radio' || field.inputType === 'radio') return `${label}: choose the intended individual answer option with browser_choose_radio and that option's current ref or a scoped locator, not the question group ref.`;
  if (field.kind === 'checkbox' || field.inputType === 'checkbox') return `${label}: use browser_set_checkbox with checked=true or checked=false.`;
  return `${label}: enter the candidate's answer with browser_fill and value.`;
}
