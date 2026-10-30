import type { Page } from 'patchright';

const normaliseEmployerText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Magnus judges meaning. Code grounds its complete quoted message in fresh,
 * visible employer copy, without a vocabulary of success phrases.
 * Control states and candidate-authored text cannot establish employer facts.
 * Receipt and newly discovered duplicate judgements share the same evidence
 * boundary, including visible employer frames and open shadow roots. */
export async function employerMessageEvidence(page: Page, quote: string): Promise<{ quote: string; url: string } | null> {
  quote = normaliseEmployerText(quote);
  if (quote.length < 12) return null;
  for (const frame of page.frames()) {
    try {
      if (frame !== page.mainFrame() && !await (await frame.frameElement()).isVisible()) continue;
      const messages = await frame.locator('body').evaluate(body => {
        const controls = 'script,style,button,input,textarea,select,[role="button"],[role="option"],[role="combobox"],[role="progressbar"],[contenteditable="true"],[contenteditable=""]';
        const messages = new Set<string>();
        const controlAncestor = (element: Element): boolean => {
          let current: Element | null = element;
          while (current) {
            if (current.matches(controls)) return true;
            const root = current.getRootNode();
            current = current.parentElement || (root instanceof ShadowRoot ? root.host : null);
          }
          return false;
        };
        const roots: Array<Element | ShadowRoot> = [body];
        for (let index=0;index<roots.length;index++) {
        const root=roots[index];
        for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
        const regions = [...(root instanceof Element ? [root] : []), ...root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,[role="status"],[role="alert"],div,section,main,article')];
        for (const region of regions) {
          if (controlAncestor(region) || !region.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
          const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
          const parts: string[] = [];
          while (walker.nextNode()) {
            const element = walker.currentNode.parentElement;
            if (!element || controlAncestor(element) || !element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
            parts.push(walker.currentNode.textContent || '');
          }
          const text = parts.join(' ').replace(/\s+/g, ' ').trim();
          if (text) {
            messages.add(text);
            // A whole sentence cannot drop its own qualifying prefix/suffix.
            for (const sentence of text.split(/(?<=[.!?])\s+/)) messages.add(sentence);
          }
        }
        }
        return [...messages];
      }, undefined, { timeout: 2500 });
      if (messages.includes(quote)) return { quote, url: frame.url() };
    } catch { /* A detached/loading frame cannot establish employer evidence. */ }
  }
  return null;
}
