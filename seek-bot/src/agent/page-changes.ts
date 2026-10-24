import type { Page } from 'patchright';

/**
 * What an action actually did to the page, recorded as it happened.
 *
 * The agent used to be told "Nothing visible changed" by a check that compared
 * only the form region's text and a few control attributes. It missed a radio
 * that showed its selection as a class (LiveHire), a dialog opened outside the
 * form (LiveHire's cover letter), and a toast or error beside a Workday button,
 * and the agent, believing it, abandoned actions that had worked. Now every
 * action is watched from the inside: each element that appears, disappears or
 * changes state anywhere in the document (and in same-origin frames), and each
 * value typed. The agent gets the list, not a verdict, and judges it.
 */
export interface PageChanges {
  /** The tab moved to another address; the document was replaced. */
  navigated: boolean;
  /** Visible elements that appeared, by what they say (dialogs, alerts and errors first). */
  appeared: string[];
  /** Elements that went away, by what they said. */
  disappeared: string[];
  /** Controls whose state changed: selected, expanded, checked, invalid, disabled, value. */
  controls: string[];
  /** Text that changed in place. */
  text: string[];
  /** Actual committed properties, independent of whether a widget dispatched input/change. */
  values?: Array<{ ref: string | null; name: string; value: string; frame: number }>;
}

export const changedAnything = (changes: PageChanges): boolean =>
  changes.navigated || Boolean(changes.appeared.length || changes.disappeared.length || changes.controls.length || changes.text.length || changes.values?.length);

/** Installed in a document; kept tiny and dependency-free because it runs in the page. */
function install(): void {
  type Store = { added: Element[]; removed: string[]; controls: string[]; text: string[]; observer?: MutationObserver; onInput?: (event: Event) => void;
    values: Map<Element, string>; inputs: () => Element[]; readValue: (node: Element) => string | null };
  const w = window as unknown as { __owtChanges?: Store };
  if (w.__owtChanges?.observer) w.__owtChanges.observer.disconnect();
  if (w.__owtChanges?.onInput) document.removeEventListener('input', w.__owtChanges.onInput, true);
  const inputs = (): Element[] => {
    const roots: Array<Document | ShadowRoot> = [document];
    const found: Element[] = [];
    for (let i = 0; i < roots.length; i++) {
      for (const node of roots[i].querySelectorAll('*')) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
        if (node.matches('input,select,textarea,[contenteditable="true"],[role="checkbox"],[role="radio"]')) found.push(node);
      }
    }
    return found;
  };
  const readValue = (node: Element): string | null => {
    if (node.matches('input[type="password"],input[type="hidden"],input[type="file"]')
      || /password|one-time-code/i.test([node.getAttribute('autocomplete'), node.getAttribute('name'), node.id].join(' '))) return null;
    if (!node.getBoundingClientRect().width || getComputedStyle(node).visibility === 'hidden') return null;
    if (node.matches('input[type="checkbox"],input[type="radio"]')) return String((node as HTMLInputElement).checked);
    if (node.matches('[role="checkbox"],[role="radio"]')) return node.getAttribute('aria-checked');
    if (node instanceof HTMLSelectElement && node.multiple) return JSON.stringify([...node.selectedOptions].map(option => option.value));
    if ('value' in node && typeof node.value === 'string') return node.value;
    return (node as HTMLElement).innerText ?? null;
  };
  const values = new Map<Element, string>();
  for (const node of inputs()) { const value = readValue(node); if (value !== null) values.set(node, value); }
  const store: Store = { added: [], removed: [], controls: [], text: [], values, inputs, readValue };
  w.__owtChanges = store;
  const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const name = (element: Element) => compact(
    element.getAttribute('aria-label') || (element as HTMLElement).innerText || element.getAttribute('title')
      || element.getAttribute('name') || element.getAttribute('placeholder') || element.id || element.tagName.toLowerCase(),
  ).slice(0, 80);
  const STATE = new Set(['class', 'aria-checked', 'aria-selected', 'aria-expanded', 'aria-pressed', 'aria-invalid', 'aria-disabled', 'aria-hidden', 'checked', 'disabled', 'value', 'open', 'hidden']);
  const SKIP = 'script, style, link, meta, noscript, template';
  const push = (list: string[], entry: string) => { if (entry && list.length < 60 && !list.includes(entry)) list.push(entry); };
  store.observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') {
        record.addedNodes.forEach((node) => {
          if (node instanceof Element && !node.matches(SKIP) && store.added.length < 200) store.added.push(node);
        });
        record.removedNodes.forEach((node) => {
          if (node instanceof Element && !node.matches(SKIP)) push(store.removed, compact(node.textContent).slice(0, 100));
        });
      } else if (record.type === 'attributes' && record.target instanceof Element) {
        const attribute = record.attributeName ?? '';
        if (!STATE.has(attribute) || attribute.startsWith('data-')) continue;
        const element = record.target;
        const now = element.getAttribute(attribute);
        if (now === record.oldValue) continue;
        let change = `${attribute}: ${record.oldValue ?? '∅'} → ${now ?? '∅'}`;
        if (attribute === 'class') {
          const before = new Set((record.oldValue ?? '').split(/\s+/).filter(Boolean));
          const after = new Set((now ?? '').split(/\s+/).filter(Boolean));
          const gained = [...after].filter((c) => !before.has(c));
          const lost = [...before].filter((c) => !after.has(c));
          // Class churn without a state word is animation, not an answer.
          if (![...gained, ...lost].some((c) => /active|selected|checked|highlight|open|show|visible|hidden|error|invalid|disabled|focus|expanded|success|done|complete/i.test(c))) continue;
          change = `class ${gained.length ? `+${gained.join(' +')}` : ''}${lost.length ? ` -${lost.join(' -')}` : ''}`.trim();
        }
        push(store.controls, `"${name(element)}" ${change}`);
      } else if (record.type === 'characterData') {
        const parent = record.target.parentElement;
        if (parent && !parent.closest(SKIP)) push(store.text, compact(parent.textContent).slice(0, 100));
      }
    }
  });
  store.observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
  store.onInput = (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target || !(target instanceof Element)) return;
    const shown = target.type === 'password' ? '(hidden)' : compact(String(target.value ?? (target as HTMLElement).innerText ?? '')).slice(0, 60);
    push(store.controls, `"${name(target)}" now holds ${shown ? `"${shown}"` : 'nothing'}`);
  };
  document.addEventListener('input', store.onInput, true);
  document.addEventListener('change', store.onInput, true);
}

/** Read back what the recorder in this document saw; visible additions only, most telling first. */
function collect(): Omit<PageChanges, 'navigated'> | null {
  const store = (window as unknown as { __owtChanges?: { added: Element[]; removed: string[]; controls: string[]; text: string[]; observer?: MutationObserver;
    values: Map<Element, string>; inputs: () => Element[]; readValue: (node: Element) => string | null } }).__owtChanges;
  if (!store) return null;
  store.observer?.disconnect();
  const compact = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (element: Element) => {
    if (!element.isConnected) return false;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const telling = (element: Element) =>
    element.matches('[role=dialog], [role=alertdialog], [role=alert], [role=status], [aria-live], dialog, [aria-modal=true]')
    || /error|invalid|toast|alert|modal|dialog|notification|snackbar|success|warning/i.test(String(element.className));
  // An element whose ancestor was also added is reported through that ancestor.
  const roots = store.added.filter((element) => !store.added.some((other) => other !== element && other.contains(element)));
  const shown = roots.filter(visible).map((element) => ({ element, text: compact((element as HTMLElement).innerText).slice(0, 160) }))
    .filter((item) => item.text);
  shown.sort((a, b) => Number(telling(b.element)) - Number(telling(a.element)));
  const appeared = [...new Set(shown.map((item) => (telling(item.element) ? `[${item.element.getAttribute('role') ?? 'notice'}] ` : '') + item.text))].slice(0, 12);
  const values: NonNullable<PageChanges['values']> = [];
  for (const node of store.inputs()) {
    const value = store.readValue(node);
    if (value === null || value === store.values.get(node) || (!store.values.has(node) && !value)) continue;
    const name = compact(node.getAttribute('aria-label') || node.getAttribute('name') || node.id || node.tagName).slice(0, 120);
    values.push({ ref: node.getAttribute('data-field-id'), name, value: value.slice(0, 1000), frame: 0 });
  }
  return {
    appeared,
    disappeared: store.removed.filter(Boolean).slice(0, 8),
    controls: store.controls.slice(0, 15),
    text: store.text.filter((entry) => entry && !appeared.some((shownText) => shownText.includes(entry))).slice(0, 8),
    values,
  };
}

/** Starts recording in the tab's documents; returns the address it started from. */
export async function startRecording(page: Page): Promise<string> {
  await Promise.all(page.frames().map((frame) => frame.evaluate(install).catch(() => {})));
  return page.url();
}

/** What changed since `startRecording`, after giving the page a moment to show the result. */
export async function readChanges(page: Page, startedAt: string): Promise<PageChanges> {
  await page.waitForTimeout(400).catch(() => {});
  const empty: PageChanges = { navigated: false, appeared: [], disappeared: [], controls: [], text: [] };
  if (page.isClosed()) return { ...empty, navigated: true };
  const parts = await Promise.all(page.frames().map((frame) => frame.evaluate(collect).catch(() => null)));
  const mainRecorded = parts[0] !== null;
  const merged = parts.reduce<PageChanges>((all, part, frame) => part ? {
    navigated: false,
    appeared: [...all.appeared, ...part.appeared],
    disappeared: [...all.disappeared, ...part.disappeared],
    controls: [...all.controls, ...part.controls],
    text: [...all.text, ...part.text],
    values: [...(all.values ?? []), ...(part.values ?? []).map(value => ({ ...value, frame }))],
  } : all, empty);
  // A document without the recorder is a new one: the action navigated, even when the address did not change.
  merged.navigated = page.url() !== startedAt || !mainRecorded;
  return merged;
}
