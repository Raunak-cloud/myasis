import type { Locator, Page } from 'patchright';

/** Inspect the control's own form, rather than guessing its purpose from a
 * word such as "Submit". Never read field values: login credentials belong
 * only to the authentication tools. This also works inside employer frames. */
export async function submissionControl(page: Page, target?: Locator, key?: string): Promise<{ label: string; context: string }> {
  if (!target) {
    let frame = page.mainFrame();
    for (;;) {
      // An iframe can be document.activeElement without matching :focus.
      // Read actual focus, including shadow roots, just as keyboard.press does.
      const focused = await frame.evaluateHandle(() => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return active;
      });
      const child = await focused.asElement()?.contentFrame();
      await focused.dispose();
      if (!child) break;
      frame = child;
    }
    target = frame.locator('body');
  }
  return target.evaluate((observed, key) => {
    let node = (key && observed === document.body ? document.activeElement : observed) ?? observed;
    while (key && node.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
    const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const label = (element: Element) => compact(element.getAttribute('aria-label')
      || [...((element as HTMLInputElement).labels ?? [])].map(item => item.textContent).join(' ')
      || (element as HTMLElement).innerText || element.getAttribute('placeholder') || element.getAttribute('name'));
    const form = (node as HTMLInputElement).form ?? node.closest('form, [role="form"]');
    const region = form ?? node.closest('[role="dialog"], section, main') ?? document.body;
    const headingRegion = node.closest('[role="dialog"], section, main') ?? region;
    const visible = (element: Element) => !element.closest('[hidden], [aria-hidden="true"]') && element.getClientRects().length > 0;
    const describe = (element: Element) => ({
      tag: element.tagName, type: element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.type : element.getAttribute('type'), role: element.getAttribute('role'),
      label: label(element), autocomplete: element.getAttribute('autocomplete'), visible: visible(element),
    });
    const implicitSubmit = ['Enter', 'NumpadEnter', 'Return'].includes(key?.split('+').at(-1) ?? '') && node instanceof HTMLInputElement
      && ['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'month', 'week', 'time', 'datetime-local'].includes(node.type)
      && form instanceof HTMLFormElement;
    const submitter = implicitSubmit ? [...form.elements].find(element =>
      (element instanceof HTMLButtonElement && element.type === 'submit'
        || element instanceof HTMLInputElement && ['submit', 'image'].includes(element.type)) && !(element as HTMLButtonElement).disabled) : undefined;
    return {
      label: submitter ? label(submitter) : label(node),
      context: JSON.stringify({
        key, target: describe(node), href: node.closest('a')?.getAttribute('href'),
        implicitFormSubmit: implicitSubmit, implicitSubmitter: submitter ? describe(submitter) : undefined,
        expanded: node.getAttribute('aria-expanded'), popup: node.getAttribute('aria-haspopup'),
        activeOption: node.getAttribute('aria-activedescendant') ? label(document.getElementById(node.getAttribute('aria-activedescendant')!) ?? node) : undefined,
        formAction: form?.getAttribute('action'), regionRole: region.getAttribute('role'), regionLabel: region.getAttribute('aria-label'),
        headings: [...headingRegion.querySelectorAll('h1,h2,h3,[role="heading"]')].slice(0, 10).map(label),
        fields: [...region.querySelectorAll('input:not([type="hidden"]),textarea,select,[role="combobox"]')].filter(visible).slice(0, 25).map(describe),
        controls: [...region.querySelectorAll('button,input[type="submit"],[role="button"]')].slice(0, 16).map(describe),
      }),
    };
  }, key, { timeout: 2500 });
}

/** These keys edit or move through controls without activating a form. Other
 * keys (including Enter/Space and shortcuts) get the same review as a click. */
export function needsSubmissionReview(key: string): boolean {
  return !['Tab', 'Shift+Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageDown', 'PageUp',
    'Backspace', 'Delete', 'Control+A', 'Meta+A', 'ControlOrMeta+A'].includes(key);
}
