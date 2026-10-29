import type { Frame, Page } from 'patchright';
import type { FormField } from './types.js';

/**
 * Extracts the interactive fields on the current step as a compact list.
 * Raw HTML would be both enormous and mostly noise; this keeps the model's
 * input small and stable, and gives us a `ref` we can act on afterwards.
 */
export async function extractFields(page: Page | Frame): Promise<FormField[]> {
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
     * A caption is text about a field, never the content of another control.
     *
     * Zoho Recruit puts a salutation dropdown ("-None-") right before the
     * First Name box, so "-None-" was read as that box's label, and the
     * answerer was asked to answer a field called "-None-". Text that is, or
     * sits inside, a dropdown, a button, an option list or an input, and text
     * that reads like an unset choice, is the wrong kind of text to name a
     * field by; the search goes on to the next candidate.
     */
    const CONTROL = 'input, select, textarea, button, [role="combobox"], [role="listbox"], [role="option"], [role="button"], [role="radio"], [role="checkbox"], [contenteditable="true"]';
    const isControl = (node: Element | null): boolean =>
      Boolean(node && (node.matches(CONTROL) || node.querySelector(CONTROL) || /dropdown|select|picker|combobox/i.test(node.tagName)));
    const unsetChoice = (text: string): boolean =>
      /^[\s\-–—.*]*(?:none|n\/a|select|choose|please (?:select|choose)|select an option|select one|--)[\s\-–—.*]*$/i.test(text);

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
          if (isControl(sib)) continue;
          const text = (sib as HTMLElement).innerText?.trim().replace(/\s+/g, ' ') ?? '';
          if (text && text.length > 2 && text.length < 200 && !opaqueName(text) && !unsetChoice(text) && !reject(text)) return text;
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
        if (text && text.length < 120 && !inner!.querySelector('input, select, textarea') && !unsetChoice(text)) return text;
        if (depth === 0) {
          const prev = el.previousElementSibling as HTMLElement | null;
          const prevText = prev?.innerText?.trim();
          if (prevText && prevText.length < 120 && !isControl(prev) && !unsetChoice(prevText)) return prevText;
        }
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder && !unsetChoice(placeholder)) return placeholder;

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
          if (candidate.contains(el) || isControl(candidate) || candidate.closest(CONTROL)) continue;
          const text = (candidate as HTMLElement).innerText?.trim().replace(/\s+/g, ' ') ?? '';
          if (!text || text.length < 3 || text.length > 120 || opaqueName(text) || unsetChoice(text)) continue;
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
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
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
      let group: Element | null = el;
      for (let depth = 0; group && depth < 20 && parts.length < 2; depth++) {
        if (group !== el && (group.matches(groupSelector) || group.hasAttribute('aria-label') || group.hasAttribute('aria-labelledby'))) {
          const name = groupName(group);
          if (nameable(name, label) && !parts.includes(name)) parts.unshift(name);
        }
        const root = group.getRootNode();
        const parent: Element | null = group.parentElement;
        group = parent ?? (root instanceof ShadowRoot ? root.host : null);
      }
      let heading = '';
      // compareDocumentPosition on disconnected shadow trees has arbitrary
      // ordering. Compare within each real root, then climb its host.
      let anchor: Element | null = el;
      while (anchor && !heading) {
        const root = anchor.getRootNode();
        for (const candidate of headings) {
          if (candidate.getRootNode() !== root || candidate.contains(anchor)) continue;
          if (candidate.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) heading = squash(candidate);
        }
        anchor = root instanceof ShadowRoot ? root.host : null;
      }
      if (nameable(heading, label) && !parts.includes(heading)) parts.unshift(heading);
      return parts.join(' › ');
    };
    const identityFor = (el: Element): string => {
      const path: string[] = [];
      let nearestId = '';
      let node: Element | null = el;
      for (let depth = 0; node && depth < 20; depth++) {
        const root = node.getRootNode();
        if (!nearestId && node.id) nearestId = node.id.slice(0,80);
        const siblings = node.parentElement?.children ?? (root instanceof ShadowRoot ? root.children : []);
        const ordinal = [...siblings].filter(sibling => sibling.tagName === node!.tagName).indexOf(node);
        path.unshift(`${node.tagName}:${ordinal}${node.id ? '#'+node.id.slice(0,80) : ''}${node.getAttribute('name') ? '[name='+node.getAttribute('name')!.slice(0,80)+']' : ''}`);
        const parent: Element | null = node.parentElement;
        node = parent ?? (root instanceof ShadowRoot ? root.host : null);
      }
      // Keep the opaque key compact: full DOM paths otherwise inflate every
      // saved-form readback and can exhaust its size budget on a large form.
      let hash = 0xcbf29ce484222325n;
      for (const char of path.join('/')) hash = BigInt.asUintN(64,(hash ^ BigInt(char.codePointAt(0)!))*0x100000001b3n);
      return `${nearestId || el.tagName.toLowerCase()}@${hash.toString(16).padStart(16,'0')}`;
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
      // Design systems commonly hide the native radio/checkbox and show its
      // associated label. The label is the user's visible control, so retain
      // that native input for grounded filling when at least one label is
      // actually visible; unrelated hidden fields remain excluded.
      const visibleThroughLabel = /^(radio|checkbox)$/.test(el.type)
        && [...(el.labels ?? [])].some(label => visible(label));
      // Select-style widgets (Ant Design, Dayforce) keep their combobox input
      // zero-width and transparent inside the box a person clicks; the box is
      // the visible control.
      let widget: Element | null = el.parentElement;
      for (let depth = 0; widget && depth < 3; depth++) {
        const style = getComputedStyle(widget);
        // A conditional section with display:none is not a closed widget.
        // Do not climb out of it and mistake the surrounding visible form
        // for the control, making an irrelevant question look fillable.
        if (style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') {
          widget = null;
          break;
        }
        if (visible(widget)) break;
        widget = widget.parentElement;
      }
      const visibleThroughWidget = (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-haspopup'))
        && Boolean(widget && visible(widget));
      if (!visible(el) && !visibleThroughLabel && !visibleThroughWidget) return;
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
      const controlIdentity = identityFor(el);
      const interactionState = {
        ...(el.readOnly || el.getAttribute('aria-readonly') === 'true' ? { readOnly: true } : {}),
        ...(el.disabled || el.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
      };
      /**
       * What the field's own markup calls it (name, id, autocomplete,
       * placeholder): machine words, but the answerer can tell from
       * name="First_Name" what a box is for when its caption reads "-None-"
       * or is missing altogether.
       */
      const hints = ['name', 'id', 'autocomplete', 'placeholder', 'aria-label']
        .map((attribute) => [attribute, el.getAttribute(attribute)?.trim() ?? ''] as const)
        .filter(([, value]) => value && value !== label && value.length <= 80 && !/^[\da-f-]{16,}$/i.test(value))
        .map(([attribute, value]) => `${attribute}=${value}`)
        .join(' ');

      if (el.tagName === 'SELECT') {
        const sel = el as unknown as HTMLSelectElement;
        fields.push({
          ref,
          controlIdentity,
          label,
          ...(description ? { description } : {}),
          ...(section ? { section } : {}),
          kind: 'select',
          ...interactionState,
          ...(hints ? { hints } : {}),
          required: el.required || el.getAttribute('aria-required') === 'true' || Boolean(el.closest('[aria-required="true"]')) || /(^|\s)\*|\*\s*$/.test(label),
          options: [...sel.options].map((o) => o.textContent?.trim() ?? '').filter(Boolean),
          /**
           * What the person sees chosen, not the option's internal value: "No",
           * not "1043". A placeholder ("Please select", or the HTML placeholder
           * option — empty, disabled or hidden) is no answer. Reporting the raw
           * value made PageUp's "Please select" (value "0") look answered, so
           * the agent was told a required declaration was already done.
           */
          currentValue: (() => {
            const chosen = sel.selectedOptions[0];
            if (!chosen || chosen.disabled || chosen.hidden || chosen.value === '') return '';
            const text = chosen.textContent?.trim() ?? '';
            return sel.selectedIndex === 0 && /^[\s\-–—.]*(?:please\s+)?(?:select|choose)\b/i.test(text) ? '' : text;
          })(),
          autocomplete: el.getAttribute('role') === 'combobox',
        });
        return;
      }

      fields.push({
        ref,
        controlIdentity,
        label,
        ...(description ? { description } : {}),
        ...(section ? { section } : {}),
        kind: el.tagName === 'TEXTAREA' ? 'textarea' : el.type === 'checkbox' ? 'checkbox' : 'text',
        ...interactionState,
        ...(hints ? { hints } : {}),
        required: el.required || el.getAttribute('aria-required') === 'true' || Boolean(el.closest('[aria-required="true"]')) || /(^|\s)\*|\*\s*$/.test(label),
        currentValue: el.type === 'checkbox' ? String(el.checked) : el.value,
        autocomplete: el.getAttribute('role') === 'combobox' || Boolean(el.getAttribute('aria-autocomplete') && el.getAttribute('aria-autocomplete') !== 'none')
          || el.hasAttribute('list') || Boolean(el.closest('[role="combobox"], [role="listbox"]')),
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
