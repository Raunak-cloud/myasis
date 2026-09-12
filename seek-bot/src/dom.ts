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

    /**
     * Whether a "label" is really just a machine name.
     *
     * SEEK names its questionnaire inputs `questionnaire.AU_Q_26_V_3`. Falling
     * back to that produced questions no human could answer — the candidate
     * was shown "questionnaire.AU_Q_26_V_3" and an empty box. Anything with no
     * spaces that reads like an identifier is treated as no label at all, so
     * the search keeps looking instead of stopping on it.
     */
    const opaqueName = (text: string): boolean =>
      !text.includes(' ') && (/[._]/.test(text) || /^[A-Z0-9_.-]+$/.test(text)) && !text.endsWith('?');

    /**
     * The nearest caption above an element.
     *
     * A question and its inputs are often siblings rather than parent and
     * child: SEEK renders the question as a heading and the radios as the
     * block after it, so nothing inside the input's own container names it.
     * This walks up the ancestors and, at each level, back through the
     * preceding siblings, taking the first text that is not itself part of
     * some other control.
     */
    const captionAbove = (start: Element, reject: (text: string) => boolean): string => {
      let node: Element | null = start;
      for (let up = 0; up < 6 && node; up++, node = node.parentElement) {
        for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
          if (sib.querySelector('input, select, textarea')) continue;
          const text = (sib as HTMLElement).innerText?.trim().replace(/\s+/g, ' ') ?? '';
          if (text && text.length > 2 && text.length < 200 && !opaqueName(text) && !reject(text)) return text;
        }
      }
      return '';
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

      const fieldset = el.closest('fieldset, [role="group"]');
      const legend = fieldset?.querySelector('legend, h1, h2, h3, h4, [role="heading"]')?.textContent?.trim();
      if (legend && !opaqueName(legend)) return legend;

      // Nothing names it from the inside; look at what sits above it.
      const above = captionAbove(el, () => false);
      if (above) return above;

      /**
       * Last resort before giving up: the closest text on screen.
       *
       * DOM order stops being a guide once a form uses absolute positioning or
       * a grid — SEEK's "Show strong interest" checkbox sits in the corner of
       * a card with its wording laid out beside it rather than before it, so
       * no amount of sibling-walking finds it. Distance on screen does, and
       * text to the left or above wins ties because that is where a caption
       * sits in a left-to-right form.
       */
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width || rect.height) {
        const scope = el.closest('form, section, article, fieldset, [class*="card"]') ?? document.body;
        let best: { text: string; score: number } | null = null;
        for (const candidate of scope.querySelectorAll('label, span, p, div, h1, h2, h3, h4, a')) {
          if (candidate.contains(el) || candidate.querySelector('input, select, textarea')) continue;
          const text = (candidate as HTMLElement).innerText?.trim().replace(/\s+/g, ' ') ?? '';
          if (!text || text.length < 3 || text.length > 120 || opaqueName(text)) continue;
          const r = candidate.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          const dx = Math.max(0, Math.max(r.left - rect.right, rect.left - r.right));
          const dy = Math.max(0, Math.max(r.top - rect.bottom, rect.top - r.bottom));
          if (dx > 400 || dy > 120) continue;
          const behind = r.left <= rect.left || r.top <= rect.top ? 0 : 60;
          const score = dx + dy * 2 + behind;
          if (!best || score < best.score) best = { text, score };
        }
        if (best) return best.text;
      }

      /**
       * Last resort. The machine name is only worth showing if it reads like
       * words — "phonePrefix" is a hint, "questionnaire.AU_Q_26_V_3" is not,
       * and pretending the latter is a question just moves the failure to
       * whoever has to answer it.
       */
      const name = el.getAttribute('name') ?? '';
      return name && !opaqueName(name) ? name : 'unlabelled field';
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
    const seekApplyPage = /(^|\.)seek\.com(\.au)?$/.test(location.hostname) && /\/apply\b/.test(location.pathname);

    /**
     * ...with one exception: a control nobody could name.
     *
     * That blanket rule swept in SEEK's own "Show strong interest" checkbox, a
     * promotional toggle in the corner of the apply page. It is not an
     * employer question, nothing in the DOM associates a caption with it, and
     * counting it as required blocked entire applications on "Fields not
     * verified: unlabelled field" — an unanswerable prompt for an optional
     * upsell.
     *
     * A real employer question always renders its wording somewhere. If
     * nothing on the page names a control, it is chrome, and the markup's own
     * silence about whether it is required is the better guide.
     */
    const requiredOnThisPage = (label: string) =>
      seekApplyPage && label !== 'unlabelled field' && label !== 'unlabelled question';

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
          required: el.required || el.getAttribute('aria-required') === 'true' || Boolean(el.closest('[aria-required="true"]')) || /(^|\s)\*|\*\s*$/.test(labelFor(el)) || requiredOnThisPage(labelFor(el)),
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
        required: el.required || el.getAttribute('aria-required') === 'true' || Boolean(el.closest('[aria-required="true"]')) || /(^|\s)\*|\*\s*$/.test(labelFor(el)) || requiredOnThisPage(labelFor(el)),
        currentValue: el.type === 'checkbox' ? String(el.checked) : el.value,
        autocomplete: el.getAttribute('role') === 'combobox',
        // Only when it constrains the value; "text" tells the answerer nothing.
        ...(el.tagName === 'INPUT' && el.type && el.type !== 'text' ? { inputType: el.type } : {}),
        /**
         * A credential, never an employer question.
         *
         * Some employer sites make you create an account mid-application, so
         * "Choose Password" turns up among the questions. Left unmarked it
         * reached the answer bank, which stores answers in plain text and
         * replays them on every later form asking the same thing — one typed
         * password would have been reused across unrelated employers.
         */
        sensitive: el.type === 'password' || /\bpass(word|phrase)\b/i.test(labelFor(el)),
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
      const isOptionLabel = (text: string) => inputs.some((input) => labelFor(input) === text);
      const caption =
        container?.querySelector('legend')?.textContent?.trim() ||
        [...(container?.querySelectorAll('label, span, div, p') ?? [])]
          .filter((element) => !element.querySelector('input') && !element.closest('label:has(input)'))
          .map((element) => (element as HTMLElement).innerText?.trim() ?? '')
          .find((text) => text && text.length < 120 && !isOptionLabel(text)) ||
        // The question is usually a heading above the options, not inside them.
        (container ? captionAbove(container, isOptionLabel) : '') ||
        '';
      // `key` is the input's name, which for SEEK is an opaque questionnaire id.
      const groupLabel = caption || (opaqueName(key) ? 'unlabelled question' : key);
      fields.push({
        ref,
        label: groupLabel,
        kind: 'radio',
        required:
          inputs.some((i) => i.required || i.getAttribute('aria-required') === 'true') ||
          Boolean(inputs[0].closest('[aria-required="true"]')) ||
          /(^|\s)\*|\*\s*$/.test(groupLabel) ||
          requiredOnThisPage(groupLabel),
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
  } else {
    /**
     * Nothing matched is not the same as nothing opened.
     *
     * Typing "NSW" into one of these pickers leaves the list showing "No
     * Data" — open, but empty. Reporting that as "the dropdown did not open"
     * sent the agent off to re-observe and click the control again, over and
     * over, until its step budget ran out, when the actual fix was to search
     * "New South Wales" instead.
     */
    const popupOpen = await page
      .locator('[role="listbox"]:visible, [role="dialog"]:visible, .no-data, [class*="no-data"], [class*="noData"]')
      .count()
      .then((count) => count > 0)
      .catch(() => false);
    await page.keyboard.press('Escape').catch(() => {});
    if (popupOpen && typeable) {
      throw new ComboboxOptionsError(value, []);
    }
    throw new Error('The dropdown did not open; re-observe and click its control first.');
  }
}

/**
 * A combobox's choices are only known once it opens. When the answer given
 * blind matches none of them, the caller re-asks with the real list.
 */
export class ComboboxOptionsError extends Error {
  constructor(value: string, readonly options: string[]) {
    super(
      options.length
        ? `No option matches "${value}". Available: ${options.join(' | ')}`
        : `Searching "${value}" returned nothing. The list is a search box, not a fixed menu, so answer with the ` +
          `full spelled-out form instead of an abbreviation — "New South Wales" rather than "NSW".`,
    );
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
  }, { field, value }, { timeout: 2000, polling: 100 }).catch(async () => {
    const complaint = await readValidationMessage(page, field);
    throw new FieldRejectedError(field.label, value, complaint);
  });
}

/**
 * What the form said was wrong, in its own words.
 *
 * This used to throw "inspect the current field and validation message" —
 * telling the model to go and look at something it was never shown. The page
 * was saying "Mobile phone number is invalid" next to an empty dialling-code
 * selector, and the answer never got that back, so it had no way to work out
 * that a leading zero and a +61 prefix cannot both be there.
 *
 * Reading the complaint and handing it over is the general form of that fix.
 * A rule per format — phone here, state name there, dates next — only ever
 * covers the cases already seen; the form itself knows why it refused, for
 * every case, including the ones nobody has hit yet.
 */
async function readValidationMessage(page: Page, field: FormField): Promise<string> {
  return page
    .evaluate(({ ref }) => {
      const roots: (Document | ShadowRoot)[] = [document];
      const elements: Element[] = [];
      for (let i = 0; i < roots.length; i++) {
        for (const el of roots[i].querySelectorAll('*')) {
          elements.push(el);
          if (el.shadowRoot) roots.push(el.shadowRoot);
        }
      }
      const el = elements.find((e) => (e.getAttribute('data-field-id') ?? '').split(':')[0] === ref);
      if (!el) return '';
      const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

      // The browser's own message, when the constraint is a native one.
      const native = clean((el as HTMLInputElement).validationMessage);
      if (native) return native;

      // Whatever the form points at as this field's error.
      for (const attribute of ['aria-errormessage', 'aria-describedby']) {
        for (const id of (el.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean)) {
          const text = clean(document.getElementById(id)?.textContent);
          if (text) return text;
        }
      }

      /**
       * Otherwise the nearest thing that looks like an error. Bounded to the
       * field's own surroundings so a message belonging to another field is
       * not read back as this one's.
       */
      let scope: Element | null = el.parentElement;
      for (let up = 0; up < 4 && scope; up++, scope = scope.parentElement) {
        const found = scope.querySelector('[role="alert"], [class*="error" i], [class*="invalid" i], [class*="Error"]');
        const text = clean((found as HTMLElement | null)?.innerText);
        if (text && text.length < 200) return text;
      }
      return '';
    }, { ref: field.ref })
    .catch(() => '');
}

/**
 * A value the form refused, carrying the form's own reason so the retry can
 * be told what to change rather than guessing a second time.
 */
export class FieldRejectedError extends Error {
  constructor(readonly label: string, readonly value: string, readonly complaint: string) {
    super(
      complaint
        ? `The form rejected "${value}" for "${label}": ${complaint}`
        : `The form did not accept "${value}" for "${label}".`,
    );
  }
}
