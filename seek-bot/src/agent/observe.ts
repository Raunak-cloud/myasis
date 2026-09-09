import type { Page } from 'patchright';
import { extractFields } from '../dom.js';
import type { FormField } from '../types.js';

/**
 * Turns the live page into the compact, ref-addressed state the agent reasons
 * over.
 *
 * The refs are the whole safety story. The model never emits a CSS selector,
 * an XPath or a line of JavaScript — it can only name a ref that this module
 * just stamped onto a real, visible element. That makes "the agent decides how
 * to navigate" compatible with "the agent cannot touch anything we did not
 * offer it", which is what keeps the deterministic rails meaningful.
 */

export interface AgentAction {
  ref: string;
  /** Button/link text, or the aria-label when the control is icon-only. */
  text: string;
  role: 'button' | 'link' | 'file';
  disabled: boolean;
}

export interface Observation {
  url: string;
  title: string;
  actions: AgentAction[];
  fields: FormField[];
  /** Visible copy of the main region, truncated. */
  text: string;
  /** Base64 data URL, only when screenshots are enabled. */
  screenshot?: string;
}

const MAX_TEXT = 6_000;

/**
 * SEEK pads button labels with invisible formatting characters — the apply CTA
 * literally renders as "Apply⁠" (word joiner). Left in, they poison both
 * the model's reading of a label and any comparison we do against one.
 */
const clean = (s: string) => s.replace(/[​-‍⁠﻿ ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Collects actionable controls, including those inside open shadow roots.
 *
 * SEEK's design system and several ATS vendors render their real buttons in
 * web components, where a plain `querySelectorAll` sees nothing at all.
 */
async function collectActions(page: Page): Promise<AgentAction[]> {
  const raw = await page.evaluate(() => {
    /**
     * Iterative, and with no named inner functions, on purpose.
     *
     * esbuild (which tsx uses) wraps named functions in a `__name` helper that
     * does not exist inside the browser context, so a named arrow declared here
     * throws "__name is not defined" under `npm run dev` while working fine
     * from the compiled build. Keeping this loop nameless makes the agent
     * behave identically under both toolchains.
     */
    const all: Element[] = [];
    const roots: Array<Document | ShadowRoot> = [document];
    while (roots.length) {
      const root = roots.pop()!;
      for (const element of root.querySelectorAll('*')) {
        all.push(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }

    const results: Array<{ ref: string; text: string; role: string; disabled: boolean }> = [];
    let n = 0;

    for (const element of all) {
      const tag = element.tagName;
      const isButton = tag === 'BUTTON' || element.getAttribute('role') === 'button';
      const isLink = tag === 'A' && Boolean(element.getAttribute('href'));
      const isFile = tag === 'INPUT' && (element as HTMLInputElement).type === 'file';
      if (!isButton && !isLink && !isFile) continue;

      /**
       * Site chrome is never an action worth offering.
       *
       * Left in, the agent treats "Employer site" or "Job search" as a way
       * forward on a page whose form has not rendered yet — observed live,
       * clicking straight out of a perfectly good Quick Apply flow. It also
       * removes the trap apply.ts had to special-case by hand: SEEK's
       * persistent sidebar renders "Review and submit" on *every* step, which
       * shadows the real "Submit application" on the review page.
       */
      if (!isFile && element.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]')) {
        continue;
      }
      // A file input is deliberately allowed through invisible: sites almost
      // always hide the real input behind a styled label.
      if (!isFile) {
        const box = (element as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(element as HTMLElement);
        if (!(box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none')) continue;
      }

      const ref = `a${n++}`;
      element.setAttribute('data-agent-ref', ref);
      results.push({
        ref,
        text:
          (element as HTMLElement).innerText?.trim() ||
          element.getAttribute('aria-label') ||
          element.getAttribute('title') ||
          (isFile ? 'file upload' : ''),
        role: isFile ? 'file' : isButton ? 'button' : 'link',
        disabled:
          (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true',
      });
    }
    return results;
  });

  return raw
    .map((action) => ({ ...action, text: clean(action.text), role: action.role as AgentAction['role'] }))
    // Unlabelled controls are noise the model cannot act on meaningfully.
    .filter((action) => action.text || action.role === 'file')
    .slice(0, 60);
}

/**
 * Waits for the application itself to render, not merely for the page shell.
 *
 * `waitForInteractiveSurface` in browser.ts is satisfied by any visible button
 * anywhere — including SEEK's header avatar — so on a client-rendered apply
 * page it returns while the form is still empty. Observed live: the agent got a
 * bare shell, concluded there was nothing to apply to, and clicked "Employer
 * site". This looks specifically for content outside the site chrome.
 */
export async function waitForApplicationSurface(page: Page, timeout = 25_000): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        const CHROME = 'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]';
        const candidates = [...document.querySelectorAll('input, textarea, select, button, [role="button"]')];
        const meaningful = candidates.some((element) => {
          if (element.closest(CHROME)) return false;
          if (element instanceof HTMLInputElement && element.type === 'file') return true;
          const box = (element as HTMLElement).getBoundingClientRect();
          const style = getComputedStyle(element as HTMLElement);
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        if (meaningful) return true;
        // A finished application has no controls left, so success copy counts.
        return /application (has been |was )?(submitted|sent)|successfully applied|thanks for applying/i.test(
          document.body.innerText,
        );
      },
      { timeout, polling: 150 },
    )
    .then(() => true)
    .catch(() => false);
}

/**
 * True when an observation is the SPA shell rather than a real step.
 *
 * Not simply "no actions": SEEK's shell still renders a "Skip to content"
 * link, so an emptiness test that demanded zero actions never fired and the
 * agent went ahead and reasoned about a blank page.
 */
export function looksUnrendered(observation: Observation): boolean {
  return observation.fields.length === 0 && observation.actions.length < 2;
}

export interface ObserveOptions {
  /** celeris-1 accepts image input; a screenshot rescues visually-laid-out steps. */
  screenshot?: boolean;
}

export async function observe(page: Page, options: ObserveOptions = {}): Promise<Observation> {
  const [actions, fields] = await Promise.all([collectActions(page), extractFields(page)]);

  const text = await page
    .evaluate((limit) => {
      const region = document.querySelector('main, [role="main"], form') ?? document.body;
      return ((region as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
    }, MAX_TEXT)
    .catch(() => '');

  const observation: Observation = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    actions,
    fields,
    text: clean(text),
  };

  if (options.screenshot) {
    const shot = await page
      .screenshot({ type: 'jpeg', quality: 60, fullPage: false })
      .catch(() => null);
    if (shot) observation.screenshot = `data:image/jpeg;base64,${shot.toString('base64')}`;
  }

  return observation;
}

/**
 * The observation as the model sees it.
 *
 * Job-page copy is third-party text that has, in this corpus, contained live
 * prompt-injection attempts. It is fenced in <untrusted> exactly as gemini.ts
 * does, and the system prompt tells the model that fence outranks anything
 * inside it.
 */
export function renderObservation(observation: Observation): string {
  const actions = observation.actions
    .map((a) => `  ${a.ref}  [${a.role}]${a.disabled ? ' (disabled)' : ''}  ${a.text}`)
    .join('\n');
  const fields = observation.fields
    .map((f) => {
      const options = f.options?.length ? `  options=${JSON.stringify(f.options)}` : '';
      const value = f.currentValue ? `  current=${JSON.stringify(f.currentValue)}` : '';
      return `  ${f.ref}  [${f.kind}]${f.required ? ' (required)' : ''}  ${f.label}${options}${value}`;
    })
    .join('\n');

  return [
    `URL: ${observation.url}`,
    `TITLE: ${observation.title}`,
    '',
    `ACTIONS (${observation.actions.length}):`,
    actions || '  (none)',
    '',
    `FIELDS (${observation.fields.length}):`,
    fields || '  (none)',
    '',
    'PAGE TEXT:',
    '<untrusted role="page-content">',
    observation.text || '(empty)',
    '</untrusted>',
  ].join('\n');
}
