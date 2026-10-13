import type { ElementHandle } from 'patchright';

/** DOM evidence, including widgets whose visible options have no accessibility role. */
export async function inspectInteractionElement(handle: ElementHandle, prefix: string, contains = ''): Promise<unknown> {
  return handle.evaluate((anchor, args) => {
    if (!(anchor instanceof Element) || !anchor.isConnected) return { unavailable: true };
    const document = anchor.ownerDocument;
    const visible = (node: Element) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const sensitive = (node: Element) => node.matches('input[type="password"],input[type="hidden"]')
      || /password|one-time-code/i.test(node.getAttribute('autocomplete') ?? '');
    if (sensitive(anchor)) return { credentials: true };
    const roots: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const node of roots[i].querySelectorAll('*')) {
        node.removeAttribute('data-owt-recovery-ref');
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
    const editable = (node: Element) => node.matches('input:not([type="hidden"]):not([type="file"]),select,textarea,[contenteditable="true"],[role="combobox"]')
      && !sensitive(node) && visible(node)
      && !(node.getAttribute('role') === 'combobox' && node.querySelector('input,select,textarea'));
    // Stay in the affected widget: crossing into another input would mix owners.
    let region = anchor;
    for (let row = anchor.parentElement, depth = 0; row && depth < 6; row = row.parentElement, depth++) {
      if ([...row.querySelectorAll('*')].filter(editable).length > 1) break;
      region = row;
      if (row.matches('fieldset,[role="group"],form,main,body')) break;
    }
    const regions = new Set<Element | ShadowRoot>([region]);
    const owningRoot = anchor.getRootNode();
    if (region === anchor && !anchor.parentElement && owningRoot instanceof ShadowRoot
      && [...owningRoot.querySelectorAll('*')].filter(editable).length <= 1) regions.add(owningRoot);
    const owners = [anchor, ...region.querySelectorAll('[aria-controls],[aria-owns]')];
    for (const owner of owners) {
      const root = owner.getRootNode() as Document | ShadowRoot;
      for (const id of `${owner.getAttribute('aria-controls') ?? ''} ${owner.getAttribute('aria-owns') ?? ''}`.split(/\s+/).filter(Boolean)) {
        const popup = root.querySelector(`#${CSS.escape(id)}`);
        if (popup && visible(popup)) regions.add(popup);
      }
    }
    const nodes = new Set<Element>([anchor]);
    const walk = (root: Element | ShadowRoot) => {
      if (root instanceof Element) nodes.add(root);
      for (const node of root.querySelectorAll('*')) {
        nodes.add(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    for (const root of regions) walk(root);
    let index = 0;
    const visibleText = (node: Element) => (node instanceof HTMLElement ? node.innerText : '')
      .replace(/\s+/g, ' ').trim();
    const describe = (node: Element) => {
      const ref = `${args.prefix}e${index++}`;
      node.setAttribute('data-owt-recovery-ref', ref);
      const attributes: Record<string, string> = {};
      for (const name of ['id','name','class','type','role','aria-label','aria-expanded','aria-controls','aria-owns','aria-selected','aria-checked','aria-invalid','aria-required','aria-activedescendant','tabindex']) {
        const value = node.getAttribute(name);
        if (value !== null) attributes[name] = value.slice(0, 250);
      }
      const input = node as HTMLInputElement;
      return { ref, tag: node.tagName.toLowerCase(), attributes,
        text: visibleText(node).slice(0, 350),
        ...(typeof input.value === 'string' && input.type !== 'file' ? { value: input.value.slice(0, 200) } : {}),
        disabled: input.disabled === true || node.getAttribute('aria-disabled') === 'true',
        ...('validationMessage' in input ? { validation: input.validationMessage.slice(0, 300) } : {}) };
    };
    const target = describe(anchor);
    const elements = [];
    let characters = JSON.stringify(target).length;
    for (const node of nodes) {
      if (node === anchor || sensitive(node) || !visible(node) || node.matches('script,style')) continue;
      // Leaf text and list items matter even when a vendor omitted role=option.
      if (node.children.length && !node.matches('input,select,textarea,button,a,li,option,label,[role],[aria-expanded]')) continue;
      const text = visibleText(node);
      if (args.contains && !text.toLowerCase().includes(args.contains.toLowerCase()) && !editable(node)) continue;
      if (elements.length >= 70) break;
      const item = describe(node);
      const size = JSON.stringify(item).length;
      if (characters + size > 12000) break;
      characters += size;
      elements.push(item);
    }
    return { target, elements, truncated: elements.length >= 70 || characters > 11000,
      activeElement: document.activeElement?.getAttribute('data-owt-recovery-ref') ?? null };
  }, { prefix, contains: contains.slice(0, 200) });
}
