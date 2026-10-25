import type { ElementHandle } from 'patchright';

/** Report browser state, not a verdict that the employer accepted an answer. */
export async function readFieldFeedback(locator: ElementHandle<HTMLElement | SVGElement>, requested: string) {
  return locator.evaluate((node, requested) => {
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) {
      return { saved: null, validation: '', matches: false, pendingSelection: false, private: false, connected: node.isConnected };
    }
    const privateField = node instanceof HTMLInputElement && node.type === 'password';
    const selected = node instanceof HTMLSelectElement ? [...node.selectedOptions] : [];
    const saved = node instanceof HTMLInputElement && /^(checkbox|radio)$/.test(node.type) ? String(node.checked)
      : node instanceof HTMLSelectElement ? selected.map(option => option.label).join(', ') : node.value;
    // Phone punctuation is cosmetic. Never strip country prefixes, leading
    // digits or date punctuation: those can change the candidate's answer.
    const telephone = node instanceof HTMLInputElement && node.type === 'tel';
    const normalize = (value: string) => telephone ? value.replace(/[\s().-]/g, '') : value.replace(/\r\n?/g, '\n');
    const pendingSelection = !(node instanceof HTMLSelectElement) && (node.getAttribute('role') === 'combobox'
      || Boolean(node.getAttribute('aria-autocomplete') && node.getAttribute('aria-autocomplete') !== 'none')
      || node.hasAttribute('list') || Boolean(node.closest('[role="combobox"], [role="listbox"]')));
    return {
      saved: privateField ? '[private credential]' : saved,
      validation: node.getAttribute('aria-invalid') === 'true' ? 'aria-invalid' : node.validationMessage,
      matches: node instanceof HTMLSelectElement ? selected.some(option => option.label === requested || option.value === requested)
        : normalize(saved) === normalize(requested),
      pendingSelection, private: privateField, connected: node.isConnected,
    };
  }, requested);
}
