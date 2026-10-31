import type { Page } from 'patchright';
import { browserDeadline, assertBrowserOperationActive } from '../browser-deadline.js';
import { extractFields } from '../dom.js';
import type { FormField } from '../types.js';
import { privateAuthenticationValues, redactPrivateAuthenticationData } from '../private-auth-fields.js';

/** A fresh read, never a tool's claim that its fill succeeded. Frame-scoped
 * identities keep equal captions on different forms from sharing a verdict. */
interface SavedFormField extends FormField {
  localRef: string;
  frame: number;
  expanded?: string | null;
  invalid?: string | null;
  selectedValues?: string[];
}
export interface SavedForm {
  url: string;
  fields: SavedFormField[];
  text: string;
}

export async function readSavedForm(page: Page): Promise<SavedForm> {
  return browserDeadline('Saved application inspection', 15_000, () => readSavedFormNow(page));
}

async function readSavedFormNow(page: Page): Promise<SavedForm> {
  const fields: SavedFormField[] = [];
  const sections: string[] = [];
  for (const [frameIndex, frame] of page.frames().entries()) {
    assertBrowserOperationActive();
    if (!/^https?:|^about:(blank|srcdoc)$/.test(frame.url())) continue;
    if (/recaptcha|hcaptcha|turnstile|challenges.cloudflare|arkoselabs|funcaptcha/i.test(frame.url())) continue;
    if (frame.parentFrame()) {
      const host = await frame.frameElement();
      try { if (!await host.isVisible()) continue; }
      finally { await host.dispose(); }
    }
    const observed = await extractFields(frame);
    assertBrowserOperationActive();
    const state = await frame.evaluate(() => {
      const roots: Array<Document | ShadowRoot> = [document];
      const controls: Record<string, { expanded: string | null; invalid: string | null; error: string; selectedValues?: string[] }> = {};
      for (let i = 0; i < roots.length; i++) {
        for (const el of roots[i].querySelectorAll('*')) {
          if (el.shadowRoot) roots.push(el.shadowRoot);
          const ref = el.getAttribute('data-field-id')?.split(':')[0];
          if (!ref) continue;
          const input = el as HTMLInputElement;
          const ids = `${el.getAttribute('aria-errormessage') ?? ''} ${el.getAttribute('aria-describedby') ?? ''}`.split(/\s+/).filter(Boolean);
          const invalid = el.getAttribute('aria-invalid');
          const error = invalid === 'true' || input.validationMessage
            ? ids.map(id => roots[i].querySelector(`#${CSS.escape(id)}`)?.textContent?.trim()).filter(Boolean).join(' ')
              || input.validationMessage || 'The form marks this field invalid.' : '';
          const previous = controls[ref];
          const linked = `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(/\s+/).filter(Boolean)
            .map(id => roots[i].getElementById(id)).filter((list): list is HTMLElement => Boolean(list && list.getAttribute('aria-multiselectable') === 'true'));
          const selectedValues = linked.length === 1 ? [...linked[0].querySelectorAll('[role="option"][aria-selected="true"], [role="option"][aria-checked="true"]')]
            .map(option => (option.textContent ?? '').trim()) : undefined;
          controls[ref] = { expanded: el.getAttribute('aria-expanded'), invalid, error: previous?.error || error,
            ...(selectedValues ? { selectedValues } : {}) };
        }
      }
      return { controls, text: document.body?.innerText ?? '' };
    });
    for (const field of observed) {
      if (field.sensitive) continue;
      const control = state.controls[field.ref];
      fields.push({ ...field, localRef: field.ref, ref: `frame${frameIndex}:${field.ref}`, frame: frameIndex,
        validationError: control?.error || undefined, expanded: control?.expanded, invalid: control?.invalid,
        ...(control?.selectedValues ? { selectedValues: control.selectedValues, currentValue: JSON.stringify(control.selectedValues) } : {}) });
    }
    // Include the end of a review page as well as its beginning. Inputs are
    // represented explicitly above, so truncating surrounding copy loses no
    // field value. Secrets and hidden input values are never collected.
    const text = state.text;
    sections.push(`Frame ${frameIndex}:\n${text.length > 16000 ? `${text.slice(0, 8000)}\n…\n${text.slice(-8000)}` : text}`);
  }
  const form = { url: page.url(), fields, text: sections.join('\n\n') };
  if (JSON.stringify(form).length > 120000) throw new Error('The saved form is too large to review completely.');
  return redactPrivateAuthenticationData(form, await privateAuthenticationValues(page));
}
