import type { FormField } from '../types.js';

export const BROWSER_FIELD_GUIDANCE = 'Enter text with action="fill" and value. Choose a dropdown option with action="select" and value. Upload documents with action="set_input_files" and file_ids (an array of document IDs). A field ref such as f0 identifies a control, not a document.';

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
