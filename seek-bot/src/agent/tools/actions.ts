import type { Page } from 'patchright';
import { captureInteractivePageState, jitter, waitForInteractivePageChange, waitForInteractiveSurface } from '../../browser.js';
import { isForbiddenDestination } from '../guards.js';
import { isAustralianGovernmentUrl } from '../../site-policy.js';
import { locate, pressWatched } from '../raw-tools.js';
import { ToolResult, ToolContext, ok } from './context.js';
import { gateAdvance } from './gate.js';

// Part of the agent's tools, split from tools.ts by concern; tools.ts re-exports it.

/**
 * Clicks a stamped ref.
 *
 * Patchright's CSS engine pierces open shadow roots, so the locator handles
 * SEEK's web components and gets real actionability checks. The JS fallback
 * covers controls a locator refuses to click — most often one sitting under an
 * open dialog.
 */
export async function clickRef(page: Page, ref: string): Promise<boolean> {
  const locator = page.locator(`[data-ref-id="${ref}"]`).first();
  const clicked = await locator
    .click({ timeout: 6_000 })
    .then(() => true)
    .catch(() => false);
  if (clicked) return true;

  /**
   * Covered by another element: click where the control is drawn, as a
   * person's mouse would. Workday lays a transparent "click_filter" over its
   * Sign In and Reset Password buttons and listens there, so a DOM click on
   * the button underneath did nothing and the sign-in never happened (CBA).
   */
  const box = await locator.boundingBox({ timeout: 2_000 }).catch(() => null);
  if (box && box.width > 0 && box.height > 0) {
    const before = await captureInteractivePageState(page).catch(() => null);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    if (!before || await waitForInteractivePageChange(page, before, 2_500).catch(() => false)) return true;
  }

  return page
    .evaluate((wanted) => {
      // Nameless and iterative — see the note in observe.ts: a named inner
      // function here throws "__name is not defined" under tsx.
      const roots: Array<Document | ShadowRoot> = [document];
      while (roots.length) {
        const root = roots.pop()!;
        for (const element of root.querySelectorAll('*')) {
          if (element.getAttribute('data-ref-id') === wanted && element instanceof HTMLElement) {
            element.click();
            return true;
          }
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      }
      return false;
    }, ref)
    .catch(() => false);
}

export async function doClick(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = String(args.ref ?? '');
  const action = ctx.observation.actions.find((candidate) => candidate.ref === ref);
  if (!action) {
    // Observed live: the model reached for a FIELD ref here, then floundered.
    // Point it at the right tool instead of just refusing.
    if (/^f\d+$/.test(ref)) {
      return ok(
        `"${ref}" is a FIELD, not a clickable action. Fields are not clicked: use answer_questions for employer ` +
          `questions, attach_resume for a resume step, or add_cover_letter for a cover letter. ACTIONS use "a" refs.`,
      );
    }
    return ok(`No action "${ref}" exists on this page. Choose a ref from the current ACTIONS list.`);
  }
  if (action.role === 'option') return ok('Use choose_option with an option ref so the selected value is grounded in the candidate profile. Direct option clicks are refused.');
  if (action.disabled) {
    return ok(
      `"${action.text}" is disabled — the step is not satisfied yet. Answer the remaining required fields first.`,
    );
  }

  const gate = await gateAdvance(ctx, action.text, action.context, { role: action.role });
  if (!gate.proceed) return gate.result;
  const { submit } = gate;
  // A list opened from a button has no FIELD; its caption is the question its options answer.
  if (/\(opens a list\)$/.test(action.text) || /^Open /.test(action.text)) {
    ctx.lastListQuestion = action.text.replace(/\s*\(opens a list\)$/, '').replace(/^(Open|Select)\s+/i, '').trim();
  }
  if (action.role === 'link') {
    const href = await ctx.page
      .locator(`[data-ref-id="${ref}"]`)
      .first()
      .getAttribute('href')
      .catch(() => null);
    if (href) {
      const destination = new URL(href, ctx.page.url()).href;
      if (isAustralianGovernmentUrl(destination)) {
        return {
          kind: 'terminal',
          outcome: { status: 'skipped', reason: 'Australian government application sites are excluded.' },
        };
      }
      if (isForbiddenDestination(destination)) {
        return ok(`Refused: "${action.text}" leads to ${destination}, which this tool never navigates to.`);
      }
    }
  }

  const before = await captureInteractivePageState(ctx.page);
  if (!(await clickRef(ctx.page, ref))) {
    return ok(`Could not click "${action.text}". It may be covered by a dialog — try closing that first.`);
  }
  const changed = await waitForInteractivePageChange(ctx.page, before);
  await waitForInteractiveSurface(ctx.page, 4_000);

  return ok(
    changed
      ? `Clicked "${action.text}". The page changed; a fresh observation follows.`
      : submit
        ? `Clicked "${action.text}". The page shows no confirmation yet. A form that refuses to submit almost always shows a validation message beside an incomplete required field, often near the top: check what happened below, scroll up if needed, and fix the field it names before trying again.`
        : `Clicked "${action.text}".`,
  );
}

export async function doScroll(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const direction = args.direction === 'up' ? -1 : 1;
  await ctx.page.evaluate((sign) => window.scrollBy(0, sign * Math.round(window.innerHeight * 0.8)), direction);
  await jitter(300, 700);
  return ok(`Scrolled ${direction === 1 ? 'down' : 'up'}.`);
}

/**
 * A click by coordinates, for the rare control no ref reaches. The same
 * rails as a ref click apply: the element under the point is inspected
 * first, so a submit still passes `canSubmit` and a forbidden link is still
 * refused. celeris-1 places these on a 0-1000 grid to within a few pixels.
 */
export async function doClickPoint(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.observation.screenshot) return ok('click_point is only available while a screenshot is in front of you. Use click with a ref.');
  const gx = Number(args.x);
  const gy = Number(args.y);
  if (!(gx >= 0 && gx <= 1000 && gy >= 0 && gy <= 1000)) return ok('x and y must be numbers on the 0-1000 grid.');
  const size = await ctx.page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => ({ width: 1280, height: 800 }));
  const x = (gx / 1000) * size.width;
  const y = (gy / 1000) * size.height;
  const under = await ctx.page
    .evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        if (!element) return null;
        const clickable = element.closest('a, button, [role], label, input, select, textarea') ?? element;
        const label = element.closest('label') as HTMLLabelElement | null;
        const field = element.closest('[data-field-id]') ?? label?.control ?? clickable.querySelector('[data-field-id]');
        const link = clickable.closest('a[href]');
        return {
          tag: clickable.tagName,
          actionRef: (element.closest('[data-ref-id]') ?? clickable.closest('[data-ref-id]'))?.getAttribute('data-ref-id') ?? null,
          fieldRef: field?.getAttribute('data-field-id') ?? null,
          formControl: clickable.matches('input, select, textarea, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="switch"]')
            || Boolean(clickable.matches('label') && (clickable as HTMLLabelElement).control)
            || Boolean(clickable.querySelector('input, select, textarea, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="switch"]')),
          text: ((clickable as HTMLElement).innerText || (clickable instanceof HTMLInputElement ? clickable.value : '') || clickable.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          href: link ? (link as HTMLAnchorElement).href : null,
        };
      },
      { x, y },
    )
    .catch(() => null);
  if (!under) return ok('Nothing is under that point. Re-observe and try a ref or a different point.');
  const pointedAction = under.actionRef ? ctx.observation.actions.find(action => action.ref === under.actionRef) : undefined;
  if (pointedAction?.role === 'option') return ok('That point targets a dropdown option. Use choose_option so the choice is grounded in the candidate profile; coordinate bypasses are refused.');
  const pointedField = under.fieldRef ? ctx.observation.fields.find((field) => field.ref === under.fieldRef) : undefined;
  const siteControl = Boolean(pointedField && ctx.guards.siteControls.has(pointedField.label));
  if ((under.fieldRef || under.formControl) && !siteControl) return ok(`That point targets ${under.fieldRef ? `FIELD ${under.fieldRef}` : 'a form control'}. Use its grounded field tool; for a required terms checkbox use accept_terms (with its ref, or the same screenshot x/y). Coordinates cannot bypass answer verification.`);
  if (under.href && isAustralianGovernmentUrl(under.href)) {
    return {
      kind: 'terminal',
      outcome: { status: 'skipped', reason: 'Australian government application sites are excluded.' },
    };
  }
  if (under.href && isForbiddenDestination(under.href)) {
    return ok(`Refused: that point is a link to ${under.href}, which this tool never navigates to.`);
  }
  const gate = await gateAdvance(ctx, under.text);
  if (!gate.proceed) return gate.result;
  const before = await captureInteractivePageState(ctx.page);
  await ctx.page.mouse.click(x, y);
  const changed = await waitForInteractivePageChange(ctx.page, before);
  await waitForInteractiveSurface(ctx.page, 4_000);
  return ok(
    `Clicked at (${gx},${gy}) on <${under.tag.toLowerCase()}> "${under.text}". ` +
      (changed ? 'The page changed; a fresh observation follows.' : ''),
  );
}

export async function doPressKey(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const key = String(args.key ?? '').trim();
  // Modifiers joined with "+", then a named key or one character — "Control+A" was refused before: the pattern had no "+" and no single capital.
  if (!/^(?:(?:Control|Shift|Alt|Meta|ControlOrMeta)\+)*(?:[A-Z][A-Za-z0-9]*|[a-z0-9]|Space| )$/.test(key)) {
    return ok('Unsupported key. Use a key name such as ArrowDown, Enter, Escape, Tab or Backspace, a single character, or a combination such as Control+A.');
  }
  if (typeof args.ref === 'string' && args.ref) {
    const target = locate(ctx.page, args.ref);
    const focused = target && await target.focus({ timeout: 3_000 }).then(() => true).catch(() => false);
    if (!focused) return ok(`${args.ref} could not be focused. Re-observe and use a current ref.`);
  }
  return pressWatched(ctx, key, async () => {
    const before = await captureInteractivePageState(ctx.page);
    await ctx.page.keyboard.press(key);
    const changed = await waitForInteractivePageChange(ctx.page, before, 2_500);
    return ok(`Pressed ${key}.${changed ? ' The page changed; a fresh observation follows.' : ''}`);
  });
}
