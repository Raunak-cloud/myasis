import type { ElementHandle, Page } from 'patchright';

export interface BatchTargetState { status: 'ready' | 'changed' | 'stale'; revision: number; reason?: string }
export interface FieldFeedback {
  saved: string | null; validation: string; matches: boolean; pendingSelection: boolean; private: boolean; connected: boolean;
  batch?: BatchTargetState;
}
type BatchFeedbackRequest = { batchKey: string; index: number; requested: string };

/** Self-contained browser function, shared by ordinary actions and batched readback. */
async function inspectField(target: HTMLElement | SVGElement | BatchFeedbackRequest, requested?: string): Promise<FieldFeedback> {
  const state = target instanceof Element ? undefined : (globalThis as unknown as Record<string, {
    nodes: Array<HTMLElement | SVGElement>; check(): BatchTargetState;
  }>)[target.batchKey];
  const node = target instanceof Element ? target : state?.nodes[target.index];
  const wanted = target instanceof Element ? requested! : target.requested;
  if (state && node instanceof HTMLElement) {
    node.blur();
    // Commit normal change/blur handlers and one render without extra remote calls.
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 50);
      requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
    });
  }
  const batch = state?.check();
  if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) {
    return { saved: null, validation: '', matches: false, pendingSelection: false, private: false, connected: node?.isConnected ?? false, batch };
  }
  const privateField = node instanceof HTMLInputElement && node.type === 'password';
  const selected = node instanceof HTMLSelectElement ? [...node.selectedOptions] : [];
  const saved = node instanceof HTMLInputElement && /^(checkbox|radio)$/.test(node.type) ? String(node.checked)
    : node instanceof HTMLSelectElement ? selected.map(option => option.label).join(', ') : node.value;
  const telephone = node instanceof HTMLInputElement && node.type === 'tel';
  const normalize = (value: string) => telephone ? value.replace(/[\s().-]/g, '') : value.replace(/\r\n?/g, '\n');
  const pendingSelection = !(node instanceof HTMLSelectElement) && (node.getAttribute('role') === 'combobox'
    || Boolean(node.getAttribute('aria-autocomplete') && node.getAttribute('aria-autocomplete') !== 'none')
    || node.hasAttribute('list') || Boolean(node.closest('[role="combobox"], [role="listbox"]')));
  return {
    saved: privateField ? '[private credential]' : saved,
    validation: node.getAttribute('aria-invalid') === 'true' ? 'aria-invalid' : node.validationMessage,
    matches: node instanceof HTMLSelectElement ? selected.some(option => option.label === wanted || option.value === wanted)
      : normalize(saved) === normalize(wanted),
    pendingSelection, private: privateField, connected: node.isConnected, batch,
  };
}

/** Report browser state, not a verdict that the employer accepted an answer. */
export async function readFieldFeedback(locator: ElementHandle<HTMLElement | SVGElement>, requested: string) {
  return locator.evaluate(inspectField, requested);
}

export async function readBatchFieldFeedback(page: Page, batchKey: string, index: number, requested: string) {
  return page.evaluate(inspectField, { batchKey, index, requested });
}
