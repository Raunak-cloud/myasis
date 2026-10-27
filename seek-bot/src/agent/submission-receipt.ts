import type { Page } from 'patchright';

export const normaliseReceiptText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The agent chooses the quote; it must assert completed application delivery. */
export function isApplicationReceipt(quote: string): boolean {
  const text = normaliseReceiptText(quote);
  if (text.length < 12 || /\b(?:not|never|unable|cannot|couldn['’]?t|could not|failed|unsuccessful(?:ly)?|please wait|loading|processing|submitting|once|when|if|will be|to submit|before submitting)\b/i.test(text)) return false;
  return /\bapplication\s+(?:(?:has|have)\s+been\s+|was\s+|is\s+)?(?:successfully\s+)?(?:submitted|received|sent|complete[d]?)\b|\b(?:received|submitted|sent)\s+(?:your|the)\s+application\b|\bthank\s+you\s+for\s+(?:applying|submitting\s+your\s+application)\b/i.test(text);
}

/** Fresh visible employer copy, including frames. Excludes hidden templates and
 * editable candidate answers. A URL, button state or paraphrase is not proof. */
export async function submissionReceipt(page: Page, quote: string): Promise<{ quote: string; url: string } | null> {
  quote = normaliseReceiptText(quote);
  if (!isApplicationReceipt(quote)) return null;
  for (const frame of page.frames()) {
    try {
      if (frame !== page.mainFrame() && !await (await frame.frameElement()).isVisible()) continue;
      const text = await frame.locator('body').evaluate(body => {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        const parts: string[] = [];
        while (walker.nextNode()) {
          const element = walker.currentNode.parentElement;
          if (!element || element.closest('script,style,textarea,input,[contenteditable]') || !element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
          parts.push(walker.currentNode.textContent || '');
        }
        return parts.join(' ').replace(/\s+/g, ' ').trim();
      }, undefined, { timeout: 2500 });
      let offset = text.indexOf(quote);
      while (offset >= 0) {
        // A truncated quote must not turn instructions or rejection positive.
        const start = Math.max(text.lastIndexOf('.', offset - 1) + 1, text.lastIndexOf('!', offset - 1) + 1, offset - 80, 0);
        const end = text.indexOf('.', offset + quote.length);
        const context = text.slice(start, end >= 0 ? Math.min(end + 1, offset + quote.length + 80) : offset + quote.length + 80);
        if (isApplicationReceipt(context)) return { quote, url: frame.url() };
        offset = text.indexOf(quote, offset + quote.length);
      }
    } catch { /* A detached/loading frame is not receipt evidence. */ }
  }
  return null;
}
