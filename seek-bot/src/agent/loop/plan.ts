import type { Page } from 'patchright';

// Part of the agent loop, split from loop.ts by concern; loop.ts re-exports it.

/**
 * Tools that read or move the view without acting on the form. They never
 * count towards "six actions with no effect"; the step and per-page budgets
 * still bound how long an agent may spend looking.
 */
export const LOOK_ONLY_TOOLS = new Set(['take_snapshot', 'take_screenshot', 'scroll', 'list_pages', 'get_diagnostics']);

/** Tools that can change an answer without the grounded answer path; what they set is checked as it lands. */
export const GENERAL_TOOLS = new Set(['evaluate_script', 'click_element', 'fill_element', 'type_text', 'press_key', 'click_point', 'drag']);

/** The most actions one plan may hold; a page needing more is planned again after the first batch. */
export const MAX_PLAN = 6;

/** A tool reporting that its step did not go as intended: the rest of a plan waits for a fresh look. */
export const SURPRISE = /\b(not accepted|could not|couldn't|refused|invalid refs?|do not advance|withheld|failed|no longer on the page|not filled yet|did not|no option matches|choose a current|choose the visible|give a ref|none of those refs|that point targets|use answer_questions|unavailable|not identified|is a site control|not run)\b/i;

/** Observation refs (a3, f12) a planned call names that are no longer on the page. Snapshot refs are left to their tool. */
export async function missingRefs(page: Page, args: Record<string, unknown>): Promise<string[]> {
  const named = [args.ref, args.field_ref, ...(Array.isArray(args.refs) ? args.refs : [])]
    .map((value) => String(value ?? '')).filter((ref) => /^[af]\d+$/.test(ref));
  if (!named.length) return [];
  return page.evaluate((refs) => refs.filter((ref) =>
    !document.querySelector(`[data-ref-id="${ref}"], [data-field-id="${ref}"]`)), named).catch(() => []);
}
