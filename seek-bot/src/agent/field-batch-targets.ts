import { randomUUID } from 'node:crypto';
import type { Locator, Page } from 'patchright';
import type { BatchTargetState } from './field-feedback.js';

const ANCHOR = 'data-owtomate-batch';
export type TargetWrite = { ref: string; value: string };

/** Attempt-local target identities and scoped mutation notifications. No answers,
 * recovery policy, cross-frame scans or long-lived remote ElementHandles. */
export class FieldBatchTargets {
  private constructor(readonly page: Page, readonly key: string, readonly optionIndices: Array<number | null>) {}

  static async prepare(page: Page, writes: readonly TargetWrite[]): Promise<FieldBatchTargets | string> {
    const key = `__owtomateBatch_${randomUUID().replace(/-/g, '')}`;
    const prepared = await page.evaluate(({ key, writes, anchor }) => {
      const roots: Array<Document | ShadowRoot> = [document];
      const elements: Element[] = [];
      for (let i = 0; i < roots.length; i++) for (const element of roots[i].querySelectorAll('*')) {
        elements.push(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
      const nodes: Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = [];
      const optionIndices: Array<number | null> = [];
      for (const write of writes) {
        const matches = elements.filter(element => element.getAttribute('data-field-id') === write.ref);
        if (matches.length !== 1) return { error: 'A FIELD target is missing or ambiguous. No fields were written.' };
        const node = matches[0];
        if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) return { error: 'Use browser_action for non-native controls. No fields were written.' };
        if (node.disabled || node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true' || 'readOnly' in node && node.readOnly) return { error: 'A FIELD target is disabled or read-only. No fields were written.' };
        if (node.closest('[role=combobox], [role=listbox]') || node.getAttribute('role') === 'combobox'
          || node.getAttribute('aria-autocomplete') && node.getAttribute('aria-autocomplete') !== 'none' || node.hasAttribute('list')) return { error: 'Use browser_action for autocomplete/custom widgets. No fields were written.' };
        let optionIndex: number | null = null;
        if (node instanceof HTMLSelectElement) {
          if (node.multiple) return { error: 'Use browser_action for multi-select controls. No fields were written.' };
          const matches = [...node.options].map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled && !option.parentElement?.matches('optgroup:disabled') && (option.label === write.value || option.value === write.value));
          if (matches.length !== 1) return { error: 'A requested option is missing or ambiguous. Use browser_action. No fields were written.' };
          optionIndex = matches[0].index;
        } else if (node instanceof HTMLInputElement && (node.type === 'checkbox' ? !['true', 'false'].includes(write.value)
          : !['text', 'email', 'tel', 'url', 'number', 'date', 'month', 'week', 'time', 'datetime-local'].includes(node.type))) return { error: 'Use browser_action for this input type. No fields were written.' };
        nodes.push(node); optionIndices.push(optionIndex);
      }
      // Metadata extraction does not expose every native constraint (for example
      // option values/disabled groups). Track these directly on the original nodes.
      const signature = (node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => JSON.stringify({
        type: node.type, disabled: node.disabled || node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true',
        readOnly: 'readOnly' in node && node.readOnly, role: node.getAttribute('role'),
        autocomplete: node.getAttribute('aria-autocomplete'), list: node.getAttribute('list'), custom: Boolean(node.closest('[role=combobox], [role=listbox]')),
        options: node instanceof HTMLSelectElement ? [...node.options].map(option => [option.value, option.label, option.disabled, option.parentElement?.matches('optgroup:disabled')]) : undefined,
      });
      const signatures = nodes.map(signature);
      const scopeFor = (node: Element) => node.closest('form, main, [role=main]') ?? node.getRootNode();
      const nodeScopes = nodes.map(scopeFor);
      const scopes = [...new Set(nodeScopes)];
      const references = new Set<Node>();
      const refreshReferences = () => {
        // Retain removed references until disposal so their removal is detected.
        for (const node of nodes) {
          for (const label of node.labels ?? []) references.add(label);
          const root = node.getRootNode() as Document | ShadowRoot;
          for (const id of `${node.getAttribute('aria-labelledby') ?? ''} ${node.getAttribute('aria-describedby') ?? ''}`.split(/\s+/).filter(Boolean)) {
            const reference = root.getElementById(id) ?? document.getElementById(id);
            if (reference) references.add(reference);
          }
        }
      };
      refreshReferences();
      const contains = (container: Node, target: Node): boolean => {
        let cursor: Node | null = target;
        while (cursor) {
          if (container === cursor || container.contains(cursor)) return true;
          const root = cursor.getRootNode(); cursor = root instanceof ShadowRoot ? root.host : null;
        }
        return false;
      };
      const within = (target: Node) => scopes.some(scope => contains(scope, target)) || [...references].some(reference => contains(reference, target));
      let revision = 0, dirty = false, stale = false;
      const address = location.href;
      const hosts = elements.filter(element => within(element));
      const anchoredRoots = () => {
        const found: Array<Document | ShadowRoot> = [document];
        for (let i = 0; i < found.length; i++) for (const element of found[i].querySelectorAll('*')) if (element.shadowRoot) found.push(element.shadowRoot);
        return found;
      };
      const revoke = () => {
        for (const root of anchoredRoots()) for (const element of root.querySelectorAll(`[${anchor}^="${key}:"]`)) element.removeAttribute(anchor);
      };
      const relevant = (mutation: MutationRecord): boolean => {
        if (mutation.type === 'attributes') {
          const attribute = mutation.attributeName ?? '';
          if ([anchor, 'data-field-id', 'data-ref-id', 'aria-invalid', 'aria-errormessage'].includes(attribute)) return false;
          if (mutation.target instanceof HTMLInputElement && ['value', 'checked'].includes(attribute) || mutation.target instanceof HTMLOptionElement && attribute === 'selected') return false;
          return within(mutation.target) || scopes.some(scope => contains(mutation.target, scope));
        }
        return within(mutation.target) || mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes]
          .some(changed => scopes.some(scope => contains(changed, scope)) || [...references].some(reference => contains(changed, reference)));
      };
      const changed = (records: MutationRecord[]) => {
        if (!records.length) return;
        refreshReferences();
        if (!records.some(relevant)) return;
        revision++;
        if (!dirty) { dirty = true; revoke(); }
      };
      const observer = new MutationObserver(changed);
      for (const root of roots) observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
      const state = {
        nodes,
        check: (): BatchTargetState => {
          changed(observer.takeRecords());
          if (location.href !== address || nodes.some((node, index) => !node.isConnected || scopeFor(node) !== nodeScopes[index] || signature(node) !== signatures[index])) stale = true;
          if (!dirty && hosts.some(host => host.shadowRoot && !roots.includes(host.shadowRoot))) { revision++; dirty = true; revoke(); }
          if (stale) { revoke(); return { status: 'stale', revision, reason: 'A batch target or native constraint changed, or the page navigated.' }; }
          return { status: dirty ? 'changed' : 'ready', revision };
        },
        renew: (expected: number): BatchTargetState => {
          const current = state.check();
          if (current.status === 'stale' || expected !== revision) return current;
          dirty = false;
          for (const root of anchoredRoots()) if (!roots.includes(root)) { roots.push(root); observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true }); }
          nodes.forEach((node, index) => node.setAttribute(anchor, `${key}:${index}`));
          return state.check();
        },
        dispose: () => { observer.disconnect(); revoke(); delete (globalThis as unknown as Record<string, unknown>)[key]; },
      };
      nodes.forEach((node, index) => node.setAttribute(anchor, `${key}:${index}`));
      Object.defineProperty(globalThis, key, { value: state, configurable: true });
      return { optionIndices };
    }, { key, writes: [...writes], anchor: ANCHOR });
    if (prepared.error) return prepared.error;
    return new FieldBatchTargets(page, key, prepared.optionIndices!);
  }

  locator(index: number): Locator { return this.page.locator(`[${ANCHOR}="${this.key}:${index}"]`); }
  async check(): Promise<BatchTargetState> {
    return this.page.evaluate(key => {
      const state = (globalThis as unknown as Record<string, { check(): BatchTargetState }>)[key];
      return state?.check() ?? { status: 'stale', revision: -1, reason: 'The batch document is no longer available.' };
    }, this.key);
  }
  async renew(revision: number): Promise<BatchTargetState> {
    return this.page.evaluate(({ key, revision }) => {
      const state = (globalThis as unknown as Record<string, { renew(revision: number): BatchTargetState }>)[key];
      return state?.renew(revision) ?? { status: 'stale', revision: -1 };
    }, { key: this.key, revision });
  }
  async dispose(): Promise<void> {
    await this.page.evaluate(key => (globalThis as unknown as Record<string, { dispose(): void }>)[key]?.dispose(), this.key).catch(() => {});
  }
}
