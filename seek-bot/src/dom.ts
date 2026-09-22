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

    // A web component's label can contain a slot: textContent sees only the
    // required '*' marker, while the actual question is assigned to the slot.
    const composedText = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes({ flatten: true });
        return (assigned.length ? assigned : [...node.childNodes]).map(composedText).join(' ');
      }
      return [...node.childNodes].map(composedText).join(' ').replace(/\s+/g, ' ').trim();
    };
    const usefulLabel = (node: Element | null): string => {
      const text = node ? composedText(node) : '';
      return /[\p{L}\p{N}]/u.test(text) ? text : '';
    };
    const labelFor = (el: Element): string => {
      const root = el.getRootNode() as Document | ShadowRoot;
      const id = el.getAttribute('id');
      if (id) {
        const l = root.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (usefulLabel(l)) return usefulLabel(l);
      }
      const wrapping = el.closest('label');
      if (usefulLabel(wrapping)) return usefulLabel(wrapping);
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const t = labelledBy
          .split(/\s+/)
          .filter(Boolean)
          .map((i) => usefulLabel(root.querySelector(`#${CSS.escape(i)}`)))
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
        const text = usefulLabel(inner ?? null);
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

    /** Supporting instructions associated with a field, separate from its short label. */
    const descriptionFor = (el: Element, label: string): string => {
      const root = el.getRootNode() as Document | ShadowRoot;
      const describedBy = el.getAttribute('aria-describedby');
      if (describedBy) {
        const text = describedBy
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text && text !== label && text.length <= 500) return text;
      }

      let box: Element | null = el.parentElement;
      for (let depth = 0; depth < 3 && box; depth++, box = box.parentElement) {
        const candidates = box.querySelectorAll(
          'small, [class*="hint" i], [class*="help" i], [class*="description" i], [data-testid*="description" i]',
        );
        for (const candidate of candidates) {
          if (candidate.contains(el) || candidate.querySelector('input, select, textarea')) continue;
          const text = (candidate as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '';
          if (text && text !== label && text.length >= 3 && text.length <= 500) return text;
        }
      }
      return '';
    };

    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    /**
     * Where a field sits on the page, so the answerer reads a label the way a
     * person does: in its place. "Job Title" under "Work Experience 1" is a
     * job the candidate held; "Month" means nothing until it is "From".
     * Collected once — the nearest visible heading before the field, then the
     * named groups around it — and reported, never interpreted, here.
     */
    const squash = (node: Element | null | undefined): string =>
      ((node as HTMLElement | null)?.innerText ?? node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const nameable = (text: string, label: string): boolean =>
      text.length > 1 && text.length <= 100 && text !== label && !opaqueName(text);
    const headings = deepElements().filter(
      (node) => (/^H[1-6]$/.test(node.tagName) || node.getAttribute('role') === 'heading') && visible(node),
    );
    const groupName = (group: Element): string => {
      const root = group.getRootNode() as Document | ShadowRoot;
      const labelledBy = (group.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => squash(root.querySelector(`#${CSS.escape(id)}`)))
        .join(' ');
      return group.getAttribute('aria-label') || labelledBy || squash(group.querySelector(':scope > legend'));
    };
    const sectionFor = (el: Element, label: string): string => {
      const parts: string[] = [];
      const groupSelector = 'fieldset, [role="group"], [role="radiogroup"]';
      for (let group = el.parentElement?.closest(groupSelector) ?? null; group && parts.length < 2; group = group.parentElement?.closest(groupSelector) ?? null) {
        const name = groupName(group);
        if (nameable(name, label) && !parts.includes(name)) parts.unshift(name);
      }
      let heading = '';
      for (const candidate of headings) {
        if (candidate.contains(el)) continue;
        if (candidate.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) heading = squash(candidate);
      }
      if (nameable(heading, label) && !parts.includes(heading)) parts.unshift(heading);
      return parts.join(' › ');
    };

    // Report actual markup evidence. The model interprets missing requirements
    // from page instructions and validation; a hostname cannot require fields.

    // Hidden controls may retain refs from the previous observation. Clear them
    // before assigning new refs so a new visible field cannot share an old ref.
    for (const element of deepElements()) element.removeAttribute('data-field-id');

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
      const label = labelFor(el);
      const description = descriptionFor(el, label);
      const section = sectionFor(el, label);

      if (el.tagName === 'SELECT') {
        const sel = el as unknown as HTMLSelectElement;
        fields.push({
          ref,
          label,
          ...(description ? { description } : {}),
          ...(section ? { section } : {}),
          kind: 'select',
          required: el.required || el.getAttribute('aria-required') === 'true' || Boolean(el.closest('[aria-required="true"]')) || /(^|\s)\*|\*\s*$/.test(label),
          options: [...sel.options].map((o) => o.textContent?.trim() ?? '').filter(Boolean),
          currentValue: sel.value,
          autocomplete: el.getAttribute('role') === 'combobox',
        });
        return;
      }

      fields.push({
        ref,
        label,
        ...(description ? { description } : {}),
        ...(section ? { section } : {}),
        kind: el.tagName === 'TEXTAREA' ? 'textarea' : el.type === 'checkbox' ? 'checkbox' : 'text',
        required: el.required || el.getAttribute('aria-required') === 'true' || Boolean(el.closest('[aria-required="true"]')) || /(^|\s)\*|\*\s*$/.test(label),
        currentValue: el.type === 'checkbox' ? String(el.checked) : el.value,
        autocomplete: el.getAttribute('role') === 'combobox',
        // Only when it constrains the value; "text" tells the answerer nothing.
        ...(el.tagName === 'INPUT' && el.type && el.type !== 'text'
          ? { inputType: el.type }
          : el.getAttribute('role') === 'spinbutton' ? { inputType: 'number' } : {}),
        /**
         * A credential, never an employer question.
         *
         * Some employer sites make you create an account mid-application, so
         * "Choose Password" turns up among the questions. Left unmarked it
         * reached the answer bank, which stores answers in plain text and
         * replays them on every later form asking the same thing — one typed
         * password would have been reused across unrelated employers.
         */
        sensitive: el.type === 'password' || /\bpass(word|phrase)\b/i.test(label),
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
      const description = descriptionFor(container ?? inputs[0], groupLabel);
      const section = sectionFor(container ?? inputs[0], groupLabel);
      fields.push({
        ref,
        label: groupLabel,
        ...(description ? { description } : {}),
        ...(section ? { section } : {}),
        kind: 'radio',
        required:
          inputs.some((i) => i.required || i.getAttribute('aria-required') === 'true') ||
          Boolean(inputs[0].closest('[aria-required="true"]')) ||
          /(^|\s)\*|\*\s*$/.test(groupLabel),
        options: inputs.map((i) => labelFor(i)),
        currentValue: inputs.find(i => i.checked) ? labelFor(inputs.find(i => i.checked)!) : '',
      });
    });

    return fields;
  });
}

/** Applies a resolved answer back onto the page. */
async function fillFieldUnchecked(page: Page, field: FormField, value: string, modelDirected: false | 'type' | 'search' = false): Promise<void> {
  if (modelDirected && ['text', 'textarea'].includes(field.kind)) {
    const input = page.locator(`[data-field-id="${field.ref}"]`);
    await input.fill(value, { timeout: 5_000 });
    if (modelDirected === 'type') await input.blur({ timeout: 5_000 });
    return;
  }
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
    /**
     * Most styled radio groups hide the input and draw the label; setting the
     * input checked directly leaves the page's own state behind, and one form
     * then answered "Choose an option to continue" to a visibly chosen option.
     */
    const input = page.locator(`[data-field-id="${field.ref}:${pick}"]`);
    const inputId = await input.getAttribute('id').catch(() => null);
    const label = inputId
      ? page.locator(`label[for="${inputId}"]`).or(input.locator('xpath=ancestor::label[1]'))
      : input.locator('xpath=ancestor::label[1]');
    const viaLabel = (await label.count().catch(() => 0)) > 0
      ? await label.first().click({ timeout: 3_000 }).then(() => true).catch(() => false)
      : false;
    if (!viaLabel) await input.check({ force: true });
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
 * Opens a select-style combobox and waits for its list.
 *
 * The accessible input is frequently not the thing a person clicks. Ant
 * Design, Dayforce and Workday draw the control as a styled box and leave the
 * input inside it read-only — sometimes zero-width, sometimes covered by the
 * box's own overlay — so `click` on the input never becomes actionable and
 * times out. One employer form spent an entire step budget that way.
 *
 * So the widget is opened the way a person opens it: try the input, then the
 * box that draws it, then a forced click, then the raw pointer sequence. Each
 * attempt is judged by whether options actually appeared, not by whether the
 * click resolved, because a click that lands on the wrong layer succeeds and
 * opens nothing.
 */
async function openPicker(page: Page, el: Locator, options: Locator): Promise<void> {
  const container = el.locator(
    'xpath=ancestor::*[@role="combobox" or @role="button" or contains(@class,"select") or ' +
      'contains(@class,"combobox") or contains(@class,"dropdown")][1]',
  );
  const attempts: Array<() => Promise<unknown>> = [
    () => el.click({ timeout: 1_500 }),
    () => container.first().click({ timeout: 1_500 }),
    () => el.click({ timeout: 1_500, force: true }),
    () =>
      el.evaluate((node) => {
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
          node.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }));
        }
        (node as HTMLElement).focus?.();
      }),
  ];
  for (const attempt of attempts) {
    if (!(await attempt().then(() => true).catch(() => false))) continue;
    await options.first().waitFor({ state: 'visible', timeout: 1_200 }).catch(() => {});
    if (await options.count()) return;
  }
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
  else await openPicker(page, el, options);
  await options.first().waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  if (!(await options.count()) && typeable) {
    // Some searchable selects only open on a click, not on typing.
    await openPicker(page, el, options);
  }
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = options.filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, 'i') }).first();
  // "Australia" should pick "Australia (+61)"; a containing match is what a person would click.
  const partial = options.filter({ hasText: new RegExp(escaped, 'i') });
  const loose = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wantLoose = loose(value);
  const wantWords = wantLoose.split(' ').filter(Boolean);
  const looseMatch = async (): Promise<number> => {
    const texts = (await options.allInnerTexts().catch(() => [])).map(loose);
    const byText = texts.findIndex((text) => text === wantLoose);
    if (byText >= 0) return byText;
    const byContain = texts.findIndex((text) => wantLoose.length > 0 && (text.includes(wantLoose) || wantLoose.includes(text)));
    if (byContain >= 0) return byContain;
    return texts.findIndex((text) => wantWords.length > 0 && wantWords.every((word) => text.split(' ').includes(word)));
  };
  if (await exact.count()) await exact.click({ timeout: 5_000 });
  else if (await partial.count()) await partial.first().click({ timeout: 5_000 });
  else if (await options.count()) {
    const index = await looseMatch();
    if (index >= 0) {
      await options.nth(index).click({ timeout: 5_000 });
    } else {
      const shown = (await options.allInnerTexts()).map((text) => text.trim()).filter(Boolean).slice(0, 40);
      await page.keyboard.press('Escape').catch(() => {});
      throw new ComboboxOptionsError(value, shown);
    }
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

/**
 * The choices a custom dropdown actually offers, read by opening it.
 *
 * `extractFields` can only report options it can see in the DOM, which covers
 * a native `<select>` and a radio group. A combobox built out of a div and a
 * popup — Workday's, Ant Design's, most modern employer forms — has no
 * options in the document until it is opened, so those fields reached the
 * candidate as a bare text box reading "Select an option" with nothing to
 * select. This opens the widget the same way `pickFromCombobox` does, reads
 * the list, and closes it again.
 *
 * Called only for the handful of fields that actually blocked an application,
 * never during normal extraction: opening every dropdown on a page would be
 * both slow and disruptive.
 */
export async function readPickerOptions(page: Page, ref: string): Promise<string[]> {
  const el = page.locator(`[data-field-id="${ref}"]`).first();
  if (!(await el.count().catch(() => 0))) return [];
  const options = page.locator('[role="option"]:visible');
  try {
    await openPicker(page, el, options);
    if (!(await options.count())) return [];
    const labels = await options.allTextContents();
    return [...new Set(labels.map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 40);
  } catch {
    return [];
  } finally {
    // Leave the form as it was found; an open menu swallows the next click.
    await page.keyboard.press('Escape').catch(() => {});
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
export async function fillField(page: Page, field: FormField, value: string, modelDirected: false | 'type' | 'search' = false): Promise<void> {
  await fillFieldUnchecked(page, field, value, modelDirected);
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
      /**
       * A combobox shows its choice in a sibling, not in the input, and often
       * clears the input after choosing — so the check reads the widget, not
       * the field.
       *
       * Which element is the widget matters. `closest('[class*=select]')`
       * returns the innermost match, and on Ant Design (Dayforce, and every
       * form built on it) that is `.ant-select-selection-search`: the wrapper
       * around the hidden input, which never holds the chosen text. A
       * correctly chosen option then read as a rejected value. So climb
       * outward to the last wrapper that still contains only this one
       * control — the widget's own root — and stop at the first ancestor that
       * has a second field in it, which means the widget has been left.
       */
      const isWidget = (node: Element) =>
        /select|combobox|dropdown|picker/i.test(String(node.className ?? '')) || node.getAttribute('role') === 'combobox';
      let container: Element = el;
      let node = el.parentElement;
      for (let up = 0; up < 4 && node && node.tagName !== 'FORM' && node.tagName !== 'BODY'; up++, node = node.parentElement) {
        if (node.querySelectorAll('input, select, textarea, [role="combobox"]').length > 1) break;
        if (isWidget(node)) container = node;
      }
      // Letters and digits only on both sides: the option "Sydney NSW" satisfies "Sydney, NSW".
      const loose = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const shown = loose(container.textContent ?? '');
      const want = loose(value);
      const held = loose(el.value);
      return held === want || (want.length > 0 && (shown.includes(want) || (held.length > 0 && want.includes(held))));
    }
    if (field.inputType === 'tel' || field.inputType === 'number') {
      /**
       * A phone or number field may show the value its own way. "0481006011"
       * becomes "0481 006 011" in one form and "481-006-011" under a +61
       * country selector in another; both hold what was entered.
       */
      const digits = (text: string) => text.replace(/\D+/g, '');
      const want = digits(value);
      const got = digits(el.value);
      const national = want.replace(/^0+/, '');
      return want.length > 0 && (got === want || got === national || (national.length >= 6 && got.endsWith(national)));
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
