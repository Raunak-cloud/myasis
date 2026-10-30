import type { Frame, Page } from 'patchright';
import { browserDeadline, assertBrowserOperationActive } from '../browser-deadline.js';
import { extractFields } from '../dom.js';
import type { FormField } from '../types.js';
import { registerObservedFrame } from './browser-target.js';
import { recordDiagnostic } from './attempt-diagnostics.js';

/**
 * Turns the live page into the compact, ref-addressed state the agent reasons
 * over.
 *
 * Refs keep common actions compact. The applying agent may also choose a
 * standard browser locator or inspect the DOM directly from page evidence.
 * Observations describe controls and saved state; they do not choose answers
 * or prescribe a widget-specific filling sequence.
 */

interface AgentAction {
  ref: string;
  /** Button/link text, or the aria-label when the control is icon-only. */
  text: string;
  /** Nearby section copy for otherwise ambiguous controls such as "Add". */
  context?: string;
  /**
   * `option` is an entry in an open dropdown or menu; `toggle` is a styled
   * checkbox, radio or switch that is not a native input. Both are clicked
   * like buttons — they exist so custom widgets can be driven step by step
   * (open it, look, choose) instead of by widget-specific code.
   */
  role: 'button' | 'link' | 'file' | 'option' | 'toggle';
  disabled: boolean;
  /** DOM accessibility state; the agent still chooses the actual control. */
  ariaHidden?: boolean;
  /** Grounded context for a currently open custom dropdown option. */
  question?: string;
  value?: string;
  /** Originating observed field identity, independent of the popup's label text. */
  fieldRef?: string;
  multiSelect?: boolean;
  selected?: boolean;
}

export interface Observation {
  /** Transport failure, never evidence of an empty form or changed values. */
  inspectionError?: string;
  /** Larger visible surface for local transition comparison, never model context. */
  surfaceText?: string;
  /** Visible modal layer can block controls underneath it. Untrusted page copy. */
  dialogs?: string[];
  url: string;
  title: string;
  actions: AgentAction[];
  fields: FormField[];
  /** Visible copy of the main region, truncated. */
  text: string;
  /** Base64 data URL, only when screenshots are enabled. */
  screenshot?: string;
  frames?: Array<{ ref: string; parent?: string; url: string; name: string; fields: number; actions: number; error?: string }>;
  /** Main-document copy for the offline corpus, which does not serialize remote frames. */
  mainDocumentText?: string;
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
async function collectActions(page: Page | Frame): Promise<AgentAction[]> {
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

    for (const element of all) element.removeAttribute('data-ref-id');
    const results: Array<{ ref: string; text: string; role: string; disabled: boolean; question?: string; value?: string; fieldRef?: string; context?: string }> = [];
    let n = 0;
    const composedText = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes({ flatten: true });
        return (assigned.length ? assigned : [...node.childNodes]).map(composedText).join(' ');
      }
      return [...node.childNodes].map(composedText).join(' ').replace(/\s+/g, ' ').trim();
    };
    const questionFor = (control: Element): string => {
      const root = control.getRootNode() as Document | ShadowRoot;
      const labelled = (control.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/).filter(Boolean)
        .map(id => root.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim() ?? '')
        .filter(Boolean).join(' ');
      if (labelled) return labelled;
      // The control's own label beats its section's: a fieldset titled
      // "Employer" holds Country, Industry and Reason for leaving lists.
      const own = [...((control as HTMLInputElement).labels ?? [])].map(label => label.textContent?.trim()).filter(Boolean).join(' ')
        || control.getAttribute('aria-label') || '';
      if (own) return own.replace(/\s+/g, ' ').trim();
      for (let depth = 0, row = control.parentElement; row && depth < 4; depth++, row = row.parentElement) {
        if (row.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"], [aria-haspopup]').length > 1) break;
        const caption = row.querySelector('label, legend, [class*="label" i]')?.textContent?.replace(/\s+/g, ' ').trim();
        if (caption) return caption;
      }
      const group = control.closest('[data-automation-id="formField"], fieldset, [role="group"], [class*="formField"], [class*="form-field"]');
      if (!group) return '';
      return (group.querySelector('legend, [data-automation-id="formLabel"], label')?.textContent ?? '')
        .replace(/\s+/g, ' ').trim();
    };
    const expanded = all.filter(element =>
      element.getAttribute('aria-expanded') === 'true' && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));

    for (const element of all) {
      const tag = element.tagName;
      const role = element.getAttribute('role') ?? '';
      const isLink = tag === 'A' && Boolean(element.getAttribute('href'));
      const isFile = tag === 'INPUT' && (element as HTMLInputElement).type === 'file';
      /**
       * Custom widgets. Dropdown entries, menu items and tabs; styled
       * checkboxes/radios/switches; a combobox that is not an input (Ant
       * Design, React-Select and friends render a div you click to open);
       * a label wrapping a hidden native checkbox, which is how most "I agree"
       * boxes are built. Each becomes a plain click for the agent.
       */
      const isOption = /^(option|menuitem|menuitemradio|menuitemcheckbox|tab|treeitem)$/.test(role);
      const isToggle =
        /^(checkbox|radio|switch)$/.test(role) ||
        (tag === 'LABEL' && Boolean(element.querySelector('input[type="checkbox"], input[type="radio"]')) &&
          !(element.querySelector('input') as HTMLElement | null)?.offsetWidth);
      const isOpener = tag !== 'INPUT' && tag !== 'SELECT' && (role === 'combobox' || element.hasAttribute('aria-haspopup')) && !isOption;
      const isInputButton = tag === 'INPUT' && /^(submit|button)$/.test((element as HTMLInputElement).type);
      const isButton = tag === 'BUTTON' || isInputButton || role === 'button' || tag === 'SUMMARY' || isOpener;
      if (!isButton && !isLink && !isFile && !isOption && !isToggle) continue;
      // A styled toggle's inner input is already represented by its label.
      if (isToggle && tag === 'INPUT') continue;

      // Landmark placement does not decide whether a control matters: employer
      // wizards can put their real Next/Submit controls in a footer or navigation.
      // Expose visible controls and let the model choose using the current page.
      // A file input is deliberately allowed through invisible: sites almost
      // always hide the real input behind a styled label.
      if (!isFile) {
        if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const box = (element as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(element as HTMLElement);
        if (!(box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none')) continue;
      }

      const ref = `a${n++}`;
      element.setAttribute('data-ref-id', ref);
      const state =
        isToggle
          ? (element.getAttribute('aria-checked') === 'true' || Boolean((element.querySelector('input') as HTMLInputElement | null)?.checked) ? ' [checked]' : ' [unchecked]')
          : isOption && element.getAttribute('aria-selected') === 'true'
            ? ' [selected]'
            : isOpener
              ? ' (opens a list)'
              // A Yes/No answer drawn as a pair of toggle buttons (Oracle Recruiting): which one is pressed is the answer.
              // Without it a click that worked read as "nothing changed" and the agent was stopped as stuck.
              : element.getAttribute('aria-pressed') === 'true'
                ? ' [pressed]'
                : element.getAttribute('aria-pressed') === 'false'
                  ? ' [not pressed]'
                  : '';
      let fileLabel = '';
      if (isFile) {
        const input = element as HTMLInputElement;
        const root = input.getRootNode() as Document | ShadowRoot;
        const explicitLabel = input.id ? root.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent?.trim() ?? '' : '';
        const labelledBy = (input.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
        let context = '';
        let ancestor: HTMLElement | null = input.parentElement;
        for (let depth = 0; ancestor && depth < 3; depth++, ancestor = ancestor.parentElement) {
          const text = ancestor.innerText?.trim() ?? '';
          if (text.length > context.length && text.length < 300) context = text;
        }
        const name = input.getAttribute('aria-label') || explicitLabel || labelledBy || context || 'file upload';
        fileLabel = input.accept ? `${name} (accepts ${input.accept})` : name;
      }
      let label =
        (element as HTMLElement).innerText?.trim() ||
        (isInputButton ? (element as HTMLInputElement).value : '') ||
        composedText(element) ||
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.getAttribute('placeholder') ||
        fileLabel;
      const value = label;
      const owners = isOption ? expanded.filter(control =>
        `${control.getAttribute('aria-controls') ?? ''} ${control.getAttribute('aria-owns') ?? ''}`.split(/\s+/).filter(Boolean)
          .some(id => (control.getRootNode() as Document | ShadowRoot).querySelector(`#${CSS.escape(id)}`)?.contains(element))
        || Boolean(control.closest('[role="combobox"]')?.contains(element))) : [];
      // An expanded picker does not own every option on the page. Persistent
      // selected chips in another widget must retain their own identity.
      const grouped = element.closest('[role="listbox"], [role="combobox"]');
      const origin = owners.length === 1 ? owners[0] : isOption && !grouped && expanded.length === 1 ? expanded[0] : null;
      if (isOption && grouped && !origin && element.getAttribute('aria-selected') === 'true') continue;
      const question = isOption ? (origin ? questionFor(origin) : '') : isOpener ? questionFor(element) : '';
      const originFields = origin ? [origin, ...origin.querySelectorAll('[data-field-id]')].filter(node => node.hasAttribute('data-field-id')) : [];
      const fieldRef = originFields.length === 1 ? originFields[0].getAttribute('data-field-id') : null;
      if (question && !label.toLowerCase().includes(question.toLowerCase())) label = `${question}: ${label}`;
      // Icon-only controls often sit beside their labelled input (for
      // example a custom dropdown arrow). Expose that observed association
      // instead of dropping the only control that can open the widget.
      if (!label && isButton) {
        // Custom dropdowns keep a hidden native <select> beside the visible
        // box, so only visible inputs count when deciding which field this
        // button belongs to; the hidden one still lends its label.
        const nameOf = (input: Element) =>
          [...((input as HTMLInputElement).labels ?? [])].map(item => item.textContent?.trim()).filter(Boolean).join(' ')
          || input.getAttribute('aria-label') || input.getAttribute('title') || input.getAttribute('placeholder') || '';
        let parent = element.parentElement;
        for (let depth = 0; parent && depth < 4 && !label; depth++, parent = parent.parentElement) {
          const inputs = [...parent.querySelectorAll('input:not([type="hidden"]), select, textarea')];
          const visible = inputs.filter(input => input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
          if (visible.length > 1) break;
          if (!inputs.length) continue;
          const associated = [...visible, ...inputs].map(nameOf).find(Boolean);
          if (associated) label = `Open ${associated}`;
        }
        // Still nameless: the field's own caption, i.e. the short text of the
        // smallest container around it (a form row reads "State / Territory *").
        for (let depth = 0, row = element.parentElement; row && depth < 5 && !label; depth++, row = row.parentElement) {
          const caption = row.innerText?.replace(/\s+/g, ' ').trim() ?? '';
          if (caption.length > 150) break;
          if (caption) label = `Open ${caption}`;
        }
      }
      // Generic reveal controls are meaningful only in their section. Indeed's
      // review page, for example, calls its cover-letter control merely "Add"
      // and can place the explanatory text beyond the truncated page summary.
      // Capture the smallest useful local region, stopping before a whole long
      // form is duplicated into every action.
      let context = '';
      if (/^\+?\s*(?:add|attach|include|upload)\s*$/i.test(label)) {
        // A real button can live in a shadow root while its semantic name is
        // on a host several composed ancestors away. parentElement alone
        // loses that identity and makes distinct Add controls look alike.
        const semantic: string[] = [];
        let composed: Element | null = element;
        for (let depth = 0; composed && depth < 12; depth++) {
          const scope = composed.getRootNode() as Document | ShadowRoot;
          const namedBy = (composed.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
            .map(id => scope.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim() ?? '').filter(Boolean).join(' ');
          const name = (composed.getAttribute('aria-label') || namedBy).replace(/\s+/g, ' ').trim();
          if (name && name !== label && name.length <= 300 && !semantic.includes(name)) semantic.push(name);
          const parent: Element | null = composed.parentElement;
          composed = parent ?? (scope instanceof ShadowRoot ? scope.host : null);
        }
        let ancestor = element.parentElement;
        for (let depth = 0; ancestor && depth < 7; depth++, ancestor = ancestor.parentElement) {
          const nearby = ancestor.innerText?.replace(/\s+/g, ' ').trim() ?? '';
          if (nearby.length > context.length && nearby.length <= 1_200) context = nearby;
        }

        // Component libraries often give the heading, reveal button and body
        // separate wrappers whose first common ancestor is the entire form.
        // In that layout ancestor text is either just "Add" or far too large.
        // Read the semantic section instead: the nearest preceding heading and
        // all text up to the next heading. This is layout-independent and also
        // works when the section is below the viewport.
        const root = element.getRootNode() as Document | ShadowRoot;
        const headingNodes = [...root.querySelectorAll('h1, h2, h3, h4, [role="heading"]')];
        const heading = headingNodes
          .filter(candidate => Boolean(candidate.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
          .at(-1);
        if (heading) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
          walker.currentNode = heading;
          const parts: string[] = [];
          let size = 0;
          while (size < 1_200) {
            const node = walker.nextNode();
            if (!node) break;
            if (node instanceof Element && node !== heading && /^(H[1-4])$/.test(node.tagName)) break;
            if (node instanceof Element && node !== heading && node.getAttribute('role') === 'heading') break;
            if (node.nodeType !== Node.TEXT_NODE) continue;
            const piece = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (!piece) continue;
            parts.push(piece);
            size += piece.length + 1;
          }
          const section = parts.join(' ').slice(0, 1_200);
          if (section.length > context.length || /cover[\s-]?letter|supporting documents?/i.test(section)) context = section;
        }
        if (semantic.length) context = [...semantic.slice(0, 3), context].filter(Boolean).join(' › ').slice(0, 1_200);
      }
      results.push({
        ref,
        text: label + state,
        role: isFile ? 'file' : isOption ? 'option' : isToggle ? 'toggle' : isButton ? 'button' : 'link',
        ...(question ? { question } : {}),
        ...(isOption ? { value } : {}),
        ...(isOption && fieldRef ? { fieldRef } : {}),
        ...(isOption && grouped?.getAttribute('aria-multiselectable') === 'true'
          ? { multiSelect: true, selected: element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-checked') === 'true' } : {}),
        ...(context && context !== label ? { context } : {}),
        ...(element.getAttribute('aria-hidden') === 'true' ? { ariaHidden: true } : {}),
        disabled:
          (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true',
      });
    }
    return results;
  });

  return raw
    .map((action) => ({
      ...action,
      text: clean(action.text),
      ...(action.question ? { question: clean(action.question) } : {}),
      ...(action.value !== undefined ? { value: clean(action.value) } : {}),
      ...(action.context ? { context: clean(action.context).slice(0, 1_200) } : {}),
      role: action.role as AgentAction['role'],
    }))
    // Unlabelled controls are noise the model cannot act on meaningfully.
    .filter((action) => action.text || action.role === 'file')
    .slice(0, 120);
}

/**
 * Draws each ref as a small numbered tag on its element, so a screenshot
 * shows the same ids the text observation uses — the model can point at what
 * it sees without guessing coordinates. Removed right after the screenshot.
 */
async function withMarks<T>(page: Page, work: () => Promise<T>): Promise<T> {
  await page
    .evaluate(() => {
      const layer = document.createElement('div');
      layer.id = '__agent_marks';
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      for (const attr of ['data-ref-id', 'data-field-id']) {
        for (const element of document.querySelectorAll(`[${attr}]`)) {
          const ref = element.getAttribute(attr) ?? '';
          if (!/^[af]\d+$/.test(ref)) continue;
          const box = element.getBoundingClientRect();
          if (!(box.width > 0 && box.height > 0) || box.bottom < 0 || box.top > innerHeight) continue;
          const tag = document.createElement('div');
          tag.textContent = ref;
          const isField = attr === 'data-field-id';
          tag.style.cssText =
            `position:fixed;left:${Math.max(0, box.left - 2)}px;top:${Math.max(0, box.top - 9)}px;` +
            `background:${isField ? '#1d4ed8' : '#b91c1c'};color:#fff;font:bold 10px/1 monospace;padding:2px 3px;` +
            'border-radius:3px;box-shadow:0 0 0 1px #fff';
          layer.appendChild(tag);
          const outline = document.createElement('div');
          outline.style.cssText =
            `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;` +
            `outline:1.5px solid ${isField ? '#1d4ed8' : '#b91c1c'};outline-offset:-1px`;
          layer.appendChild(outline);
        }
      }
      document.body.appendChild(layer);
    })
    .catch(() => {});
  try {
    return await work();
  } finally {
    await page.evaluate(() => document.getElementById('__agent_marks')?.remove()).catch(() => {});
  }
}

/**
 * Waits for the application itself to render, not merely for the page shell.
 *
 * Header controls alone do not establish a rendered application form.
 * This waits for application content outside the site chrome.
 */
export async function waitForApplicationSurface(page: Page, timeout = 25_000): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        const CHROME = 'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]';
        const visible = (element: Element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible);
        const fields = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')].some(element => !element.closest(CHROME) && visible(element));
        // A loading shell can have cookie/navigation buttons. They do not make
        // the application ready for a paid reasoning turn.
        if (busy && !fields) return false;
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
      undefined,
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
  return observation.fields.length === 0 && observation.actions.length < 2
    && (observation.text.trim().length < 15 || /^(?:loading|please wait)[.\s…]*$/i.test(observation.text.trim()));
}

interface ObserveOptions {
  /** celeris-1 accepts image input; a screenshot rescues visually-laid-out steps. */
  screenshot?: boolean;
}

export async function observe(page: Page, options: ObserveOptions = {}): Promise<Observation> {
  for (let attempt = 0; ; attempt++) {
    try { return await browserDeadline('Browser observation', 15_000, () => observeOnce(page, options)); }
    catch (error) {
      recordDiagnostic({ severity: 'warning', category: 'observation_error', stage: 'observation',
        retry: attempt + 1, message: error instanceof Error ? error.message : String(error), error });
      if (attempt >= 2 || !/Execution context was destroyed|Cannot find context with specified id/i.test(String(error))) throw error;
      // Only retry observation, never replay an action or submit click.
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    }
  }
}

async function validationErrors(scope: Page | Frame): Promise<Record<string, string>> {
  return scope.evaluate(() => {
    const errors: Record<string, string> = {};
    const roots: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const element of roots[i].querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        const ref = element.getAttribute('data-field-id')?.split(':')[0];
        if (!ref) continue;
        const input = element as HTMLInputElement;
        if (element.getAttribute('aria-invalid') !== 'true' && !input.validationMessage) continue;
        const ids = `${element.getAttribute('aria-errormessage') ?? ''} ${element.getAttribute('aria-describedby') ?? ''}`.split(/\s+/).filter(Boolean);
        const messages = ids.map(id => roots[i].querySelector(`#${CSS.escape(id)}`)?.textContent?.trim()).filter(Boolean);
        errors[ref] = (messages.join(' ') || input.validationMessage || 'The page marks this field invalid.').slice(0, 1000);
      }
    }
    return errors;
  });
}

async function surfaceText(scope: Page | Frame): Promise<string> {
  return scope.evaluate(() => {
    const region = document.querySelector('main, [role="main"], form') ?? document.body;
    return ((region as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60_000);
  }).catch(() => '');
}

async function observeOnce(page: Page, options: ObserveOptions): Promise<Observation> {
  // Stamp current field identities before associating popup actions with them.
  // These observations are dependent; parallel stamping could read stale refs.
  const fields = await extractFields(page);
  assertBrowserOperationActive();
  const actions = await collectActions(page);
  assertBrowserOperationActive();
  const errors = await validationErrors(page);
  assertBrowserOperationActive();
  for (const field of fields) field.validationError = errors[field.ref];
  const mainText = await surfaceText(page);
  const texts = [mainText];
  const frames: NonNullable<Observation['frames']> = [];
  // Embedded employer forms are first-class browser contexts. Reading them
  // through their native Frame avoids cross-origin document scripting and
  // makes real in-frame changes visible to recovery and progress accounting.
  for (const frame of page.frames().filter(frame => frame !== page.mainFrame()).slice(0, 20)) {
    assertBrowserOperationActive();
    if (/recaptcha|hcaptcha|turnstile|challenges.cloudflare|arkoselabs|funcaptcha/i.test(frame.url())) continue;
    let visible = true;
    try {
      for (let current: Frame | null = frame; current?.parentFrame(); current = current.parentFrame()) {
        const host = await current.frameElement();
        try { if (!await host.isVisible()) { visible = false; break; } }
        finally { await host.dispose(); }
      }
    } catch { visible = false; }
    if (!visible) continue;
    const ref = registerObservedFrame(page, frame);
    let url = frame.url();
    try { const parsed = new URL(url); if (/^https?:$/.test(parsed.protocol)) url = parsed.origin + parsed.pathname; } catch { /* Blank/srcdoc frame. */ }
    const parent = frame.parentFrame();
    const context = `Frame ${url} ${frame.name()}`.trim();
    try {
      const nestedFields = await extractFields(frame);
      const nestedActions = await collectActions(frame);
      const nestedErrors = await validationErrors(frame);
      fields.push(...nestedFields.map(field => ({ ...field, ref: `${ref}:${field.ref}`,
        section: `${context}${field.section ? `: ${field.section}` : ''}`,
        controlIdentity: `${context}:${field.controlIdentity ?? field.ref}`,
        validationError: nestedErrors[field.ref] })));
      actions.push(...nestedActions.map(action => ({ ...action, ref: `${ref}:${action.ref}`,
        ...(action.fieldRef ? { fieldRef: `${ref}:${action.fieldRef}` } : {}),
        context: `${context}${action.context ? `: ${action.context}` : ''}` })));
      texts.push(`${context}\n${await surfaceText(frame)}`);
      frames.push({ ref, ...(parent && parent !== page.mainFrame() ? { parent: registerObservedFrame(page, parent) } : {}),
        url, name: frame.name(), fields: nestedFields.length, actions: nestedActions.length });
    } catch {
      // A removed/navigating child is missing evidence, not permission to choose
      // a replacement frame or discard the rest of the current observation.
      frames.push({ ref, url, name: frame.name(), fields: 0, actions: 0, error: 'Frame changed while reading; inspect its fresh state.' });
    }
  }
  const text = texts.map(text => clean(text).slice(0, MAX_TEXT)).join('\n\n');

  const observation: Observation = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    actions,
    fields,
    text: text.slice(0, 20_000),
    surfaceText: clean(text).replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '[clock]'),
    ...(frames.length ? { frames } : {}),
    ...(frames.length ? { mainDocumentText: clean(mainText).slice(0, MAX_TEXT) } : {}),
    dialogs: await page.locator('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]').evaluateAll(nodes => nodes.filter(node => node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))
      .map(node => (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 4000)).filter((text, index, all) => Boolean(text) && all.indexOf(text) === index)).catch(() => []),
  };

  if (options.screenshot) {
    const shot = await withMarks(page, () =>
      page.screenshot({ type: 'jpeg', quality: 60, fullPage: false }).catch(error => {
        recordDiagnostic({ severity: 'warning', category: 'screenshot_error', stage: 'observation', message: 'Application screenshot failed.', error });
        return null;
      }),
    );
    if (shot) observation.screenshot = `data:image/jpeg;base64,${shot.toString('base64')}`;
  }

  return observation;
}

/**
 * The observation as the model sees it.
 *
 * Job-page copy is third-party text that has, in this corpus, contained live
 * prompt-injection attempts. It is fenced in <untrusted> exactly as llm.ts
 * does, and the system prompt tells the model that fence outranks anything
 * inside it.
 */
export function renderObservation(observation: Observation): string {
  const actions = observation.actions
    .map((a) => `  ${a.ref}  [${a.role}]${a.disabled ? ' (disabled)' : ''}${a.ariaHidden ? ' (aria-hidden=true)' : ''}${a.fieldRef ? ` field=${a.fieldRef}` : ''}${a.multiSelect ? ` multi-select=true selected=${a.selected}` : ''}  ${a.text}${a.role === 'option' && a.value !== undefined ? `  raw_option_text=${JSON.stringify(a.value)}${a.question ? ` question_context=${JSON.stringify(a.question)}` : ''}` : ''}${a.context ? `  context=${JSON.stringify(a.context)}` : ''}`)
    .join('\n');
  const fields = observation.fields
    .map((f) => {
      const options = f.options?.length ? `  options=${JSON.stringify(f.options)}` : '';
      const value = f.currentValue !== undefined ? `  current=${JSON.stringify(f.currentValue)}` : '';
      const error = f.validationError ? `  validation=${JSON.stringify(f.validationError)}` : '';
      const control = [f.inputType && `input=${f.inputType}`, f.readOnly && 'read-only', f.disabled && 'disabled', f.autocomplete && 'autocomplete: inspect the current widget before choosing an interaction',
        f.sensitive && 'private credential: use authentication tools'].filter(Boolean).join('; ');
      const description = f.description ? `  description=${JSON.stringify(f.description)}` : '';
      const hints = f.hints ? `  hints=${JSON.stringify(f.hints)}` : '';
      return `  ${f.ref}  [${f.kind}]${f.required ? ' (required)' : ''}  ${f.section ? `${f.section} › ` : ''}${f.label}${control ? `  control=${JSON.stringify(control)}` : ''}${description}${hints}${options}${value}${error}`;
    })
    .join('\n');

  return [
    `URL: ${observation.url}`,
    `TITLE: ${observation.title}`,
    ...(observation.frames?.length ? ['EMBEDDED FRAMES (native contexts; refs stay bound to their observed frame):',
      '<untrusted role="page-content">', JSON.stringify(observation.frames), '</untrusted>',
      'Use a scoped field/action ref such as frame1:f0, or locator.frame="frame1". Parent-document scripts do not read cross-origin frame documents.'] : []),
    ...(observation.dialogs?.length ? ['VISIBLE DIALOG LAYER (may block controls underneath):', '<untrusted role="page-content">', ...observation.dialogs, '</untrusted>'] : []),
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
