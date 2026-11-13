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

export const BROWSER_FIELD_GUIDANCE = `Use one action per call with its matching arguments. These examples are placeholders: replace targets, answers, options, URLs and document IDs with actual current values. Field refs identify controls; file_ids identify documents. For check, value="true" checks and value="false" unchecks. Examples:
${BROWSER_ACTION_EXAMPLES.map(example => JSON.stringify(example)).join('\n')}`;

/** Advice about the observed control only. Never supplies a candidate answer
 * or changes which operations the agent can execute. */
export function ordinaryFieldGuidance(field: Pick<FormField, 'label' | 'kind' | 'inputType' | 'autocomplete'>): string {
  const label = JSON.stringify(field.label || 'Selected control');
  if (field.inputType === 'file') return `${label}: upload with browser_action action="set_input_files" and file_ids, an array of document IDs.`;
  if (['button', 'submit', 'reset'].includes(field.inputType ?? '')) return `${label}: use browser_action action="click" with its current control ref.`;
  if (field.autocomplete) return `${label}: enter search text with browser_action action="fill" and value, then click the matching suggested option.`;
  if (field.kind === 'select' || ['select-one', 'select-multiple'].includes(field.inputType ?? '')) return `${label}: choose an observed option with browser_action action="select" and value.`;
  if (field.kind === 'checkbox' || field.kind === 'radio' || ['checkbox', 'radio'].includes(field.inputType ?? '')) return `${label}: use browser_action action="check" and value for the intended selection.`;
  return `${label}: enter the candidate's answer with browser_action action="fill" and value.`;
}
