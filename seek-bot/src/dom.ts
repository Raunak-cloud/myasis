import type { Locator, Page } from 'patchright';
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
      /**
       * Many employer forms never associate their labels: the <label> just
       * sits in the same wrapper, or the caption is the previous sibling.
       * A raw name like "phonePrefix" tells the answerer nothing; the
       * caption "* Phone" does.
       */
      let box: Element | null = el.parentElement;
      for (let depth = 0; depth < 3 && box; depth++, box = box.parentElement) {
        const inner = box.querySelector('label');
        const text = inner?.textContent?.trim();
        if (text && text.length < 120 && !inner!.querySelector('input, select, textarea')) return text;
        if (depth === 0) {
          const prev = el.previousElementSibling as HTMLElement | null;
          const prevText = prev?.innerText?.trim();
          if (prevText && prevText.length < 120 && !prev!.querySelector('input, select, textarea')) return prevText;
        }
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder;
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

    /**
     * SEEK's apply wizard marks nothing as required in the markup yet refuses
     * to advance until every question is answered, so on those pages every
     * field counts as required. Elsewhere the markup is trusted.
     */
    const everythingRequired = /(^|\.)seek\.com(\.au)?$/.test(location.hostname) && /\/apply\b/.test(location.pathname);

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
          required: el.required || el.getAttribute('aria-required') === 'true' || Boolean(el.closest('[aria-required="true"]')) || /(^|\s)\*|\*\s*$/.test(labelFor(el)) || everythingRequired,
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
        required: el.required || el.getAttribute('aria-required') === 'true' || Boolean(el.closest('[aria-required="true"]')) || /(^|\s)\*|\*\s*$/.test(labelFor(el)) || everythingRequired,
        currentValue: el.type === 'checkbox' ? String(el.checked) : el.value,
        autocomplete: el.getAttribute('role') === 'combobox',
      });
      });

    radioGroups.forEach((inputs, key) => {
      const ref = `f${n++}`;
      inputs.forEach((i, idx) => i.setAttribute('data-field-id', `${ref}:${idx}`));
      /**
       * The group's caption, not an option's label. Walk up to the smallest
       * element holding every radio in the group, then take its legend or the
       * first caption-like child that is not itself an option label.
       */
      let container: Element | null = inputs[0].parentElement;
      while (container && !inputs.every((input) => container!.contains(input))) container = container.parentElement;
      const caption =
        container?.querySelector('legend')?.textContent?.trim() ||
        [...(container?.querySelectorAll('label, span, div, p') ?? [])]
          .filter((element) => !element.querySelector('input') && !element.closest('label:has(input)'))
          .map((element) => (element as HTMLElement).innerText?.trim() ?? '')
          .find((text) => text && text.length < 120 && !inputs.some((input) => labelFor(input) === text)) ||
        '';
      const groupLabel = caption || key;
      fields.push({
        ref,
        label: groupLabel,
        kind: 'radio',
        required:
          inputs.some((i) => i.required || i.getAttribute('aria-required') === 'true') ||
          Boolean(inputs[0].closest('[aria-required="true"]')) ||
          /(^|\s)\*|\*\s*$/.test(groupLabel) ||
          everythingRequired,
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
  if (field.autocomplete || (await el.getAttribute('role').catch(() => null)) === 'combobox') {
    await pickFromCombobox(page, el, value);
    return;
  }
  await el.fill(value);
}

/**
 * ARIA comboboxes come in two shapes. A searchable one (city, dialling code)
 * filters as you type; a select-style one (title, preferred contact method,
 * "how did you hear") is a read-only input that only opens on click — Ant
 * Design's, used by Dayforce, is the common case. Either way the value is
 * committed by clicking the matching option, exactly as a person does.
 */
async function pickFromCombobox(page: Page, el: Locator, value: string): Promise<void> {
  const typeable = await el
    .evaluate((element) => /^(INPUT|TEXTAREA)$/.test(element.tagName) && !(element as HTMLInputElement).readOnly)
    .catch(() => false);
  const options = page.locator('[role="option"]:visible');
  if (typeable) await el.fill(value);
  else await el.click({ timeout: 3_000 });
  await options.first().waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  if (!(await options.count()) && typeable) {
    // Some searchable selects only open on a click, not on typing.
    await el.click({ timeout: 3_000 }).catch(() => {});
    await options.first().waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  }
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = options.filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, 'i') }).first();
  // "Australia" should pick "Australia (+61)"; a containing match is what a person would click.
  const partial = options.filter({ hasText: new RegExp(escaped, 'i') });
  if (await exact.count()) await exact.click({ timeout: 5_000 });
  else if (await partial.count()) await partial.first().click({ timeout: 5_000 });
  else if (await options.count()) {
    const shown = (await options.allInnerTexts()).map((text) => text.trim()).filter(Boolean).slice(0, 40);
    await page.keyboard.press('Escape').catch(() => {});
    throw new ComboboxOptionsError(value, shown);
  } else throw new Error('The dropdown did not open; re-observe and click its control first.');
}

/**
 * A combobox's choices are only known once it opens. When the answer given
 * blind matches none of them, the caller re-asks with the real list.
 */
export class ComboboxOptionsError extends Error {
  constructor(value: string, readonly options: string[]) {
    super(`No option matches "${value}". Available: ${options.join(' | ')}`);
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
    if (field.autocomplete || el.getAttribute('role') === 'combobox') {
      // A combobox shows its choice in a sibling, not in the input, and often clears the input after choosing.
      const container = el.closest('[class*="select"], [class*="combobox"], [class*="dropdown"], label') ?? el.parentElement?.parentElement ?? el;
      const shown = normal(container.textContent ?? '').toLowerCase();
      const want = normal(value).toLowerCase();
      return normal(el.value).toLowerCase() === want || (want.length > 0 && shown.includes(want));
    }
    return normal(el.value) === normal(value);
  }, { field, value }, { timeout: 2000, polling: 100 }).catch(() => {
    throw new Error(`The form did not accept the value for "${field.label}"; inspect the current field and validation message.`);
  });
}
