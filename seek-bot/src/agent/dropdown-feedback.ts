import type { Locator } from 'patchright';
import { browserDelay, browserOperationOptions } from '../browser-deadline.js';
import { readComboboxStates } from '../combobox-state.js';

/** Read only. Lives in the target's frame and follows its ARIA menu, including
 * open shadow roots. It never reads choices from another open dropdown. */
function readDropdown(node: Element) {
  if (node.hasAttribute('data-owtomate-private-auth') || (node as HTMLInputElement).type === 'password') return null;
  const ids = (node.getAttribute('aria-controls') || node.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
  if (node.getAttribute('role') !== 'combobox') return null;
  const visible = (element: Element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && element.getBoundingClientRect().width > 0;
  const roots: (Document | ShadowRoot)[] = [];
  for (let root = node.getRootNode() as Document | ShadowRoot; root;) {
    roots.push(root);
    if (!(root instanceof ShadowRoot)) break;
    root = root.host.getRootNode() as Document | ShadowRoot;
  }
  const deep = (element: Element): Element[] => [element, ...[...element.children].flatMap(deep), ...(element.shadowRoot ? [...element.shadowRoot.children].flatMap(deep) : [])];
  const menus = ids.flatMap(id => {
    for (const root of roots) {
      const found = root.getElementById(id);
      if (found) return [found];
    }
    return [];
  }).filter(visible);
  const text = (element: Element): string => {
    if (element instanceof HTMLSlotElement) return element.assignedNodes({ flatten: true }).map(node => node instanceof Element ? text(node) : node.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
    if (element.shadowRoot) return [...element.shadowRoot.children].map(text).join(' ').replace(/\s+/g, ' ').trim();
    return ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const nodes = [...new Set(menus.flatMap(deep))];
  const options = nodes.filter(element => element.getAttribute('role') === 'option' && visible(element))
    .map(element => ({ label: element.getAttribute('aria-label') || text(element), disabled: element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled') })).filter(option => option.label);
  const statusText = menus.map(text).join('\n').slice(0, 1200);
  const loading = nodes.some(element => element.getAttribute('aria-busy') === 'true' || element.getAttribute('role') === 'progressbar') || node.getAttribute('aria-busy') === 'true';
  const status = loading ? 'loading' : options.length ? 'options'
    : /no (?:results|matches|options|suggestions)(?: found)?|nothing found/i.test(statusText) ? 'no-results'
    : /failed to load|unable to load|something went wrong|try again/i.test(statusText) ? 'error' : 'empty';
  return { status, menuIds: ids, options: options.slice(0, 40), truncated: options.length > 40, statusText,
    value: (node as HTMLInputElement).value || '', invalid: node.getAttribute('aria-invalid'), expanded: node.getAttribute('aria-expanded') };
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
/** Typing is not selection. Wait for evidence, and transport only a unique,
 * exact match to the answer already chosen by the agent. No fuzzy fallback. */
export async function dropdownFeedback(target: Locator, requested: string, timeoutMs = 3000) {
  return collectDropdownFeedback(target, requested, timeoutMs);
}

async function collectDropdownFeedback(target: Locator, requested: string, timeoutMs: number) {
  let state = await target.evaluate(readDropdown, undefined, browserOperationOptions());
  if (!state) return undefined;
  const deadline = Date.now() + timeoutMs;
  while (['empty', 'loading'].includes(state.status) && Date.now() < deadline) {
    await browserDelay(Math.min(100, Math.max(1, deadline - Date.now())));
    state = await target.evaluate(readDropdown, undefined, browserOperationOptions());
    if (!state) return { status: 'changed', selected: false, note: 'The field changed while suggestions were loading. Inspect its fresh state.' };
  }
  const matches = state.options.filter(option => !option.disabled && normalize(option.label) === normalize(requested));
  if (state.status !== 'options' || matches.length !== 1 || state.truncated) return {
    ...state, selected: false, match: matches.length > 1 ? 'ambiguous' : matches.length === 1 ? 'exact' : 'none',
    note: 'Selection is not confirmed. Inspect these current choices. If there is no match, use an evidence-supported full name or spelling; never choose an unrelated option or repeat the unchanged search. Free text is acceptable only when the form accepts it. Use Other only when offered and truthful. Otherwise report the unresolved field.'
  };
  const handle = await target.elementHandle(browserOperationOptions());
  const frame = await handle?.ownerFrame();
  await handle?.dispose();
  if (!frame || !state.menuIds.length) return { ...state, selected: false, note: 'No current scoped menu target. Inspect the fresh field.' };
  const menu = frame.locator(state.menuIds.map(id => `[id=${JSON.stringify(id)}]`).join(','));
  const option = menu.getByRole('option', { name: matches[0].label, exact: true });
  // Strictness is intentional: duplicate or rerendered choices need fresh AI
  // inspection, not a guessed first() or force-click.
  try {
    await option.click(browserOperationOptions(2500));
  } catch {
    return { ...state, selected: false, status: 'selection-unconfirmed', note: 'The matching option click did not complete. Inspect fresh dropdown evidence and change target or approach; do not replay typing or assume the click had no effect.' };
  }
  const after = await target.evaluate(readDropdown, undefined, browserOperationOptions());
  const committed = (await target.evaluate(readComboboxStates, undefined, browserOperationOptions()))[0];
  const selected = Boolean(after && after.expanded !== 'true' && after.options.length === 0 && after.invalid !== 'true'
    && (committed ? normalize(committed.committedValue) === normalize(matches[0].label)
      : normalize(after.value) === normalize(matches[0].label) || await target.getAttribute('aria-valuetext') === matches[0].label));
  return { ...after, selected, clickedOption: matches[0].label,
    status: selected ? 'selected' : 'selection-unconfirmed',
    note: selected ? 'The exact matching option was clicked; the dropdown closed and the field readback is valid. Recheck validation when advancing.'
      : 'The option was clicked, but acceptance is not confirmed. Inspect the saved value and validation before continuing or repeating anything.' };
}
