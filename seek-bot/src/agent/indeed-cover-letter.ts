import type { Locator, Page } from 'patchright';
import { assertBrowserOperationActive, browserDeadline } from '../browser-deadline.js';

export interface LetterShortcutResult {
  status: 'saved' | 'fallback';
  stage: string;
  completed: string[];
  reason: string;
  readback?: string;
}

const LETTER = /cover[\s-]*letter/i;
const SUPPORTING = /^supporting documents?$/i;
const WRITE = /^write (?:a |your )?cover letter$/i;
const SAVE = /^(?:save|save (?:and (?:continue|close)|cover letter)|done|add cover letter)$/i;
const words = (text: string) => text.replace(/\s+/g, ' ').trim();
const paragraphs = (text: string) => text.replace(/\r\n?/g, '\n').trim().split(/\n[\t ]*\n+/).map(words);

/** A deliberately small UI shortcut. It never drafts, uploads, submits an
 * application or interprets eligibility. Any unfamiliar/partial state returns
 * to the applying model, with the live page and completed work intact. */
export async function addIndeedCoverLetter(page: Page, text: string): Promise<LetterShortcutResult> {
  const completed: string[] = [];
  let stage = 'find editor';
  const fallback = (reason: string): LetterShortcutResult => ({ status: 'fallback', stage, completed, reason });
  // Unique visible locators only; never resolve ambiguity by taking the first.
  const unique = async (locator: Locator): Promise<Locator | undefined> => {
    const visible = locator.filter({ visible: true });
    return await visible.count() === 1 ? visible : undefined;
  };
  const click = async (locator: Locator) => {
    assertBrowserOperationActive();
    // Letter controls are never allowed to submit their enclosing application.
    if (!await locator.evaluate(node => !(node instanceof HTMLButtonElement && node.type === 'submit' && node.form), undefined, { timeout: 1500 })) {
      throw new Error('This control can submit a form; use normal browser tools to inspect it.');
    }
    assertBrowserOperationActive();
    await locator.click({ timeout: 2500 });
  };
  const editor = async () => unique(page.getByRole('textbox', { name: LETTER })
    .or(page.getByPlaceholder(LETTER)).and(page.locator('textarea, [contenteditable="true"], [role="textbox"]')));
  const writeControl = async () => unique(page.getByRole('button', { name: WRITE })
    .or(page.getByRole('radio', { name: WRITE })).or(page.getByRole('link', { name: WRITE })));
  try {
    if (!text.trim()) return fallback('No letter supplied. Draft the letter from candidate evidence before entering it.');
    return await browserDeadline('Indeed cover-letter shortcut', 12_000, async () => {
      let field = await editor();
      if (!field) {
        let write = await writeControl();
        if (!write) {
          stage = 'open supporting documents';
          let opener = await unique(page.getByRole('button', { name: SUPPORTING })
            .or(page.getByRole('link', { name: SUPPORTING })));
          if (!opener) {
            // Search only ancestors of the exact section heading. An unrelated
            // Add button elsewhere on the application must never be clicked.
            const heading = await unique(page.getByText(SUPPORTING, { exact: true }));
            if (heading) {
              let section = heading;
              for (let level = 0; level < 4; level++) {
                section = section.locator('..');
                if (/\b(?:resume|curriculum vitae)\b/i.test(await section.innerText({ timeout: 1500 }))) break;
                opener = await unique(section.getByRole('button', { name: /^(?:add|edit)$/i }));
                if (opener) break;
              }
            }
          }
          if (!opener) return fallback('No unique known Supporting documents control. Inspect the current page and choose the supported letter channel yourself.');
          await click(opener); completed.push('Opened Supporting documents');
          write = await writeControl();
          // The known flow can expose the editor directly.
          field = await editor();
        }
        if (!field) {
          stage = 'choose write a cover letter';
          if (!write) return fallback('The document options differ from the known flow. Inspect them and continue with normal tools.');
          await click(write); completed.push('Chose Write a cover letter');
          field = await editor();
        }
      }
      stage = 'fill letter';
      if (!field) return fallback('No unique labelled cover-letter editor appeared. Inspect the current dialog and form.');
      assertBrowserOperationActive();
      await field.fill(text, { timeout: 2500 });
      const read = () => field!.evaluate(node => 'value' in node ? String(node.value) : (node as HTMLElement).innerText, undefined, { timeout: 1500 });
      const readback = await read();
      if (JSON.stringify(paragraphs(readback)) !== JSON.stringify(paragraphs(text))) return fallback('Editor readback differs from the supplied letter or its paragraph breaks. Inspect and repair it.');
      completed.push('Filled and read back the exact letter');
      stage = 'save letter';
      // Save only inside the actual letter editor's dialog or local container.
      // Never click Continue or an application-level Send/Submit control.
      let container = field;
      let save: Locator | undefined;
      for (let level = 0; level < 5; level++) {
        container = container.locator('..');
        if (await container.evaluate(node => node.matches('body,main,form'), undefined, { timeout: 1500 })) break;
        save = await unique(container.getByRole('button', { name: SAVE }));
        if (save) break;
      }
      if (!save) return fallback('The exact text is in the editor, but no unique local Save control was found. Continue from this filled editor and verify persistence yourself.');
      await click(save); completed.push('Clicked the letter editor Save control');
      stage = 'read saved letter';
      // A successful fill is not a saved letter. Require the editor to close
      // and the actual complete text to appear on the review surface.
      await field.waitFor({ state: 'hidden', timeout: 2500 });
      const retained = page.getByText(text, { exact: true }).filter({ visible: true });
      await retained.waitFor({ state: 'visible', timeout: 2500 });
      const saved = await retained.innerText({ timeout: 1500 });
      if (JSON.stringify(paragraphs(saved)) !== JSON.stringify(paragraphs(text))) return fallback('The review readback differs from the letter. Inspect the saved document before continuing.');
      completed.push('Read the complete saved letter on the review page');
      return { status: 'saved', stage, completed, readback: saved, reason: 'Exact letter retained on the current review page. This is not an application submission or employer receipt.' };
    });
  } catch (error) {
    return fallback(`${(error as Error).message} No action is retried. Inspect the live page and finish with normal browser tools; preserve work already completed.`);
  }
}
