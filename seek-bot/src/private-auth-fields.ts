import type { Frame, Page } from 'patchright';
import { assertBrowserOperationActive, browserCleanup, browserDeadline, browserOperationExpiresAt } from './browser-deadline.js';

export type PrivateAuthKind = 'password' | 'verification-code';
type Scope = Page | Frame;
const knownValues = new WeakMap<object, Set<string>>();

/** Browser-only transport metadata. Generic Code, postcode, DOB, clearance and
 * security-policy questions are not authentication signals. The private email
 * tool explicitly marks its selected targets even when their labels are bare. */
export function scanPrivateAuthenticationFields(targets?: Element | Element[]) {
  const nodes: Element[] = [];
  if (targets) nodes.push(...(Array.isArray(targets) ? targets : [targets]));
  else {
    const roots: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) {
      if (node.shadowRoot) roots.push(node.shadowRoot);
      if (node.matches('input,textarea')) nodes.push(node);
    }
  }
  const fields: Array<{ index: number; ref: string; kind: PrivateAuthKind; value: string }> = [];
  for (const [index, node] of nodes.entries()) {
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) continue;
    const root = node.getRootNode() as Document | ShadowRoot;
    const labelled = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => root.getElementById(id)?.textContent || '').join(' ');
    const label = ([...(node.labels || [])].map(item => item.textContent || '').join(' ') || node.getAttribute('aria-label') || labelled || node.getAttribute('placeholder') || '')
      .replace(/\s+/g, ' ').replace(/[\s:*]+$/, '').trim();
    const autocomplete = (node.autocomplete || '').toLowerCase().split(/\s+/);
    const name = (node.name || '').toLowerCase().replace(/[-_\s]/g, '');
    const marked = node.getAttribute('data-owtomate-private-auth');
    const password = node instanceof HTMLInputElement && node.type === 'password' || autocomplete.some(token => token === 'current-password' || token === 'new-password')
      || ['password', 'currentpassword', 'newpassword', 'confirmpassword', 'repeatpassword', 'passphrase'].includes(name) || /\bpass(word|phrase)\b/i.test(label);
    const code = autocomplete.includes('one-time-code')
      || ['otp', 'onetimecode', 'onetimepassword', 'verificationcode', 'authenticationcode', 'signincode', 'logincode'].includes(name)
      || /^(?:(?:your|enter|enter your)\s+)?(?:(?:email|emailed|verification|authentication|sign[ -]?in|log[ -]?in|one[ -]?time)\s+(?:verification\s+)?(?:code|pass[ -]?code|pin)|one[ -]?time\s+password|otp|pass[ -]?code)$/i.test(label);
    const kind: PrivateAuthKind | undefined = marked === 'verification-code' || code ? 'verification-code' : password || marked === 'password' ? 'password' : undefined;
    if (!kind) continue;
    node.setAttribute('data-owtomate-private-auth', kind);
    fields.push({ index, ref: node.getAttribute('data-field-id') || '', kind, value: node.value });
  }
  return fields;
}

export function rememberPrivateAuthenticationValue(scope: object, value: string): void {
  if (!value) return;
  let values = knownValues.get(scope);
  if (!values) knownValues.set(scope, values = new Set());
  values.add(value);
}

export async function preparePrivateAuthenticationFields(scope: Scope): Promise<void> {
  const fields = await browserDeadline('Private authentication inspection', 2500, () => scope.evaluate(scanPrivateAuthenticationFields, undefined));
  for (const field of fields) rememberPrivateAuthenticationValue(scope, field.value);
}

export async function privateAuthenticationValues(page: Page): Promise<string[]> {
  const values = new Set(knownValues.get(page) || []);
  for (const frame of page.frames()) {
    await preparePrivateAuthenticationFields(frame);
    for (const value of knownValues.get(frame) || []) values.add(value);
  }
  return [...values];
}

export function redactPrivateAuthenticationText(text: string, values: string[]): string {
  for (const value of values.filter(value => value.length >= 4).sort((a, b) => b.length - a.length)) {
    const html = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    for (const representation of new Set([value, JSON.stringify(value).slice(1, -1), html])) text = text.replaceAll(representation, '[private credential]');
  }
  return text;
}

export function redactPrivateAuthenticationData<T>(value: T, values: string[]): T {
  if (typeof value === 'string') return redactPrivateAuthenticationText(value, values) as T;
  if (Array.isArray(value)) return value.map(item => redactPrivateAuthenticationData(item, values)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPrivateAuthenticationData(item, values)])) as T;
  return value;
}

/** Opaque temporary masks preserve the native values, focus and event state.
 * Every frame must be inspected/masked before capture; otherwise no image is
 * returned. Styles conceal text/carets if the viewport scrolls mid-capture,
 * while preserving focusability and all actual input values. */
export async function withPrivateAuthenticationMasks<T>(page: Page, work: () => Promise<T>): Promise<T> {
  const token = `private-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const prepared: Frame[] = [];
  try {
    const privateValues = (await privateAuthenticationValues(page)).filter(value => value.length >= 4);
    for (const frame of page.frames()) {
      assertBrowserOperationActive();
      await preparePrivateAuthenticationFields(frame);
      prepared.push(frame);
      await frame.evaluate(({ key, expiresAt, values }) => {
        if (Date.now() >= expiresAt) throw new Error('Private screenshot masking expired.');
        const roots: Array<Document | ShadowRoot> = [document];
        const boxes: DOMRect[] = [];
        for (let i = 0; i < roots.length; i++) {
          for (const node of roots[i].querySelectorAll('*')) {
            if (node.shadowRoot) roots.push(node.shadowRoot);
            if (node.hasAttribute('data-owtomate-private-auth')) boxes.push(node.getBoundingClientRect());
          }
          const walker = document.createTreeWalker(roots[i], NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const text = walker.currentNode;
            if (text.parentElement?.closest('script,style')) continue;
            for (const value of values) {
              for (let start = text.textContent?.indexOf(value) ?? -1; start >= 0; start = text.textContent!.indexOf(value, start + value.length)) {
                const range = document.createRange();
                range.setStart(text, start); range.setEnd(text, start + value.length);
                boxes.push(...range.getClientRects());
              }
            }
          }
          const style = document.createElement('style');
          style.setAttribute('data-owtomate-private-mask', key);
          style.textContent = '[data-owtomate-private-auth]{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}';
          (roots[i] instanceof Document ? document.head || document.documentElement : roots[i]).appendChild(style);
        }
        const layer = document.createElement('div');
        layer.setAttribute('data-owtomate-private-mask', key);
        layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
        for (const box of boxes) {
          if (!box.width || !box.height) continue;
          const mask = document.createElement('div');
          mask.style.cssText = `position:absolute;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;background:#222`;
          layer.appendChild(mask);
        }
        document.documentElement.appendChild(layer);
      }, { key: token, expiresAt: browserOperationExpiresAt(5000), values: privateValues });
    }
    return await work();
  } finally {
    await Promise.all(prepared.map(frame => browserCleanup('Remove private screenshot mask', () => frame.evaluate(key => {
      const roots: Array<Document | ShadowRoot> = [document];
      for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
        if (node.getAttribute('data-owtomate-private-mask') === key) node.remove();
      }
    }, token))));
  }
}
