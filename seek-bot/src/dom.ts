import type { Page } from 'patchright';
import type { FormField } from './types.js';

/**
 * Extracts the interactive fields on the current step as a compact list.
 * Raw HTML would be both enormous and mostly noise; this keeps the model's
 * input small and stable, and gives us a `ref` we can act on afterwards.
 */
export async function extractFields(page: Page): Promise<FormField[]> {
  return page.evaluate(() => {
    const fields: any[] = [];
    let n = 0;

    const deepElements = (root: Document | ShadowRoot = document): Element[] => {
      const found = [...root.querySelectorAll('*')];
      for (const element of [...found]) {
        if (element.shadowRoot) found.push(...deepElements(element.shadowRoot));
      }
      return found;
    };

    const labelFor = (el: Element): string => {
      const root = el.getRootNode() as Document | ShadowRoot;
      const id = el.getAttribute('id');
      if (id) {
        const l = root.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l?.textContent?.trim()) return l.textContent.trim();
      }
      const wrapping = el.closest('label');
      if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const t = labelledBy
          .split(/\s+/)
          .map((i) => root.querySelector(`#${CSS.escape(i)}`)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
        if (t) return t;
      }
      // Fall back to the nearest preceding question-ish text.
      const group = el.closest('fieldset, [role="group"], div');
      const legend = group?.querySelector('legend, h2, h3, strong');
      return legend?.textContent?.trim() ?? el.getAttribute('name') ?? 'unlabelled field';
    };

    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    // Radio groups collapse into one logical field.
    const radioGroups = new Map<string, HTMLInputElement[]>();

    deepElements()
      .filter((element) => /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName))
      .forEach((raw) => {
      const el = raw as HTMLInputElement;
      if (!visible(el)) return;
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'file') return;

      if (el.type === 'radio') {
        const key = el.name || labelFor(el);
        if (!radioGroups.has(key)) radioGroups.set(key, []);
        radioGroups.get(key)!.push(el);
        return;
      }

      const ref = `f${n++}`;
      el.setAttribute('data-field-id', ref);

      if (el.tagName === 'SELECT') {
        const sel = el as unknown as HTMLSelectElement;
        fields.push({
          ref,
          label: labelFor(el),
          kind: 'select',
          required: el.required || el.getAttribute('aria-required') === 'true',
          options: [...sel.options].map((o) => o.textContent?.trim() ?? '').filter(Boolean),
          currentValue: sel.value,
          autocomplete: el.getAttribute('role') === 'combobox',
        });
        return;
      }

      fields.push({
        ref,
        label: labelFor(el),
        kind: el.tagName === 'TEXTAREA' ? 'textarea' : el.type === 'checkbox' ? 'checkbox' : 'text',
        required: el.required || el.getAttribute('aria-required') === 'true',
        currentValue: el.type === 'checkbox' ? String(el.checked) : el.value,
        autocomplete: el.getAttribute('role') === 'combobox',
      });
      });

    radioGroups.forEach((inputs, key) => {
      const ref = `f${n++}`;
      inputs.forEach((i, idx) => i.setAttribute('data-field-id', `${ref}:${idx}`));
      const groupLabel =
        inputs[0].closest('fieldset')?.querySelector('legend')?.textContent?.trim() ??
        (key.startsWith('f') ? key : key);
      fields.push({
        ref,
        label: groupLabel,
        kind: 'radio',
        required: inputs.some((i) => i.required),
        options: inputs.map((i) => labelFor(i)),
        currentValue: inputs.find(i => i.checked) ? labelFor(inputs.find(i => i.checked)!) : '',
      });
    });

    return fields;
  });
}

/** Applies a resolved answer back onto the page. */
async function fillFieldUnchecked(page: Page, field: FormField, value: string): Promise<void> {
  const deepFill = async () => {
    const outcome = await page.evaluate(({ ref, kind, wanted, options }) => {
      const deepElements = (root: Document | ShadowRoot = document): Element[] => {
        const found = [...root.querySelectorAll('*')];
        for (const element of [...found]) {
          if (element.shadowRoot) found.push(...deepElements(element.shadowRoot));
        }
        return found;
      };
      const all = deepElements();
      if (kind === 'radio') {
        const index = (options ?? []).findIndex((option) => option.toLowerCase().trim() === wanted.toLowerCase().trim());
        const fallback = index >= 0 ? index : (options ?? []).findIndex((option) => option.toLowerCase().includes(wanted.toLowerCase()));
        const radio = all.find((element) => element.getAttribute('data-field-id') === `${ref}:${fallback}`) as HTMLInputElement | undefined;
        if (!radio || fallback < 0) return false;
        radio.click();
        radio.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return true;
      }
      const element = all.find((candidate) => candidate.getAttribute('data-field-id') === ref) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
      if (!element) return false;
      if (kind === 'checkbox') {
        const checked = wanted.toLowerCase() === 'true';
        if ((element as HTMLInputElement).checked !== checked) (element as HTMLInputElement).click();
      } else if (kind === 'select') {
        const select = element as HTMLSelectElement;
        const option = [...select.options].find((item) => item.textContent?.trim() === wanted || item.value === wanted);
        if (!option) return false;
        select.value = option.value;
      } else {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, wanted);
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: wanted }));
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      element.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true }));
      return true;
    }, { ref: field.ref, kind: field.kind, wanted: value, options: field.options });
    if (!outcome) throw new Error(`could not find ${field.ref} inside the form components`);
  };

  const direct = page.locator(`[data-field-id="${field.ref}"]`);
  if (!(await direct.count())) {
    await deepFill();
    if (field.autocomplete) {
      await page
        .waitForFunction(
          () => {
            const roots: Array<Document | ShadowRoot> = [document];
            for (let i = 0; i < roots.length; i++) {
              for (const element of roots[i].querySelectorAll('*')) {
                if (element.getAttribute('role') === 'option') return true;
                if (element.shadowRoot) roots.push(element.shadowRoot);
              }
            }
            return false;
          },
          undefined,
          { timeout: 1_200 },
        )
        .catch(() => {});
      await page.evaluate((wanted) => {
        const deepElements = (root: Document | ShadowRoot = document): Element[] => {
          const found = [...root.querySelectorAll('*')];
          for (const element of [...found]) if (element.shadowRoot) found.push(...deepElements(element.shadowRoot));
          return found;
        };
        const options = deepElements().filter((element) => element.getAttribute('role') === 'option');
        const chosen = options.find((option) => option.textContent?.trim().toLowerCase() === wanted.toLowerCase());
        (chosen as HTMLElement | undefined)?.click();
      }, value);
    }
    return;
  }

  if (field.kind === 'radio') {
    const idx = (field.options ?? []).findIndex(
      (o) => o.toLowerCase().trim() === value.toLowerCase().trim(),
    );
    const pick = idx >= 0 ? idx : (field.options ?? []).findIndex((o) =>
      o.toLowerCase().includes(value.toLowerCase()),
    );
    if (pick < 0) throw new Error(`no radio option matching "${value}" in [${field.options?.join(' | ')}]`);
    await page.locator(`[data-field-id="${field.ref}:${pick}"]`).check({ force: true });
    return;
  }

  const el = direct;
  if (field.kind === 'select') {
    await el.selectOption({ label: value }).catch(async () => {
      await el.selectOption(value);
    });
    return;
  }
  if (field.kind === 'checkbox') {
    if (value.toLowerCase() === 'true') await el.check({ force: true });
    else await el.uncheck({ force: true });
    return;
  }
  await el.fill(value);
  // Common external ATS forms implement City and similar fields as an ARIA
  // combobox. Typing alone leaves the required value uncommitted, so select
  // the matching suggestion just as a user would.
  if (field.autocomplete || (await el.getAttribute('role').catch(() => null)) === 'combobox') {
    const options = page.locator('[role="option"]:visible');
    await options.first().waitFor({ state: 'visible', timeout: 1_200 }).catch(() => {});
    const exact = options.filter({ hasText: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first();
    if (await exact.count()) await exact.click({ timeout: 5_000 });
    else if (await options.count()) throw new Error('No exact autocomplete option; re-observe the available choices.');
  }
}

/** Short text summary of the page, for classifying unexpected steps. */
export async function pageSummary(page: Page): Promise<string> {
  const title = await page.title().catch(() => '');
  const heading = await page
    .locator('h1, h2')
    .first()
    .innerText()
    .catch(() => '');
  const body = await page
    .locator('main, [role="main"], body')
    .first()
    .innerText()
    .catch(() => '');
  const buttons = await page
    .locator('button:visible, a[role="button"]:visible')
    .allInnerTexts()
    .catch(() => [] as string[]);
  return [
    `URL: ${page.url()}`,
    `TITLE: ${title}`,
    `HEADING: ${heading}`,
    `BUTTONS: ${[...new Set(buttons)].slice(0, 15).join(' | ')}`,
    `TEXT: ${body.replace(/\s+/g, ' ').slice(0, 1800)}`,
  ].join('\n');
}

/** Fill only reports success after the browser accepts and retains the value. */
export async function fillField(page: Page, field: FormField, value: string): Promise<void> {
  await fillFieldUnchecked(page, field, value);
  await page.waitForFunction(({ field, value }) => {
    const roots: Array<Document | ShadowRoot> = [document];
    const elements: Element[] = [];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll('*')) { elements.push(el); if (el.shadowRoot) roots.push(el.shadowRoot); }
    }
    const normal = (s: string) => s.replace(/\s+/g, ' ').trim();
    if (field.kind === 'radio') {
      const idx = field.options?.findIndex(o => normal(o) === normal(value)) ?? -1;
      return idx >= 0 && Boolean((elements.find(e => e.getAttribute('data-field-id') === `${field.ref}:${idx}`) as HTMLInputElement)?.checked);
    }
    const el = elements.find(e => e.getAttribute('data-field-id') === field.ref) as HTMLInputElement | HTMLSelectElement | undefined;
    if (!el || el.getAttribute('aria-invalid') === 'true' || !el.validity.valid) return false;
    if (field.kind === 'checkbox') return (el as HTMLInputElement).checked === (value === 'true');
    if (field.kind === 'select') return [...(el as HTMLSelectElement).selectedOptions].some(o => normal(o.textContent ?? '') === normal(value) || o.value === value);
    return normal(el.value) === normal(value);
  }, { field, value }, { timeout: 2000, polling: 100 }).catch(() => {
    throw new Error(`The form did not accept the value for "${field.label}"; inspect the current field and validation message.`);
  });
}
