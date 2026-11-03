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
        const controls = 'script,style,noscript,template,button,input,textarea,select,[role="button"],[role="option"],[role="combobox"],[role="progressbar"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],[role="searchbox"],[role="slider"],[role="spinbutton"],[role="listbox"],[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[data-owtomate-private-auth]';
        const messages = new Set<string>();
        // Keep the browser callback self-contained under both tsc and tsx.
        // Named inner functions can acquire a Node-only esbuild __name helper.
        const roots: Array<Element | ShadowRoot> = [body];
        for (let index=0;index<roots.length;index++) {
        const root=roots[index];
        for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
        const regions = [...(root instanceof Element ? [root] : []), ...root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,[role="status"],[role="alert"],div,section,main,article,li,td,th')];
        for (const region of regions) {
          let ancestor: Element | null = region, excluded = false;
          while (ancestor) {
            const style = getComputedStyle(ancestor);
            if (ancestor.matches(controls) || style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) { excluded = true; break; }
            const ancestorRoot = ancestor.getRootNode();
            ancestor = ancestor.parentElement || (ancestorRoot instanceof ShadowRoot ? ancestorRoot.host : null);
          }
          if (excluded) continue;
          const parts: string[] = [];
          const nodes: Array<{ node: Node; exit?: boolean }> = [{ node: region }];
          while (nodes.length) {
            const { node, exit } = nodes.pop()!;
            if (exit) { parts.push('\n'); continue; }
            if (node.nodeType === Node.TEXT_NODE) {
              const textRoot = node.getRootNode();
              const element = node.parentElement || (textRoot instanceof ShadowRoot ? textRoot.host : null);
              if (element && getComputedStyle(element).visibility === 'visible') parts.push(node.textContent || '');
              continue;
            }
            if (!(node instanceof Element)) continue;
            const style = getComputedStyle(node);
            // An excluded control is a boundary, not removable wording that
            // could join two fragments into a different employer assertion.
            if (node.matches(controls) || style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) { parts.push('\u0000'); continue; }
            if (node.tagName === 'BR') { parts.push('\n'); continue; }
            // DOM text nodes concatenate without invented inline spaces.
            // Rendered block and table boundaries contribute line breaks.
            // display:contents has no box, but its visible text still counts.
            const block = !['inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents'].includes(style.display);
            if (block) { parts.push('\n'); nodes.push({ node, exit: true }); }
            const assigned = node instanceof HTMLSlotElement ? node.assignedNodes({ flatten: true }) : [];
            const children = assigned.length ? assigned : node.shadowRoot ? [...node.shadowRoot.childNodes] : [...node.childNodes];
            for (let child=children.length-1;child>=0;child--) nodes.push({ node: children[child] });
          }
          for (const segment of parts.join('').split('\u0000')) {
            const text = segment.replace(/\s+/g, ' ').trim();
            if (text) {
              messages.add(text);
              // A whole sentence cannot drop its own qualifying prefix/suffix.
              for (const sentence of text.split(/(?<=[.!?])\s+/)) messages.add(sentence);
            }
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
