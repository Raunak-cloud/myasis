import type { Locator, Page } from 'patchright';

/** Resolve afresh for every operation. Never retain an ElementHandle across a rerender. */
export function locate(page: Page, ref: string): Locator | null {
  if (/^a\d+$/.test(ref)) return page.locator(`[data-ref-id="${ref}"]`);
  if (/^f\d+(?::\d+)?$/.test(ref)) return page.locator(`[data-field-id="${ref}"]`);
  if (/^(?:f\d+)?e\d+$/.test(ref)) return page.locator(`aria-ref=${ref}`);
  return null;
}

/** Standard Playwright locators, selected by the agent, without widget recipes. */
export const browserTargetProperties = {
  ref: { type: 'string' },
  selector: { type: 'string' },
  locator: {
    type: 'object', additionalProperties: false,
    description: 'Direct Playwright locator. Uses exact matching by default and requires a unique element. Scope repeated controls with within (CSS), frame (iframe CSS), or an explicitly chosen zero-based index. Takes precedence over selector/ref.',
    properties: {
      by: { type: 'string', enum: ['role', 'label', 'placeholder', 'text', 'test_id', 'css'] },
      value: { type: 'string', minLength: 1 },
      name: { type: 'string', description: 'Accessible name when by=role.' },
      exact: { type: 'boolean' },
      within: { type: 'string', minLength: 1, description: 'CSS selector for the containing section in the selected frame.' },
      frame: { type: 'string', minLength: 1, description: 'CSS selector for the iframe containing this control.' },
      index: { type: 'integer', minimum: 0 },
    },
    required: ['by', 'value'],
  },
};

export function hasBrowserTarget(args: Record<string, unknown>): boolean {
  return Boolean(args.locator || args.selector || args.ref);
}

export function browserTarget(page: Page, args: Record<string, unknown>): Locator {
  if (args.locator) {
    const spec = args.locator as { by: string; value: string; name?: string; exact?: boolean; within?: string; frame?: string; index?: number };
    const frame = spec.frame ? page.frameLocator(spec.frame) : page;
    const scope = spec.within ? frame.locator(spec.within) : frame;
    const exact = spec.exact ?? true;
    let result: Locator;
    switch (spec.by) {
      case 'role': result = scope.getByRole(spec.value as Parameters<Page['getByRole']>[0], { name: spec.name, exact }); break;
      case 'label': result = scope.getByLabel(spec.value, { exact }); break;
      case 'placeholder': result = scope.getByPlaceholder(spec.value, { exact }); break;
      case 'text': result = scope.getByText(spec.value, { exact }); break;
      case 'test_id': result = scope.getByTestId(spec.value); break;
      case 'css': result = scope.locator(spec.value); break;
      default: throw new Error('Choose a standard Playwright locator: role, label, placeholder, text, test_id or css.');
    }
    // Playwright strictness exposes ambiguity to the agent instead of silently
    // choosing a potentially different answer/control. An index is explicit.
    return spec.index === undefined ? result : result.nth(spec.index);
  }
  if (args.selector) return page.locator(String(args.selector));
  const ref = String(args.ref ?? '');
  const found = locate(page, ref);
  if (!found) throw new Error('Use an observed ref, CSS selector or Playwright locator for this element.');
  return found;
}
